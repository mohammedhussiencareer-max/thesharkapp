-- Order deduction engine (phase 5, PR 4).
--
-- Deductions stay dormant: every entry point returns not_activated until a
-- row exists in app.inventory_activation, and this migration writes none. The
-- activation RPC, screen, and the post_movements restriction ship in PR 9.
--
-- What this adds: a work queue over the immutable POS inputs from PR 3, a
-- resolver over immutable snapshots that shares one expansion implementation
-- with the public order resolver, the single-order coordinator that retires
-- and re-posts an order atomically, a bounded worker, a failure recorder for
-- failures that escape the worker, rederive spans recorded by triggers on the
-- dated configuration tables, and wake-ups for missing_cost_basis blockers.
--
-- Replaced functions, each from its latest definition (behavior unchanged,
-- proven by the existing resolver tests and the equivalence tests here):
--   app.resolve_line_requirements_exact(text,text)
--                                        base 20261106000000_pos_mapping.sql
--   app.packaging_line_recipe_paths(text,text)
--                                        base 20261107000000_packaging_order_requirements.sql
--   app.resolve_order_requirements_exact(text,integer)
--                                        base 20261107000000_packaging_order_requirements.sql
--   app.resolve_order_requirements(text,integer)
--                                        base 20261107000000_packaging_order_requirements.sql
-- Each keeps its signature, owner, and privileges. The first three now read
-- the mirror and call a shared core that takes the line data as arguments.
-- The core bodies are the old bodies with only the mirror reads replaced.
-- ============================================================================
-- 0. Lock order. The ledger advisory lock is first, then the tables that get
-- triggers or are read by the backfill, NOWAIT, in a fixed order.
--
-- Ingest at runtime does not take this advisory lock. A running sync can hold
-- row locks on pos_cost_inputs while this migration already holds the ledger
-- lock. NOWAIT fails the migration with 55P03 instead of holding the ledger
-- lock until the sync commits.
-- ============================================================================
select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

do $lock_tables$
begin
  lock table app.stock_movements,
  app.item_loss_versions,
  app.item_conversion_versions,
  app.recipe_versions,
  app.pos_map_versions,
  app.packaging_versions,
  app.item_opening_prices,
  app.pos_order_snapshots,
  app.pos_cost_inputs in share row exclusive mode nowait;
end;
$lock_tables$;

-- Keyset enumeration of orders by occurrence for rederive spans.
create index pos_order_snapshots_ordered_at_idx on app.pos_order_snapshots (ordered_at, order_id);

-- ============================================================================
-- 1. Activation. A singleton, append-only. No API writer exists in this PR.
-- ============================================================================
create table app.inventory_activation (
  id smallint primary key default 1 check (id = 1),
  stock_started_at timestamptz not null check (pg_catalog.isfinite (stock_started_at)),
  approved_by uuid null references auth.users (id) on delete restrict,
  approved_at timestamptz not null default pg_catalog.clock_timestamp (),
  request_id uuid not null unique,
  opening_manifest_hash text not null check (opening_manifest_hash ~ '^[0-9a-f]{32}$')
);

comment on table app.inventory_activation is 'Singleton, append-only. The first row turns order deductions on and fixes the stock start instant. No API role can write it; PR 9 ships the owner RPC. Empty means every accounting worker call returns not_activated.';

-- ============================================================================
-- 2. Rederive spans. Triggers on the dated version tables record them. The
-- worker expands each span into work events by keyset. Only the progress
-- columns (cursor, count, completed_at) may change.
-- ============================================================================
create table app.accounting_rederive_spans (
  id bigint generated always as identity primary key,
  family text not null check (
    family in (
      'loss',
      'conversion',
      'recipe',
      'pos_map',
      'packaging'
    )
  ),
  version_id uuid not null,
  cause text not null check (cause in ('insert', 'supersede')),
  change_id bigint not null references app.costing_changes (id) on delete restrict,
  effective_from timestamptz not null check (pg_catalog.isfinite (effective_from)),
  effective_to timestamptz null,
  cursor_ordered_at timestamptz null,
  cursor_order_id text null,
  orders_enqueued bigint not null default 0 check (orders_enqueued >= 0),
  completed_at timestamptz null,
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint accounting_rederive_spans_effective_to_chk check (
    effective_to is null
    or (
      pg_catalog.isfinite (effective_to)
      and effective_to > effective_from
    )
  ),
  constraint accounting_rederive_spans_cursor_chk check (
    (cursor_ordered_at is null) = (cursor_order_id is null)
  ),
  constraint accounting_rederive_spans_version_cause_key unique (family, version_id, cause)
);

comment on table app.accounting_rederive_spans is 'One row per dated configuration interval that changed: a version inserted (its new interval) or superseded (its old interval, attributed to the superseding change). Recorded by triggers, never resolved by them. The worker expands a span into per-order work events, 100 orders per call, ordered by (ordered_at, order id).';

create index accounting_rederive_spans_open_idx on app.accounting_rederive_spans (id)
where
  completed_at is null;

create function app.trg_rederive_spans_guard () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if new.id is distinct from old.id
  or new.family is distinct from old.family
  or new.version_id is distinct from old.version_id
  or new.cause is distinct from old.cause
  or new.change_id is distinct from old.change_id
  or new.effective_from is distinct from old.effective_from
  or new.effective_to is distinct from old.effective_to
  or new.created_at is distinct from old.created_at then
    raise exception 'app.accounting_rederive_spans identity columns are immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function app.trg_rederive_spans_guard ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_accounting_rederive_spans_guard
before update on app.accounting_rederive_spans for each row
execute function app.trg_rederive_spans_guard ();

create trigger trg_accounting_rederive_spans_no_delete
before delete on app.accounting_rederive_spans for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_accounting_rederive_spans_no_truncate
before truncate on app.accounting_rederive_spans for each statement
execute function app.prevent_append_only_mutation ();

-- ============================================================================
-- 3. Work events, work state, attempts.
-- An event is appended by a trigger or by the worker and is never resolved
-- in place. The worker claims unclaimed events into a work generation and
-- later marks them processed. Only work_generation and processed_at change.
-- ============================================================================
create table app.accounting_work_events (
  id bigint generated always as identity primary key,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  cause text not null check (
    cause in (
      'pos_input',
      'config_span',
      'cost_basis',
      'decision',
      'activation'
    )
  ),
  source_key text not null,
  cost_input_id bigint null references app.pos_cost_inputs (id) on delete restrict,
  span_id bigint null references app.accounting_rederive_spans (id) on delete restrict,
  work_generation integer null check (work_generation >= 1),
  processed_at timestamptz null,
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint accounting_work_events_source_key_key unique (source_key)
);

comment on table app.accounting_work_events is 'Dirty events for one order: a new POS cost input, a rederive span, a cost-basis wake-up, a decision, or activation. source_key is stable, so a repeated enqueue is a no-op. work_generation is null until the worker claims the event. processed_at is set when the claiming generation completes.';

create index accounting_work_events_order_idx on app.accounting_work_events (order_id, id);

create index accounting_work_events_open_idx on app.accounting_work_events (order_id)
where
  processed_at is null;

create function app.trg_work_events_guard () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if new.id is distinct from old.id
  or new.order_id is distinct from old.order_id
  or new.cause is distinct from old.cause
  or new.source_key is distinct from old.source_key
  or new.cost_input_id is distinct from old.cost_input_id
  or new.span_id is distinct from old.span_id
  or new.created_at is distinct from old.created_at
  or (
    old.work_generation is not null
    and new.work_generation is distinct from old.work_generation
  )
  or (
    old.processed_at is not null
    and new.processed_at is distinct from old.processed_at
  ) then
    raise exception 'app.accounting_work_events identity columns are immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function app.trg_work_events_guard ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_accounting_work_events_guard
before update on app.accounting_work_events for each row
execute function app.trg_work_events_guard ();

create trigger trg_accounting_work_events_no_delete
before delete on app.accounting_work_events for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_accounting_work_events_no_truncate
before truncate on app.accounting_work_events for each statement
execute function app.prevent_append_only_mutation ();

create table app.accounting_work_state (
  order_id text primary key check (length(pg_catalog.btrim (order_id)) > 0),
  work_generation integer not null default 0 check (work_generation >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  failed_at timestamptz null,
  last_outcome text null check (
    last_outcome in (
      'applied',
      'unchanged',
      'incomplete',
      'none',
      'blocked',
      'disposition_pending'
    )
  ),
  last_reason text null,
  blocked_item_ids uuid[] not null default '{}'::uuid[],
  last_error_code text null,
  last_attempt_id uuid null,
  updated_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.accounting_work_state is 'Derived operational state per order, written only by the worker, the failure recorder and the retry RPC under the ledger lock. work_generation counts claims of new events. attempts is the number of failed attempts in the current generation; five set failed_at. A new unclaimed event opens a new generation even when failed_at is set. Sync never touches this table.';

create index accounting_work_state_blocked_idx on app.accounting_work_state using gin (blocked_item_ids)
where
  last_outcome = 'blocked';

create table app.accounting_work_attempts (
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  work_generation integer not null check (work_generation >= 1),
  attempt_id uuid not null,
  kind text not null check (kind in ('caught', 'escaped')),
  sqlstate text null check (
    sqlstate is null
    or sqlstate ~ '^[0-9A-Z]{5}$'
  ),
  reason text not null check (
    reason in ('error', 'recompute_limit', 'critical', 'escaped')
  ),
  recorded_at timestamptz not null default pg_catalog.clock_timestamp (),
  primary key (order_id, work_generation, attempt_id)
);

comment on table app.accounting_work_attempts is 'Append-only failed attempts, keyed by (order, work generation, attempt id). attempt_id is chosen by the caller before the worker call, so a retried failure report is a no-op. Only the SQLSTATE and a coarse reason are kept: no message, no names.';

-- ============================================================================
-- 4. Applications (immutable receipts), movement links, derived head.
-- ============================================================================
create table app.order_cost_applications (
  id bigint generated by default as identity primary key,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  cost_input_id bigint not null references app.pos_cost_inputs (id) on delete restrict,
  snapshot_id bigint not null references app.pos_order_snapshots (id) on delete restrict,
  receipt_kind text not null check (receipt_kind in ('posting', 'evaluation')),
  disposition text not null check (
    disposition in ('sale', 'prepared_waste', 'none', 'incomplete')
  ),
  predecessor_id bigint null references app.order_cost_applications (id) on delete restrict,
  retired_application_id bigint null references app.order_cost_applications (id) on delete restrict,
  movement_owner_id bigint null references app.order_cost_applications (id) on delete restrict,
  occurred_at timestamptz null check (
    occurred_at is null
    or pg_catalog.isfinite (occurred_at)
  ),
  shift_id text null,
  event_position bigint null,
  signature text not null check (signature ~ '^[0-9a-f]{32}$'),
  algorithm_version integer not null default 1,
  requirements jsonb null,
  exact_requirements jsonb null,
  provenance jsonb null,
  causes jsonb not null default '[]'::jsonb,
  retire_batch uuid null,
  posting_batch uuid null,
  reversal_movement_ids bigint[] not null default '{}'::bigint[],
  work_generation integer not null check (work_generation >= 1),
  attempt_id uuid null,
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint order_cost_applications_kind_chk check (
    receipt_kind = 'posting'
    or (
      retired_application_id is null
      and posting_batch is null
      and retire_batch is null
    )
  ),
  constraint order_cost_applications_sale_chk check (
    disposition <> 'sale'
    or (
      occurred_at is not null
      and shift_id is not null
      and requirements is not null
    )
  )
);

comment on table app.order_cost_applications is 'Immutable receipt of one evaluation of an order against one cost input. A posting receipt changed the economic state: it retired the previous application (every movement of retired_application_id has an exact reversal in reversal_movement_ids) and, for a sale, posted the replacement. An evaluation receipt records a re-evaluation with an identical economic signature and posted nothing. movement_owner_id is the application that owns the order''s live movements after this receipt, or null when there are none. An incomplete receipt means the current cost is unknown; earlier receipts stay as history.';

comment on column app.order_cost_applications.signature is 'md5 of disposition, occurrence instant, shift, final per-item quantities and the posting algorithm version. Equal signatures mean no stock effect.';

create index order_cost_applications_order_idx on app.order_cost_applications (order_id, id);

create index order_cost_applications_input_idx on app.order_cost_applications (cost_input_id);

create index order_cost_applications_snapshot_idx on app.order_cost_applications (snapshot_id);

create table app.order_cost_movement_links (
  movement_id bigint primary key references app.stock_movements (id) on delete restrict,
  application_id bigint not null references app.order_cost_applications (id) on delete restrict,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  item_id uuid not null references app.stock_items (id) on delete restrict,
  event_position bigint null,
  piece_position integer null
);

comment on table app.order_cost_movement_links is 'Membership of an engine movement in the application that posted it. A movement belongs to exactly one application. A normal and a provisional piece for one requirement are two rows.';

create index order_cost_movement_links_application_idx on app.order_cost_movement_links (application_id);

create index order_cost_movement_links_order_idx on app.order_cost_movement_links (order_id);

create table app.order_cost_state (
  order_id text primary key check (length(pg_catalog.btrim (order_id)) > 0),
  latest_input_id bigint null references app.pos_cost_inputs (id) on delete restrict,
  latest_application_id bigint null references app.order_cost_applications (id) on delete restrict,
  owner_application_id bigint null references app.order_cost_applications (id) on delete restrict,
  disposition text null check (
    disposition is null
    or disposition in ('sale', 'prepared_waste', 'none', 'incomplete')
  ),
  signature text null check (
    signature is null
    or signature ~ '^[0-9a-f]{32}$'
  ),
  causes jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz null,
  updated_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.order_cost_state is 'Derived per-order head, written only by the coordinator under the ledger lock. latest_application_id is the newest receipt, owner_application_id the application that owns the live movements. causes lists why the current cost is unknown, stale or waiting (missing_cost_basis, disposition_pending, incomplete requirements, open order).';

-- ============================================================================
-- 5. Append-only guards for the immutable tables.
-- ============================================================================
create trigger trg_inventory_activation_no_update_delete
before update or delete on app.inventory_activation for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_inventory_activation_no_truncate
before truncate on app.inventory_activation for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_accounting_work_attempts_no_update_delete
before update or delete on app.accounting_work_attempts for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_accounting_work_attempts_no_truncate
before truncate on app.accounting_work_attempts for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_order_cost_applications_no_update_delete
before update or delete on app.order_cost_applications for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_order_cost_applications_no_truncate
before truncate on app.order_cost_applications for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_order_cost_movement_links_no_update_delete
before update or delete on app.order_cost_movement_links for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_order_cost_movement_links_no_truncate
before truncate on app.order_cost_movement_links for each statement
execute function app.prevent_append_only_mutation ();

-- ============================================================================
-- 6. RLS and grants. Owner-only SELECT. No DML grant for any API role: the
-- writers are definer functions and the sync role never touches these tables
-- except through the cost-input trigger below.
-- ============================================================================
alter table app.inventory_activation enable row level security;

alter table app.accounting_rederive_spans enable row level security;

alter table app.accounting_work_events enable row level security;

alter table app.accounting_work_state enable row level security;

alter table app.accounting_work_attempts enable row level security;

alter table app.order_cost_applications enable row level security;

alter table app.order_cost_movement_links enable row level security;

alter table app.order_cost_state enable row level security;

create policy inventory_activation_select_owner on app.inventory_activation for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy accounting_rederive_spans_select_owner on app.accounting_rederive_spans for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy accounting_work_events_select_owner on app.accounting_work_events for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy accounting_work_state_select_owner on app.accounting_work_state for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy accounting_work_attempts_select_owner on app.accounting_work_attempts for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy order_cost_applications_select_owner on app.order_cost_applications for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy order_cost_movement_links_select_owner on app.order_cost_movement_links for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy order_cost_state_select_owner on app.order_cost_state for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.inventory_activation,
app.accounting_rederive_spans,
app.accounting_work_events,
app.accounting_work_state,
app.accounting_work_attempts,
app.order_cost_applications,
app.order_cost_movement_links,
app.order_cost_state
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.accounting_rederive_spans_id_seq,
app.accounting_work_events_id_seq,
app.order_cost_applications_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.inventory_activation,
  app.accounting_rederive_spans,
  app.accounting_work_events,
  app.accounting_work_state,
  app.accounting_work_attempts,
  app.order_cost_applications,
  app.order_cost_movement_links,
  app.order_cost_state to authenticated,
  service_role;

-- ============================================================================
-- 7. Triggers that only insert.
-- ============================================================================
create function app.trg_pos_cost_inputs_work_event () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  -- Runs inside ingest. It appends one event and takes no lock on the
  -- order-accounting heads and no ledger lock.
  insert into
    app.accounting_work_events (order_id, cause, source_key, cost_input_id)
  values
    (
      new.order_id,
      'pos_input',
      'input:' || new.id::text,
      new.id
    )
  on conflict (source_key) do nothing;

  return null;
end;
$$;

revoke all on function app.trg_pos_cost_inputs_work_event ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_pos_cost_inputs_work_event
after insert on app.pos_cost_inputs for each row
execute function app.trg_pos_cost_inputs_work_event ();

create function app.trg_record_rederive_span () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_family text := tg_argv[0];
begin
  if tg_op = 'INSERT' then
    if new.superseded_change_id is null then
      insert into
        app.accounting_rederive_spans (
          family,
          version_id,
          cause,
          change_id,
          effective_from,
          effective_to
        )
      values
        (
          v_family,
          new.id,
          'insert',
          new.created_change_id,
          new.effective_from,
          new.effective_to
        )
      on conflict (family, version_id, cause) do nothing;
    end if;
  elsif old.superseded_change_id is null
  and new.superseded_change_id is not null then
    insert into
      app.accounting_rederive_spans (
        family,
        version_id,
        cause,
        change_id,
        effective_from,
        effective_to
      )
    values
      (
        v_family,
        new.id,
        'supersede',
        new.superseded_change_id,
        old.effective_from,
        old.effective_to
      )
    on conflict (family, version_id, cause) do nothing;
  end if;

  return null;
end;
$$;

revoke all on function app.trg_record_rederive_span ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_item_loss_versions_rederive_ins
after insert on app.item_loss_versions for each row
execute function app.trg_record_rederive_span ('loss');

create trigger trg_item_loss_versions_rederive_upd
after update of superseded_change_id on app.item_loss_versions for each row
execute function app.trg_record_rederive_span ('loss');

create trigger trg_item_conversion_versions_rederive_ins
after insert on app.item_conversion_versions for each row
execute function app.trg_record_rederive_span ('conversion');

create trigger trg_item_conversion_versions_rederive_upd
after update of superseded_change_id on app.item_conversion_versions for each row
execute function app.trg_record_rederive_span ('conversion');

create trigger trg_recipe_versions_rederive_ins
after insert on app.recipe_versions for each row
execute function app.trg_record_rederive_span ('recipe');

create trigger trg_recipe_versions_rederive_upd
after update of superseded_change_id on app.recipe_versions for each row
execute function app.trg_record_rederive_span ('recipe');

create trigger trg_pos_map_versions_rederive_ins
after insert on app.pos_map_versions for each row
execute function app.trg_record_rederive_span ('pos_map');

create trigger trg_pos_map_versions_rederive_upd
after update of superseded_change_id on app.pos_map_versions for each row
execute function app.trg_record_rederive_span ('pos_map');

create trigger trg_packaging_versions_rederive_ins
after insert on app.packaging_versions for each row
execute function app.trg_record_rederive_span ('packaging');

create trigger trg_packaging_versions_rederive_upd
after update of superseded_change_id on app.packaging_versions for each row
execute function app.trg_record_rederive_span ('packaging');

create function app.trg_wake_cost_basis_blockers () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  -- Only events are inserted. Blocked orders are found through the state
  -- table without locking it, and the worker resolves them later.
  insert into
    app.accounting_work_events (order_id, cause, source_key)
  select
    state.order_id,
    'cost_basis',
    tg_argv[0] || ':' || new.id::text || ':' || state.order_id
  from
    app.accounting_work_state state
  where
    state.last_outcome = 'blocked'
    and state.last_reason = 'missing_cost_basis'
    and state.blocked_item_ids @> pg_catalog.array_fill(new.item_id, array[1])
  on conflict (source_key) do nothing;

  return null;
end;
$$;

revoke all on function app.trg_wake_cost_basis_blockers ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_item_opening_prices_wake_blockers
after insert on app.item_opening_prices for each row
execute function app.trg_wake_cost_basis_blockers ('price');

create trigger trg_stock_movements_wake_blockers
after insert on app.stock_movements for each row when (
  new.movement_type in (
    'opening'::app.movement_type,
    'purchase'::app.movement_type,
    'sort_in'::app.movement_type
  )
)
execute function app.trg_wake_cost_basis_blockers ('inflow');

-- Orders that already have a cost input get one event for the newest input.
insert into
  app.accounting_work_events (order_id, cause, source_key, cost_input_id)
select
  input.order_id,
  'pos_input',
  'input:' || input.id::text,
  input.id
from
  app.pos_cost_inputs input
where
  input.input_revision = (
    select
      max(newer.input_revision)
    from
      app.pos_cost_inputs newer
    where
      newer.order_id = input.order_id
  )
on conflict (source_key) do nothing;

-- ============================================================================
-- 8. Resolver over immutable snapshots. One expansion implementation.
-- The cores below are the previous bodies with only the mirror reads replaced
-- by arguments. The mirror wrappers keep the old names, signatures and errors.
-- ============================================================================
create function app.resolve_line_requirements_core (
  p_item text,
  p_name text,
  p_ordered timestamptz,
  p_qty numeric,
  p_weighted numeric,
  p_weighted_unit text,
  p_options jsonb,
  p_size_name text
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_name text;
  v_ordered timestamptz;
  v_qty numeric;
  v_weighted numeric;
  v_weighted_unit text;
  v_options jsonb;
  v_key jsonb;
  v_map_id uuid;
  v_map_kind text;
  v_map_recipe uuid;
  v_map_stock uuid;
  v_map_qty numeric;
  v_map_unit text;
  v_exc_id uuid;
  v_policy text;
  v_policy_id uuid;
  v_weighted_line boolean;
  v_scale_num numeric;
  v_scale_den numeric;
  v_unit_code text;
  v_ratio_num numeric;
  v_ratio_den numeric;
  v_stop boolean := false;
  v_base_state text;
  v_base_issues jsonb := '[]'::jsonb;
  v_option_issues jsonb := '[]'::jsonb;
  v_option_subjects jsonb := '[]'::jsonb;
  v_reqs jsonb := '[]'::jsonb;
  v_map_versions jsonb := '[]'::jsonb;
  v_recipe_versions jsonb := '[]'::jsonb;
  v_expanded jsonb;
  v_piece jsonb;
  v_elem jsonb;
  v_values text[] := '{}'::text[];
  v_unresolved integer := 0;
  v_once integer := 0;
  v_distinct integer := 0;
  v_dup boolean := false;
  v_opt record;
  v_status text;
  v_sorted jsonb;
begin
  v_item := p_item;
  v_name := p_name;
  v_ordered := p_ordered;
  v_qty := p_qty;
  v_weighted := p_weighted;
  v_weighted_unit := p_weighted_unit;
  v_options := p_options;
  v_key := app.pos_size_key (p_size_name);

  select
    v.id,
    v.target_kind,
    v.recipe_id,
    v.stock_item_id,
    v.quantity_per_basis,
    v.unit_code
  into v_map_id,
    v_map_kind,
    v_map_recipe,
    v_map_stock,
    v_map_qty,
    v_map_unit
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'mapping'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  select
    v.id
  into v_exc_id
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'exception'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  select
    v.id,
    v.option_policy
  into v_policy_id,
    v_policy
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'option_policy'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  if v_map_id is not null
  and v_exc_id is not null then
    v_base_state := 'blocked';
    v_base_issues := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'exception_overlap',
        'role',
        'base',
        'pos_item_id',
        v_item,
        'size_key',
        v_key
      )
    );
    v_map_versions := pg_catalog.jsonb_build_array(v_map_id, v_exc_id);
    v_stop := true;
    v_status := 'incomplete';
  elsif v_exc_id is not null then
    v_base_state := 'exception';
    v_map_versions := pg_catalog.jsonb_build_array(v_exc_id);
    v_stop := true;
    v_status := 'exception';
  end if;

  v_weighted_line := v_weighted is not null;

  if not v_stop then
    if v_weighted_line then
      v_unit_code := app.resolve_unit_code (v_weighted_unit);

      if v_unit_code is null then
        v_scale_num := null;
      else
        select
          r.ratio_num,
          r.ratio_den
        into v_ratio_num,
          v_ratio_den
        from
          app.recipe_unit_ratio (v_unit_code, 'kg') r;

        if not found then
          v_scale_num := null;
        else
          v_scale_num := v_weighted * v_ratio_num;
          v_scale_den := v_ratio_den;
        end if;
      end if;

      if v_scale_num is null then
        v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'weighted_unit_invalid',
            'role',
            'base',
            'pos_item_id',
            v_item,
            'size_key',
            v_key
          )
        );

        if v_map_id is not null then
          v_map_versions := v_map_versions || pg_catalog.jsonb_build_array(v_map_id);
        end if;

        v_stop := true;
        v_base_state := 'blocked';
      end if;
    else
      v_scale_num := v_qty;
      v_scale_den := 1;
    end if;
  end if;

  if not v_stop
  and v_map_id is null then
    v_base_state := 'gap';
    v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'unmapped_base',
        'role',
        'base',
        'pos_item_id',
        v_item,
        'size_key',
        v_key
      )
    );
  elsif not v_stop then
    v_map_versions := v_map_versions || pg_catalog.jsonb_build_array(v_map_id);
    v_expanded := app.pos_map_expand_target (
      v_map_kind,
      v_map_recipe,
      v_map_stock,
      v_map_qty,
      v_map_unit,
      v_ordered,
      v_weighted_line,
      'base',
      v_scale_num,
      v_scale_den
    );
    v_base_issues := v_base_issues || coalesce(v_expanded -> 'issues', '[]'::jsonb);
    v_recipe_versions := v_recipe_versions || coalesce(v_expanded -> 'recipe_versions', '[]'::jsonb);

    if pg_catalog.jsonb_array_length (coalesce(v_expanded -> 'issues', '[]'::jsonb)) = 0 then
      v_base_state := 'mapped';
      v_reqs := app.pos_map_merge_req (v_reqs, v_expanded -> 'requirements');
    else
      v_base_state := 'blocked';
    end if;
  end if;

  if v_stop
  and v_map_id is null
  and v_status is distinct from 'exception'
  and v_status is distinct from 'incomplete' then
    v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'unmapped_base',
        'role',
        'base',
        'pos_item_id',
        v_item,
        'size_key',
        v_key
      )
    );
  end if;

  if not v_stop then
    if v_policy_id is null then
      v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'option_policy_missing',
          'role',
          'base',
          'pos_item_id',
          v_item,
          'size_key',
          v_key
        )
      );
    else
      v_map_versions := v_map_versions || pg_catalog.jsonb_build_array(v_policy_id);
    end if;

    for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements (v_options) as e
    loop
      if pg_catalog.jsonb_typeof (v_elem) is distinct from 'object'
      or nullif(btrim(v_elem ->> 'value'), '') is null then
        v_unresolved := v_unresolved + 1;
      else
        v_values := pg_catalog.array_append(v_values, btrim(v_elem ->> 'value'));
      end if;
    end loop;

    select
      count(*) filter (
        where
          n = 1
      ),
      count(*),
      bool_or(n > 1)
    into v_once,
      v_distinct,
      v_dup
    from
      (
        select
          count(*) as n
        from
          pg_catalog.unnest (v_values) as u (val)
        group by
          val
      ) c;

    v_once := coalesce(v_once, 0);
    v_distinct := coalesce(v_distinct, 0);
    v_dup := coalesce(v_dup, false);

    if v_policy = 'none_expected' then
      if v_unresolved > 0
      or coalesce(pg_catalog.cardinality (v_values), 0) > 0 then
        v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'option_policy_violation',
            'role',
            'base',
            'policy',
            v_policy
          )
        );
      end if;
    elsif v_policy = 'exactly_one' then
      if v_once <> 1
      or v_unresolved > 0
      or v_dup then
        v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'option_policy_violation',
            'role',
            'base',
            'policy',
            v_policy
          )
        );
      end if;
    end if;

    if v_unresolved > 0
    and v_policy is distinct from 'none_expected' then
      v_option_issues := v_option_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'unresolved_option',
          'role',
          'option'
        )
      );
      v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'role',
          'option',
          'pos_item_id',
          v_item,
          'size_key',
          v_key,
          'state',
          'unresolved',
          'issues',
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'code',
              'unresolved_option',
              'role',
              'option'
            )
          )
        )
      );
    elsif v_unresolved > 0 then
      v_option_issues := v_option_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'unresolved_option',
          'role',
          'option'
        )
      );
    end if;

    for v_opt in
    select
      u.val,
      count(*) as n
    from
      pg_catalog.unnest (v_values) with ordinality as u (val, ord)
    group by
      u.val
    order by
      min(u.ord)
    loop
      if v_opt.n > 1 then
        v_option_issues := v_option_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'ambiguous_option',
            'role',
            'option',
            'option_value',
            v_opt.val
          )
        );
        v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'role',
            'option',
            'pos_item_id',
            v_item,
            'size_key',
            v_key,
            'option_value',
            v_opt.val,
            'state',
            'ambiguous',
            'issues',
            pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'code',
                'ambiguous_option',
                'role',
                'option',
                'option_value',
                v_opt.val
              )
            )
          )
        );
      elsif v_policy = 'none_expected' then
        v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'role',
            'option',
            'pos_item_id',
            v_item,
            'size_key',
            v_key,
            'option_value',
            v_opt.val,
            'state',
            'ignored',
            'issues',
            '[]'::jsonb
          )
        );
      else
        v_piece := app.pos_map_option_at (
          v_item,
          v_key,
          v_opt.val,
          v_ordered,
          v_weighted_line,
          v_scale_num,
          v_scale_den
        );
        v_option_issues := v_option_issues || coalesce(v_piece -> 'issues', '[]'::jsonb);
        v_recipe_versions := v_recipe_versions || coalesce(v_piece -> 'recipe_versions', '[]'::jsonb);

        if v_piece ->> 'mapping_version_id' is not null then
          v_map_versions := v_map_versions || pg_catalog.jsonb_build_array((v_piece ->> 'mapping_version_id')::uuid);
        end if;

        if pg_catalog.jsonb_array_length (coalesce(v_piece -> 'issues', '[]'::jsonb)) = 0
        and v_piece -> 'requirements' is not null
        and pg_catalog.jsonb_typeof (v_piece -> 'requirements') = 'array' then
          v_reqs := app.pos_map_merge_req (v_reqs, v_piece -> 'requirements');
        end if;

        v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(v_piece - 'requirements' - 'recipe_versions');
      end if;
    end loop;
  end if;

  if v_status is null then
    if pg_catalog.jsonb_array_length (v_base_issues || v_option_issues) > 0 then
      v_status := 'incomplete';
    else
      v_status := 'ready';
    end if;
  end if;

  if v_status = 'ready' then
    select
      coalesce(
        pg_catalog.jsonb_agg(
          e.value
          order by
            e.value ->> 'stock_item_id'
        ),
        '[]'::jsonb
      )
    into v_sorted
    from
      pg_catalog.jsonb_array_elements (v_reqs) as e;
  else
    v_sorted := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    v_status,
    'requirements',
    v_sorted,
    'subjects',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_strip_nulls (
        pg_catalog.jsonb_build_object(
          'role',
          'base',
          'pos_item_id',
          v_item,
          'size_key',
          v_key,
          'item_name',
          v_name,
          'state',
          v_base_state,
          'mapping_version_id',
          v_map_id,
          'policy',
          v_policy,
          'policy_version_id',
          v_policy_id,
          'issues',
          v_base_issues
        )
      )
    ) || v_option_subjects,
    'issues',
    v_base_issues || v_option_issues,
    'provenance',
    pg_catalog.jsonb_build_object(
      'at',
      app.costing_timestamptz_text (v_ordered),
      'algorithm_version',
      1,
      'mapping_versions',
      v_map_versions,
      'recipe_versions',
      v_recipe_versions
    )
  );
end;
$$;

comment on function app.resolve_line_requirements_core (
  text,
  text,
  timestamptz,
  numeric,
  numeric,
  text,
  jsonb,
  text
) is 'Internal line expansion over line data passed as arguments. Same body as the earlier mirror lookup. Revoked from API roles.';

revoke all on function app.resolve_line_requirements_core (
  text,
  text,
  timestamptz,
  numeric,
  numeric,
  text,
  jsonb,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.resolve_line_requirements_exact (p_order_id text, p_line_id text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_line record;
begin
  select
    l.item_id,
    l.item_name,
    o.ordered_at,
    l.quantity,
    l.weighted_qty,
    l.weighted_unit,
    l.options,
    l.size_name
  into v_line
  from
    app.pos_order_lines l
    join app.pos_orders o on o.id = l.order_id
  where
    l.order_id = p_order_id
    and l.line_id = p_line_id;

  if not found then
    raise exception 'unknown order line'
      using errcode = '22023';
  end if;

  return app.resolve_line_requirements_core (
    v_line.item_id,
    v_line.item_name,
    v_line.ordered_at,
    v_line.quantity,
    v_line.weighted_qty,
    v_line.weighted_unit,
    v_line.options,
    v_line.size_name
  );
end;
$$;

create function app.packaging_line_recipe_paths_core (
  p_line_id text,
  p_item text,
  p_ordered timestamptz,
  p_qty numeric,
  p_weighted numeric,
  p_weighted_unit text,
  p_options jsonb,
  p_size_name text
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_ordered timestamptz;
  v_qty numeric;
  v_weighted numeric;
  v_weighted_unit text;
  v_options jsonb;
  v_key jsonb;
  v_map_id uuid;
  v_map_kind text;
  v_map_recipe uuid;
  v_exc_id uuid;
  v_policy text;
  v_weighted_line boolean;
  v_scale_num numeric;
  v_scale_den numeric;
  v_unit_code text;
  v_ratio_num numeric;
  v_ratio_den numeric;
  v_stop boolean := false;
  v_paths jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_values text[] := '{}'::text[];
  v_opt record;
  v_opt_id uuid;
  v_opt_kind text;
  v_opt_recipe uuid;
begin
  v_item := p_item;
  v_ordered := p_ordered;
  v_qty := p_qty;
  v_weighted := p_weighted;
  v_weighted_unit := p_weighted_unit;
  v_options := p_options;
  v_key := app.pos_size_key (p_size_name);

  select
    v.id,
    v.target_kind,
    v.recipe_id
  into v_map_id,
    v_map_kind,
    v_map_recipe
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'mapping'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  select
    v.id
  into v_exc_id
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'exception'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  select
    v.option_policy
  into v_policy
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'option_policy'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  if v_exc_id is not null then
    return '[]'::jsonb;
  end if;

  v_weighted_line := v_weighted is not null;

  if v_weighted_line then
    v_unit_code := app.resolve_unit_code (v_weighted_unit);

    if v_unit_code is null then
      v_scale_num := null;
    else
      select
        r.ratio_num,
        r.ratio_den
      into v_ratio_num,
        v_ratio_den
      from
        app.recipe_unit_ratio (v_unit_code, 'kg') r;

      if not found then
        v_scale_num := null;
      else
        v_scale_num := v_weighted * v_ratio_num;
        v_scale_den := v_ratio_den;
      end if;
    end if;

    if v_scale_num is null then
      v_stop := true;
    end if;
  else
    v_scale_num := v_qty;
    v_scale_den := 1;
  end if;

  if v_stop then
    return '[]'::jsonb;
  end if;

  if v_map_id is not null then
    v_paths := v_paths || app.packaging_target_recipe_paths (
      v_map_kind,
      v_map_recipe,
      v_ordered,
      v_weighted_line,
      'base',
      v_scale_num,
      v_scale_den,
      p_line_id,
      v_item,
      v_key,
      null,
      v_map_id
    );
  end if;

  if v_policy = 'none_expected' then
    return v_paths;
  end if;

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements (coalesce(v_options, '[]'::jsonb)) as e
  loop
    if pg_catalog.jsonb_typeof (v_elem) = 'object'
    and nullif(btrim(v_elem ->> 'value'), '') is not null then
      v_values := pg_catalog.array_append(v_values, btrim(v_elem ->> 'value'));
    end if;
  end loop;

  for v_opt in
  select
    u.val,
    count(*) as n
  from
    pg_catalog.unnest (v_values) with ordinality as u (val, ord)
  group by
    u.val
  order by
    min(u.ord)
  loop
    if v_opt.n > 1 then
      continue;
    end if;

    v_opt_id := null;
    v_opt_kind := null;
    v_opt_recipe := null;

    select
      v.id,
      v.target_kind,
      v.recipe_id
    into v_opt_id,
      v_opt_kind,
      v_opt_recipe
    from
      app.pos_map_versions v
      join app.pos_map_subjects s on s.id = v.subject_id
    where
      s.kind = 'option'
      and s.option_scope = 'item'
      and s.pos_item_id = v_item
      and s.size_key = v_key
      and s.option_value = v_opt.val
      and v.family = 'mapping'
      and v.superseded_change_id is null
      and v.valid_during @> v_ordered
    limit
      1;

    if not found then
      select
        v.id,
        v.target_kind,
        v.recipe_id
      into v_opt_id,
        v_opt_kind,
        v_opt_recipe
      from
        app.pos_map_versions v
        join app.pos_map_subjects s on s.id = v.subject_id
      where
        s.kind = 'option'
        and s.option_scope = 'global'
        and s.option_value = v_opt.val
        and s.pos_item_id is null
        and s.size_key is null
        and v.family = 'mapping'
        and v.superseded_change_id is null
        and v.valid_during @> v_ordered
      limit
        1;

      if not found
      or v_opt_kind = 'unmapped' then
        continue;
      end if;
    end if;

    if v_opt_kind in ('unmapped', 'no_stock') then
      continue;
    end if;

    v_paths := v_paths || app.packaging_target_recipe_paths (
      v_opt_kind,
      v_opt_recipe,
      v_ordered,
      v_weighted_line,
      'option',
      v_scale_num,
      v_scale_den,
      p_line_id,
      v_item,
      v_key,
      v_opt.val,
      v_opt_id
    );
  end loop;

  return v_paths;
end;
$$;

comment on function app.packaging_line_recipe_paths_core (
  text,
  text,
  timestamptz,
  numeric,
  numeric,
  text,
  jsonb,
  text
) is 'Internal recipe expansion paths for one line passed as arguments. Same body as the earlier mirror lookup. Revoked from API roles.';

revoke all on function app.packaging_line_recipe_paths_core (
  text,
  text,
  timestamptz,
  numeric,
  numeric,
  text,
  jsonb,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.packaging_line_recipe_paths (p_order_id text, p_line_id text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_line record;
begin
  select
    l.item_id,
    o.ordered_at,
    l.quantity,
    l.weighted_qty,
    l.weighted_unit,
    l.options,
    l.size_name
  into v_line
  from
    app.pos_order_lines l
    join app.pos_orders o on o.id = l.order_id
  where
    l.order_id = p_order_id
    and l.line_id = p_line_id;

  if not found then
    return '[]'::jsonb;
  end if;

  return app.packaging_line_recipe_paths_core (
    p_line_id,
    v_line.item_id,
    v_line.ordered_at,
    v_line.quantity,
    v_line.weighted_qty,
    v_line.weighted_unit,
    v_line.options,
    v_line.size_name
  );
end;
$$;

create function app.resolve_order_requirements_core (
  p_status text,
  p_missing boolean,
  p_ordered timestamptz,
  p_order_type text,
  p_lines jsonb,
  p_preparation boolean
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_status text;
  v_missing boolean;
  v_ordered timestamptz;
  v_order_type text;
  v_cause text;
  v_key jsonb;
  v_exact jsonb;
  v_line record;
  v_weighted boolean;
  v_scale_ok boolean;
  v_scale_num numeric;
  v_scale_den numeric;
  v_kg jsonb;
  v_pack jsonb;
  v_reqs jsonb := '[]'::jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_paths jsonb := '[]'::jsonb;
  v_map_ids jsonb := '[]'::jsonb;
  v_recipe_ids jsonb := '[]'::jsonb;
  v_pack_ids jsonb := '[]'::jsonb;
  v_line_bad boolean := false;
  v_unreviewed boolean := false;
  v_blocked boolean := false;
  v_causes jsonb := '[]'::jsonb;
  v_order_pack jsonb;
  v_sorted jsonb;
begin
  v_status := p_status;
  v_missing := coalesce(p_missing, false);
  v_ordered := p_ordered;
  v_order_type := p_order_type;

  if not coalesce(p_preparation, false)
  and (
    v_missing
    or v_status <> 'complete'
  ) then
    v_cause := case
      when v_missing then 'missing'
      when v_status = 'canceled' then 'canceled'
      when v_status = 'active' then 'open'
      else v_status
    end;

    return pg_catalog.jsonb_build_object(
      'status',
      'sales_only',
      'cause',
      v_cause,
      'requirements',
      null,
      'lines',
      null,
      'order_packaging',
      null,
      'issues',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('code', v_cause, 'role', 'order')
      ),
      'causes',
      '[]'::jsonb,
      'provenance',
      pg_catalog.jsonb_build_object(
        'at',
        app.costing_timestamptz_text (v_ordered),
        'algorithm_version',
        1,
        'mapping_versions',
        '[]'::jsonb,
        'packaging_versions',
        '[]'::jsonb,
        'recipe_versions',
        '[]'::jsonb,
        'paths',
        '[]'::jsonb
      )
    );
  end if;

  v_key := app.packaging_order_type_key (v_order_type);
  v_order_pack := app.packaging_expand (
    'order_type',
    v_key,
    null,
    null,
    v_ordered,
    false,
    true,
    1,
    1,
    null
  );

  if v_order_pack ->> 'state' = 'gap' then
    v_unreviewed := true;
  elsif v_order_pack ->> 'state' = 'blocked' then
    v_blocked := true;
  elsif pg_catalog.jsonb_typeof (v_order_pack -> 'requirements') = 'array' then
    v_reqs := app.pos_map_merge_req (v_reqs, v_order_pack -> 'requirements');
  end if;

  v_issues := v_issues || coalesce(v_order_pack -> 'issues', '[]'::jsonb);
  v_paths := v_paths || coalesce(v_order_pack -> 'paths', '[]'::jsonb);

  if v_order_pack ->> 'version_id' is not null then
    v_pack_ids := v_pack_ids || pg_catalog.jsonb_build_array(v_order_pack -> 'version_id');
  end if;

  for v_line in
  select
    l.line_id,
    l.item_id,
    l.item_name,
    l.size_name,
    l.quantity,
    l.weighted_qty,
    l.weighted_unit,
    l.options
  from
    pg_catalog.jsonb_to_recordset(p_lines) as l (
      line_id text,
      item_id text,
      item_name text,
      size_name text,
      quantity numeric,
      weighted_qty numeric,
      weighted_unit text,
      options jsonb
    )
  order by
    l.line_id
  loop
    v_exact := app.resolve_line_requirements_core (
      v_line.item_id,
      v_line.item_name,
      v_ordered,
      v_line.quantity,
      v_line.weighted_qty,
      v_line.weighted_unit,
      v_line.options,
      v_line.size_name
    );
    v_map_ids := v_map_ids || coalesce(v_exact -> 'provenance' -> 'mapping_versions', '[]'::jsonb);
    v_recipe_ids := v_recipe_ids || coalesce(
      v_exact -> 'provenance' -> 'recipe_versions',
      '[]'::jsonb
    );
    v_paths := v_paths || coalesce(
      (
        select
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_strip_nulls (
              pg_catalog.jsonb_build_object(
                'source',
                'line',
                'line_id',
                v_line.line_id,
                'role',
                e.value -> 'role',
                'pos_item_id',
                e.value -> 'pos_item_id',
                'size_key',
                e.value -> 'size_key',
                'option_value',
                e.value -> 'option_value',
                'mapping_version_id',
                e.value -> 'mapping_version_id',
                'state',
                e.value -> 'state'
              )
            )
          )
        from
          pg_catalog.jsonb_array_elements (coalesce(v_exact -> 'subjects', '[]'::jsonb)) as e
      ),
      '[]'::jsonb
    );
    v_paths := v_paths || app.packaging_line_recipe_paths_core (
      v_line.line_id,
      v_line.item_id,
      v_ordered,
      v_line.quantity,
      v_line.weighted_qty,
      v_line.weighted_unit,
      v_line.options,
      v_line.size_name
    );

    if v_exact ->> 'status' = 'exception' then
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id',
          v_line.line_id,
          'status',
          'exception',
          'issues',
          coalesce(v_exact -> 'issues', '[]'::jsonb),
          'subjects',
          coalesce(v_exact -> 'subjects', '[]'::jsonb),
          'packaging',
          pg_catalog.jsonb_build_object(
            'state',
            'skipped',
            'version_id',
            null,
            'issues',
            '[]'::jsonb
          )
        )
      );
    else
      if v_exact ->> 'status' is distinct from 'ready' then
        v_line_bad := true;
        v_issues := v_issues || coalesce(v_exact -> 'issues', '[]'::jsonb);
      elsif pg_catalog.jsonb_typeof (v_exact -> 'requirements') = 'array' then
        v_reqs := app.pos_map_merge_req (v_reqs, v_exact -> 'requirements');
      end if;

      v_weighted := v_line.weighted_qty is not null;
      v_scale_ok := true;
      v_scale_num := v_line.quantity;
      v_scale_den := 1;

      if v_weighted then
        v_kg := app.packaging_kg_scale (v_line.weighted_qty, v_line.weighted_unit);
        v_scale_ok := coalesce((v_kg ->> 'ok')::boolean, false);

        if v_scale_ok then
          v_scale_num := (v_kg ->> 'numerator')::numeric;
          v_scale_den := (v_kg ->> 'denominator')::numeric;
        end if;
      end if;

      v_pack := app.packaging_expand (
        'base',
        null,
        v_line.item_id,
        app.pos_size_key (v_line.size_name),
        v_ordered,
        v_weighted,
        v_scale_ok,
        v_scale_num,
        v_scale_den,
        v_line.line_id
      );

      if v_pack ->> 'state' = 'gap' then
        v_unreviewed := true;
      elsif v_pack ->> 'state' = 'blocked' then
        v_blocked := true;
      elsif v_exact ->> 'status' = 'ready'
      and pg_catalog.jsonb_typeof (v_pack -> 'requirements') = 'array' then
        v_reqs := app.pos_map_merge_req (v_reqs, v_pack -> 'requirements');
      end if;

      v_issues := v_issues || coalesce(v_pack -> 'issues', '[]'::jsonb);
      v_paths := v_paths || coalesce(v_pack -> 'paths', '[]'::jsonb);

      if v_pack ->> 'version_id' is not null then
        v_pack_ids := v_pack_ids || pg_catalog.jsonb_build_array(v_pack -> 'version_id');
      end if;

      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id',
          v_line.line_id,
          'status',
          v_exact ->> 'status',
          'issues',
          coalesce(v_exact -> 'issues', '[]'::jsonb),
          'subjects',
          coalesce(v_exact -> 'subjects', '[]'::jsonb),
          'packaging',
          pg_catalog.jsonb_build_object(
            'state',
            v_pack ->> 'state',
            'version_id',
            v_pack -> 'version_id',
            'issues',
            coalesce(v_pack -> 'issues', '[]'::jsonb)
          )
        )
      );
    end if;
  end loop;

  if v_line_bad then
    v_causes := v_causes || '["line"]'::jsonb;
  end if;

  if v_unreviewed then
    v_causes := v_causes || '["packaging_unreviewed"]'::jsonb;
  end if;

  if v_blocked then
    v_causes := v_causes || '["blocked"]'::jsonb;
  end if;

  if v_line_bad
  or v_unreviewed
  or v_blocked then
    v_status := 'incomplete';
    v_sorted := null;
  else
    v_status := 'ready';

    select
      coalesce(
        pg_catalog.jsonb_agg(
          e.value
          order by
            e.value ->> 'stock_item_id'
        ),
        '[]'::jsonb
      )
    into v_sorted
    from
      pg_catalog.jsonb_array_elements (v_reqs) as e;
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    v_status,
    'cause',
    null,
    'requirements',
    v_sorted,
    'lines',
    v_lines,
    'order_packaging',
    pg_catalog.jsonb_build_object(
      'order_type_key',
      v_key,
      'state',
      v_order_pack ->> 'state',
      'version_id',
      v_order_pack -> 'version_id',
      'issues',
      coalesce(v_order_pack -> 'issues', '[]'::jsonb)
    ),
    'issues',
    v_issues,
    'causes',
    v_causes,
    'provenance',
    pg_catalog.jsonb_build_object(
      'at',
      app.costing_timestamptz_text (v_ordered),
      'algorithm_version',
      1,
      'mapping_versions',
      app.packaging_distinct_ids (v_map_ids),
      'packaging_versions',
      app.packaging_distinct_ids (v_pack_ids),
      'recipe_versions',
      app.packaging_distinct_ids (v_recipe_ids),
      'paths',
      coalesce(v_paths, '[]'::jsonb)
    )
  );
end;
$$;

comment on function app.resolve_order_requirements_core (text, boolean, timestamptz, text, jsonb, boolean) is 'Internal order expansion over header and lines passed as arguments, shared by the mirror lookup and the snapshot lookup. p_preparation bypasses only the complete-order eligibility gate. Nothing is rounded. Revoked from API roles.';

revoke all on function app.resolve_order_requirements_core (text, boolean, timestamptz, text, jsonb, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.resolve_order_requirements_exact (p_order_id text, p_expected_order_version integer) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_order record;
  v_lines jsonb;
begin
  select
    o.status,
    o.missing_from_pos,
    o.ordered_at,
    o.order_type,
    o.version
  into v_order
  from
    app.pos_orders o
  where
    o.id = p_order_id;

  if not found then
    raise exception 'unknown order'
      using errcode = '22023';
  end if;

  if p_expected_order_version is not null
  and p_expected_order_version is distinct from v_order.version then
    raise exception 'order changed'
      using errcode = '40001';
  end if;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'line_id',
          l.line_id,
          'item_id',
          l.item_id,
          'item_name',
          l.item_name,
          'size_name',
          l.size_name,
          'quantity',
          l.quantity,
          'weighted_qty',
          l.weighted_qty,
          'weighted_unit',
          l.weighted_unit,
          'options',
          l.options
        )
        order by
          l.line_id
      ),
      '[]'::jsonb
    )
  into v_lines
  from
    app.pos_order_lines l
  where
    l.order_id = p_order_id;

  return app.resolve_order_requirements_core (
    v_order.status,
    v_order.missing_from_pos,
    v_order.ordered_at,
    v_order.order_type,
    v_lines,
    false
  );
end;
$$;

create function app.round_order_requirements (p_exact jsonb) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_requirements jsonb;
  v_below jsonb;
  v_causes jsonb;
begin
  if p_exact ->> 'status' is distinct from 'ready' then
    return p_exact;
  end if;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          e.value ->> 'stock_item_id',
          'base_unit',
          e.value ->> 'base_unit',
          'quantity',
          pg_catalog.to_jsonb (
            pg_catalog.trim_scale (
              (
                pg_catalog.div(
                  2 * (e.value ->> 'numerator')::numeric * 1000000 + (e.value ->> 'denominator')::numeric,
                  2 * (e.value ->> 'denominator')::numeric
                ) * 0.000001
              )::numeric(20, 6)
            )::text
          )
        )
        order by
          e.value ->> 'stock_item_id'
      ),
      '[]'::jsonb
    )
  into v_requirements
  from
    pg_catalog.jsonb_array_elements (p_exact -> 'requirements') as e;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'code',
          'below_precision',
          'stock_item_id',
          e.value ->> 'stock_item_id'
        )
        order by
          e.value ->> 'stock_item_id'
      ),
      '[]'::jsonb
    )
  into v_below
  from
    pg_catalog.jsonb_array_elements (p_exact -> 'requirements') as e
  where
    (e.value ->> 'numerator')::numeric > 0
    and pg_catalog.div(
      2 * (e.value ->> 'numerator')::numeric * 1000000 + (e.value ->> 'denominator')::numeric,
      2 * (e.value ->> 'denominator')::numeric
    ) = 0;

  if pg_catalog.jsonb_array_length (v_below) > 0 then
    v_causes := coalesce(p_exact -> 'causes', '[]'::jsonb);

    if not (v_causes ? 'blocked') then
      v_causes := v_causes || '["blocked"]'::jsonb;
    end if;

    return p_exact || pg_catalog.jsonb_build_object(
      'status',
      'incomplete',
      'requirements',
      null,
      'issues',
      (p_exact -> 'issues') || v_below,
      'causes',
      v_causes
    );
  end if;

  return p_exact || pg_catalog.jsonb_build_object('requirements', v_requirements);
end;
$$;

comment on function app.round_order_requirements (jsonb) is 'Rounds an exact order result once per stock item to 6 places, half up. A positive requirement that rounds to 0 is below_precision and makes the whole order incomplete. Same rule as the owner lookup. Revoked from API roles.';

revoke all on function app.round_order_requirements (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.resolve_order_requirements (p_order_id text, p_expected_order_version integer) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_exact jsonb;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_exact := app.resolve_order_requirements_exact (
    p_order_id,
    p_expected_order_version
  );

  return app.round_order_requirements (v_exact);
end;
$$;

create function app.resolve_order_snapshot_exact (
  p_snapshot_id bigint,
  p_preparation_mode boolean default false,
  p_missing_from_pos boolean default false
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_snap record;
  v_exact jsonb;
  v_loss jsonb;
  v_conv jsonb;
begin
  select
    s.status,
    s.ordered_at,
    s.order_type,
    s.lines
  into v_snap
  from
    app.pos_order_snapshots s
  where
    s.id = p_snapshot_id;

  if not found then
    raise exception 'unknown snapshot'
      using errcode = '22023';
  end if;

  v_exact := app.resolve_order_requirements_core (
    v_snap.status,
    coalesce(p_missing_from_pos, false),
    v_snap.ordered_at,
    v_snap.order_type,
    v_snap.lines,
    coalesce(p_preparation_mode, false)
  );

  if v_exact ->> 'status' is distinct from 'ready' then
    return v_exact;
  end if;

  -- The loss and conversion versions in force at the ordered instant for the
  -- final requirement items: a superset of the ones the expansion read.
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id',
          v.item_id,
          'version_id',
          v.id,
          'loss_pct',
          pg_catalog.trim_scale (v.loss_pct)::text
        )
        order by
          v.item_id
      ),
      '[]'::jsonb
    )
  into v_loss
  from
    app.item_loss_versions v
  where
    v.superseded_change_id is null
    and v.valid_during @> v_snap.ordered_at
    and v.item_id::text in (
      select
        e.value ->> 'stock_item_id'
      from
        pg_catalog.jsonb_array_elements(v_exact -> 'requirements') as e (value)
    );

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id',
          v.item_id,
          'unit_code',
          v.unit_code,
          'version_id',
          v.id,
          'factor_to_base',
          pg_catalog.trim_scale (v.factor_to_base)::text
        )
        order by
          v.item_id,
          v.unit_code
      ),
      '[]'::jsonb
    )
  into v_conv
  from
    app.item_conversion_versions v
  where
    v.superseded_change_id is null
    and v.valid_during @> v_snap.ordered_at
    and v.item_id::text in (
      select
        e.value ->> 'stock_item_id'
      from
        pg_catalog.jsonb_array_elements(v_exact -> 'requirements') as e (value)
    );

  return v_exact || pg_catalog.jsonb_build_object(
    'provenance',
    (v_exact -> 'provenance') || pg_catalog.jsonb_build_object(
      'loss_versions',
      v_loss,
      'conversion_versions',
      v_conv
    )
  );
end;
$$;

comment on function app.resolve_order_snapshot_exact (bigint, boolean, boolean) is 'Resolves one immutable POS snapshot at its ordered_at through the shared expansion, with exact fractions. p_preparation_mode bypasses only the complete-order eligibility gate. p_missing_from_pos carries the cost input flag, which the snapshot does not hold. Ready results add provenance loss_versions and conversion_versions for the final requirement items. Revoked from API roles.';

revoke all on function app.resolve_order_snapshot_exact (bigint, boolean, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 9. Pending queue. An order is pending while it has an unprocessed event,
-- unless its attempts are exhausted and no newer event arrived. Order: the
-- earliest of the latest input's occurrence and the current application's,
-- then order id, so a late correction replays before newer sales.
-- ============================================================================
create function app.accounting_pending_orders (p_limit integer) returns table (
  order_id text,
  has_new boolean,
  eff_generation integer
) language sql stable security definer
set
  search_path = '' as $$
  select
    oo.order_id,
    oo.has_new,
    coalesce(ws.work_generation, 0) + case
      when oo.has_new then 1
      else 0
    end
  from
    (
      select
        e.order_id,
        pg_catalog.bool_or(e.work_generation is null) as has_new
      from
        app.accounting_work_events e
      where
        e.processed_at is null
      group by
        e.order_id
    ) oo
    left join app.accounting_work_state ws on ws.order_id = oo.order_id
    left join lateral (
      select
        s.ordered_at
      from
        app.pos_cost_inputs i
        join app.pos_order_snapshots s on s.id = i.snapshot_id
      where
        i.order_id = oo.order_id
      order by
        i.input_revision desc
      limit
        1
    ) li on true
    left join lateral (
      select
        a.occurred_at
      from
        app.order_cost_state h
        join app.order_cost_applications a on a.id = h.owner_application_id
      where
        h.order_id = oo.order_id
    ) cur on true
  where
    ws.failed_at is null
    or oo.has_new
  order by
    least(li.ordered_at, cur.occurred_at) nulls last,
    oo.order_id
  limit
    p_limit;
$$;

comment on function app.accounting_pending_orders (integer) is 'Orders with unprocessed work, in occurrence order, with the generation the next attempt belongs to. Private.';

revoke all on function app.accounting_pending_orders (integer)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 10. Coordinator. One order, atomically, under the ledger lock. Reads the
-- immutable inputs only. Never touches the POS mirror.
-- ============================================================================
create function app.process_order_accounting (
  p_order_id text,
  p_attempt_id uuid,
  p_work_generation integer
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  c_algorithm constant integer := 1;
  v_start timestamptz;
  v_input record;
  v_snap record;
  v_head record;
  v_disposition text;
  v_reason text;
  v_causes jsonb := '[]'::jsonb;
  v_exact jsonb := null;
  v_res jsonb;
  v_reqs jsonb := null;
  v_sig text;
  v_id bigint;
  v_owner_id bigint;
  v_event bigint;
  v_retire_ids bigint[];
  v_reversal bigint[] := '{}'::bigint[];
  v_retire_batch uuid := null;
  v_batch uuid := null;
  v_lines jsonb;
  v_detail text;
  v_blocked uuid[];
  v_floor jsonb;
  v_linked integer;
  v_expected integer;
  v_kind text;
  v_now timestamptz;
begin
  perform app.assert_ledger_lock_held ();

  select
    a.stock_started_at
  into v_start
  from
    app.inventory_activation a
  where
    a.id = 1;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_activated');
  end if;

  select
    i.*
  into v_input
  from
    app.pos_cost_inputs i
  where
    i.order_id = p_order_id
  order by
    i.input_revision desc
  limit
    1;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'none', 'reason', 'no_input');
  end if;

  select
    s.*
  into v_snap
  from
    app.pos_order_snapshots s
  where
    s.id = v_input.snapshot_id;

  insert into
    app.order_cost_state (order_id)
  values
    (p_order_id)
  on conflict (order_id) do nothing;

  select
    h.*
  into v_head
  from
    app.order_cost_state h
  where
    h.order_id = p_order_id
  for update;

  v_now := pg_catalog.clock_timestamp ();

  -- Desired state, in this order.
  if v_snap.ordered_at < v_start then
    v_disposition := 'none';
    v_reason := 'before_stock_start';
    v_causes := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('code', v_reason)
    );
  elsif v_input.missing_from_pos
  or v_snap.status = 'canceled'
  or coalesce(pg_catalog.cardinality (v_input.refund_revision_ids), 0) > 0 then
    -- PR 5 decides these. The current application stays as it is.
    v_reason := case
      when v_input.missing_from_pos then 'missing'
      when v_snap.status = 'canceled' then 'canceled'
      else 'refund'
    end;

    update app.order_cost_state h
    set
      latest_input_id = v_input.id,
      causes = pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'disposition_pending',
          'reason',
          v_reason
        )
      ),
      evaluated_at = v_now,
      updated_at = v_now
    where
      h.order_id = p_order_id;

    return pg_catalog.jsonb_build_object(
      'outcome',
      'disposition_pending',
      'reason',
      v_reason
    );
  elsif v_snap.status = 'active' then
    v_disposition := 'none';
    v_reason := 'open';
    v_causes := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('code', v_reason)
    );
  else
    v_exact := app.resolve_order_snapshot_exact (v_snap.id, false, false);
    v_res := app.round_order_requirements (v_exact);

    if v_res ->> 'status' = 'ready' then
      v_reqs := v_res -> 'requirements';

      if pg_catalog.jsonb_array_length(v_reqs) = 0 then
        v_disposition := 'none';
        v_reason := 'no_stock';
        v_causes := pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('code', v_reason)
        );
      elsif not exists (
        select
          1
        from
          app.pos_shifts ps
        where
          ps.id = v_snap.shift_id
      ) then
        v_disposition := 'incomplete';
        v_reason := 'missing_shift';
        v_causes := pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('code', v_reason)
        );
      else
        select
          coalesce(
            pg_catalog.jsonb_agg(
              e.value ->> 'stock_item_id'
              order by
                e.value ->> 'stock_item_id'
            ),
            '[]'::jsonb
          )
        into v_floor
        from
          pg_catalog.jsonb_array_elements(v_reqs) as e (value)
        where
          (
            select
              min(sm.occurred_at)
            from
              app.stock_movements sm
            where
              sm.item_id = (e.value ->> 'stock_item_id')::uuid
              and sm.movement_type = 'opening'
          ) > v_snap.ordered_at;

        if pg_catalog.jsonb_array_length(v_floor) > 0 then
          v_disposition := 'incomplete';
          v_reason := 'before_item_opening';
          v_causes := pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('code', v_reason, 'item_ids', v_floor)
          );
        else
          v_disposition := 'sale';
          v_reason := null;
        end if;
      end if;
    else
      v_disposition := 'incomplete';

      select
        coalesce(
          pg_catalog.jsonb_agg(
            distinct pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'code',
                i.value ->> 'code',
                'role',
                i.value ->> 'role'
              )
            )
          ),
          '[]'::jsonb
        )
      into v_causes
      from
        pg_catalog.jsonb_array_elements(coalesce(v_res -> 'issues', '[]'::jsonb)) as i (value);

      if pg_catalog.jsonb_array_length(v_causes) = 0 then
        v_causes := pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('code', 'incomplete')
        );
      end if;

      v_reason := v_causes -> 0 ->> 'code';
    end if;
  end if;

  if v_disposition = 'sale' then
    v_sig := pg_catalog.md5(
      pg_catalog.concat_ws(
        '|',
        'sale',
        app.costing_timestamptz_text (v_snap.ordered_at),
        v_snap.shift_id,
        (
          select
            pg_catalog.string_agg(
              e.value ->> 'stock_item_id' || ':' || (e.value ->> 'quantity'),
              ','
              order by
                e.value ->> 'stock_item_id'
            )
          from
            pg_catalog.jsonb_array_elements(v_reqs) as e (value)
        ),
        c_algorithm::text
      )
    );
  else
    v_sig := pg_catalog.md5(pg_catalog.concat_ws('|', v_disposition, c_algorithm::text));
  end if;

  v_owner_id := v_head.owner_application_id;
  v_event := null;

  if v_owner_id is not null then
    select
      a.event_position
    into v_event
    from
      app.order_cost_applications a
    where
      a.id = v_owner_id;
  end if;

  v_id := pg_catalog.nextval(
    pg_catalog.pg_get_serial_sequence('app.order_cost_applications', 'id')
  );

  if v_head.signature is not distinct from v_sig then
    v_kind := 'evaluation';
  else
    v_kind := 'posting';

    begin
      if v_owner_id is not null then
        select
          pg_catalog.array_agg(
            l.movement_id
            order by
              l.movement_id
          )
        into v_retire_ids
        from
          app.order_cost_movement_links l
        where
          l.application_id = v_owner_id;

        if coalesce(pg_catalog.array_length(v_retire_ids, 1), 0) > 0 then
          v_retire_batch := pg_catalog.gen_random_uuid ();
          v_reversal := app.retire_movements (v_retire_ids, v_retire_batch);
        end if;
      end if;

      if v_disposition = 'sale' then
        if v_event is null then
          v_event := pg_catalog.nextval(
            pg_catalog.pg_get_serial_sequence('app.stock_movements', 'id')
          );
        end if;

        select
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'item_id',
              e.value ->> 'stock_item_id',
              'movement_type',
              'sale',
              'occurred_at',
              v_snap.ordered_at,
              'quantity',
              (e.value ->> 'quantity')::numeric,
              'shift_id',
              v_snap.shift_id,
              'source_id',
              v_id::text,
              'note',
              null,
              'event_position',
              v_event
            )
            order by
              e.value ->> 'stock_item_id'
          )
        into v_lines
        from
          pg_catalog.jsonb_array_elements(v_reqs) as e (value);

        v_batch := app.post_engine_outflows (v_lines);
      end if;
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_detail = pg_exception_detail;

        if v_detail is distinct from 'missing_cost_basis' then
          raise;
        end if;

        select
          coalesce(
            pg_catalog.array_agg(
              (e.value ->> 'stock_item_id')::uuid
              order by
                e.value ->> 'stock_item_id'
            ),
            '{}'::uuid[]
          )
        into v_blocked
        from
          pg_catalog.jsonb_array_elements(v_reqs) as e (value)
        where
          not exists (
            select
              1
            from
              app.item_provisional_seeds sd
            where
              sd.item_id = (e.value ->> 'stock_item_id')::uuid
          )
          and not exists (
            select
              1
            from
              app.item_opening_prices p
            where
              p.item_id = (e.value ->> 'stock_item_id')::uuid
              and p.superseded_change_id is null
          );

        if coalesce(pg_catalog.cardinality (v_blocked), 0) = 0 then
          select
            pg_catalog.array_agg(
              (e.value ->> 'stock_item_id')::uuid
              order by
                e.value ->> 'stock_item_id'
            )
          into v_blocked
          from
            pg_catalog.jsonb_array_elements(v_reqs) as e (value);
        end if;

        update app.order_cost_state h
        set
          latest_input_id = v_input.id,
          causes = pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'code',
              'missing_cost_basis',
              'item_ids',
              pg_catalog.to_jsonb(v_blocked)
            )
          ),
          evaluated_at = v_now,
          updated_at = v_now
        where
          h.order_id = p_order_id;

        return pg_catalog.jsonb_build_object(
          'outcome',
          'blocked',
          'reason',
          'missing_cost_basis',
          'blocked_item_ids',
          pg_catalog.to_jsonb(v_blocked)
        );
    end;
  end if;

  insert into
    app.order_cost_applications (
      id,
      order_id,
      cost_input_id,
      snapshot_id,
      receipt_kind,
      disposition,
      predecessor_id,
      retired_application_id,
      movement_owner_id,
      occurred_at,
      shift_id,
      event_position,
      signature,
      algorithm_version,
      requirements,
      exact_requirements,
      provenance,
      causes,
      retire_batch,
      posting_batch,
      reversal_movement_ids,
      work_generation,
      attempt_id
    )
  values
    (
      v_id,
      p_order_id,
      v_input.id,
      v_snap.id,
      v_kind,
      v_disposition,
      v_head.latest_application_id,
      case
        when v_kind = 'posting'
        and v_retire_batch is not null then v_owner_id
        else null
      end,
      case
        when v_kind = 'evaluation' then v_owner_id
        when v_disposition = 'sale' then v_id
        else null
      end,
      case
        when v_disposition = 'sale' then v_snap.ordered_at
        else null
      end,
      case
        when v_disposition = 'sale' then v_snap.shift_id
        else null
      end,
      case
        when v_disposition = 'sale' then v_event
        else null
      end,
      v_sig,
      c_algorithm,
      v_reqs,
      case
        when v_exact ->> 'status' = 'ready' then v_exact -> 'requirements'
        else null
      end,
      v_exact -> 'provenance',
      v_causes,
      v_retire_batch,
      v_batch,
      v_reversal,
      p_work_generation,
      p_attempt_id
    );

  if v_batch is not null then
    insert into
      app.order_cost_movement_links (
        movement_id,
        application_id,
        order_id,
        item_id,
        event_position,
        piece_position
      )
    select
      sm.id,
      v_id,
      p_order_id,
      sm.item_id,
      sm.event_position,
      sm.piece_position
    from
      app.stock_movements sm
    where
      sm.batch_id = v_batch
      and sm.source_type = 'engine'
      and sm.source_id = v_id::text
      and sm.movement_type = 'sale';

    get diagnostics v_linked = row_count;

    select
      pg_catalog.jsonb_array_length(v_reqs)
    into v_expected;

    if v_linked < v_expected then
      raise exception 'engine posting did not link every requirement'
        using errcode = '55000';
    end if;
  end if;

  update app.order_cost_state h
  set
    latest_input_id = v_input.id,
    latest_application_id = v_id,
    owner_application_id = case
      when v_kind = 'evaluation' then v_owner_id
      when v_disposition = 'sale' then v_id
      else null
    end,
    disposition = v_disposition,
    signature = v_sig,
    causes = v_causes,
    evaluated_at = v_now,
    updated_at = v_now
  where
    h.order_id = p_order_id;

  return pg_catalog.jsonb_build_object(
    'outcome',
    case
      when v_disposition = 'sale'
      and v_kind = 'posting' then 'applied'
      when v_disposition = 'sale' then 'unchanged'
      else v_disposition
    end,
    'reason',
    v_reason,
    'application_id',
    v_id,
    'receipt_kind',
    v_kind
  );
end;
$$;

comment on function app.process_order_accounting (text, uuid, integer) is 'Evaluates one order against its latest cost input and brings its stock effect to the desired state: retire every movement of the previous application, then post the replacement at the snapshot instant and shift, or record an incomplete or none result. An identical economic signature writes an evaluation receipt only. missing_cost_basis rolls the transition back and returns blocked. Canceled, missing and refunded orders keep their application (disposition_pending). Caller holds the ledger lock. Private.';

revoke all on function app.process_order_accounting (text, uuid, integer)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 11. Worker.
-- Lock order: ledger advisory lock, pos_sync_runs SHARE (defer when a sync is
-- running), pos_shifts SHARE, order-accounting rows by order id, then balances
-- inside the posting functions. Never locks pos_orders.
-- ============================================================================
create function app.run_accounting_work (p_attempt_id uuid, p_limit integer) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_started timestamptz := pg_catalog.clock_timestamp ();
  v_ids text[];
  v_pending record;
  v_span record;
  v_span_orders text[];
  v_span_times timestamptz[];
  v_n integer;
  v_result jsonb;
  v_gen integer;
  v_processed integer := 0;
  v_applied integer := 0;
  v_unchanged integer := 0;
  v_incomplete integer := 0;
  v_none integer := 0;
  v_blocked_count integer := 0;
  v_pending_count integer := 0;
  v_failed integer := 0;
  v_critical jsonb := null;
  v_sqlstate text;
  v_msg text;
  v_detail text;
  v_reason text;
  v_blocked uuid[];
  v_remaining integer;
  v_head record;
  v_status text;
begin
  perform app.assert_pos_write_allowed ();

  if p_attempt_id is null then
    raise exception 'attempt id is required'
      using errcode = '22023';
  end if;

  if p_limit is null
  or p_limit < 1
  or p_limit > 10 then
    raise exception 'limit must be between 1 and 10'
      using errcode = '22023';
  end if;

  if not exists (
    select
      1
    from
      app.inventory_activation
  ) then
    return pg_catalog.jsonb_build_object('status', 'not_activated');
  end if;

  perform pg_catalog.set_config('lock_timeout', '250ms', true);
  perform pg_catalog.set_config('statement_timeout', '6s', true);

  if not pg_catalog.pg_try_advisory_xact_lock (7342750000000000001::bigint) then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;

  begin
    lock table app.pos_sync_runs in share mode;
  exception
    when lock_not_available then
      return pg_catalog.jsonb_build_object('status', 'sync_running');
  end;

  if exists (
    select
      1
    from
      app.pos_sync_runs r
    where
      r.status = 'running'
  ) then
    return pg_catalog.jsonb_build_object('status', 'sync_running');
  end if;

  begin
    lock table app.pos_shifts in share mode;
  exception
    when lock_not_available then
      return pg_catalog.jsonb_build_object('status', 'busy');
  end;

  -- One bounded slice of one rederive span: 100 orders by keyset.
  select
    sp.*
  into v_span
  from
    app.accounting_rederive_spans sp
  where
    sp.completed_at is null
  order by
    sp.id
  limit
    1
  for update;

  if found then
    select
      coalesce(
        pg_catalog.array_agg(
          b.order_id
          order by
            b.ordered_at,
            b.order_id
        ),
        '{}'::text[]
      ),
      coalesce(
        pg_catalog.array_agg(
          b.ordered_at
          order by
            b.ordered_at,
            b.order_id
        ),
        '{}'::timestamptz[]
      )
    into
      v_span_orders,
      v_span_times
    from
      (
        select
          s.ordered_at,
          s.order_id
        from
          app.pos_order_snapshots s
        where
          s.ordered_at >= v_span.effective_from
          and (
            v_span.effective_to is null
            or s.ordered_at < v_span.effective_to
          )
          and (
            v_span.cursor_ordered_at is null
            or (s.ordered_at, s.order_id) > (v_span.cursor_ordered_at, v_span.cursor_order_id)
          )
          and s.id = (
            select
              i.snapshot_id
            from
              app.pos_cost_inputs i
            where
              i.order_id = s.order_id
            order by
              i.input_revision desc
            limit
              1
          )
        order by
          s.ordered_at,
          s.order_id
        limit
          100
      ) b;

    v_n := coalesce(pg_catalog.cardinality (v_span_orders), 0);

    insert into
      app.accounting_work_events (order_id, cause, source_key, span_id)
    select
      u.order_id,
      'config_span',
      'span:' || v_span.id::text || ':' || u.order_id,
      v_span.id
    from
      pg_catalog.unnest(v_span_orders) as u (order_id)
    on conflict (source_key) do nothing;

    update app.accounting_rederive_spans sp
    set
      orders_enqueued = sp.orders_enqueued + v_n,
      cursor_ordered_at = case
        when v_n > 0 then v_span_times[v_n]
        else sp.cursor_ordered_at
      end,
      cursor_order_id = case
        when v_n > 0 then v_span_orders[v_n]
        else sp.cursor_order_id
      end,
      completed_at = case
        when v_n < 100 then pg_catalog.clock_timestamp ()
        else null
      end
    where
      sp.id = v_span.id;
  end if;

  select
    pg_catalog.array_agg(p.order_id)
  into v_ids
  from
    app.accounting_pending_orders (p_limit) p;

  if v_ids is not null then
    insert into
      app.accounting_work_state (order_id)
    select
      u.order_id
    from
      pg_catalog.unnest(v_ids) as u (order_id)
    on conflict (order_id) do nothing;

    insert into
      app.order_cost_state (order_id)
    select
      u.order_id
    from
      pg_catalog.unnest(v_ids) as u (order_id)
    on conflict (order_id) do nothing;

    perform 1
    from
      app.accounting_work_state ws
    where
      ws.order_id = any (v_ids)
    order by
      ws.order_id
    for update;

    perform 1
    from
      app.order_cost_state h
    where
      h.order_id = any (v_ids)
    order by
      h.order_id
    for update;
  end if;

  for v_pending in
  select
    p.order_id,
    p.has_new,
    p.eff_generation
  from
    app.accounting_pending_orders (p_limit) p loop
    v_gen := v_pending.eff_generation;

    if v_pending.has_new then
      update app.accounting_work_events e
      set
        work_generation = v_gen
      where
        e.order_id = v_pending.order_id
        and e.work_generation is null;

      update app.accounting_work_state ws
      set
        work_generation = v_gen,
        attempts = 0,
        failed_at = null,
        updated_at = pg_catalog.clock_timestamp ()
      where
        ws.order_id = v_pending.order_id;
    end if;

    begin
      v_result := app.process_order_accounting (v_pending.order_id, p_attempt_id, v_gen);

      select
        coalesce(
          pg_catalog.array_agg(b.value::uuid),
          '{}'::uuid[]
        )
      into v_blocked
      from
        pg_catalog.jsonb_array_elements_text(
          coalesce(v_result -> 'blocked_item_ids', '[]'::jsonb)
        ) as b (value);

      update app.accounting_work_state ws
      set
        attempts = 0,
        failed_at = null,
        last_outcome = v_result ->> 'outcome',
        last_reason = v_result ->> 'reason',
        blocked_item_ids = v_blocked,
        last_error_code = null,
        last_attempt_id = p_attempt_id,
        updated_at = pg_catalog.clock_timestamp ()
      where
        ws.order_id = v_pending.order_id;

      update app.accounting_work_events e
      set
        processed_at = pg_catalog.clock_timestamp ()
      where
        e.order_id = v_pending.order_id
        and e.work_generation is not null
        and e.work_generation <= v_gen
        and e.processed_at is null;

      v_processed := v_processed + 1;

      case v_result ->> 'outcome'
        when 'applied' then v_applied := v_applied + 1;
        when 'unchanged' then v_unchanged := v_unchanged + 1;
        when 'incomplete' then v_incomplete := v_incomplete + 1;
        when 'none' then v_none := v_none + 1;
        when 'blocked' then v_blocked_count := v_blocked_count + 1;
        when 'disposition_pending' then v_pending_count := v_pending_count + 1;
        else null;
      end case;
    exception
      when others then
        get stacked diagnostics v_sqlstate = returned_sqlstate,
        v_msg = message_text,
        v_detail = pg_exception_detail;

        v_reason := case
          when v_sqlstate = '22023'
          and v_msg = 'recompute result is out of range'
          and v_detail = 'recompute_limit' then 'recompute_limit'
          when v_sqlstate = '22023'
          and v_msg = 'recompute result is out of range'
          and v_detail = 'critical' then 'critical'
          else 'error'
        end;

        insert into
          app.accounting_work_attempts (
            order_id,
            work_generation,
            attempt_id,
            kind,
            sqlstate,
            reason
          )
        values
          (
            v_pending.order_id,
            v_gen,
            p_attempt_id,
            'caught',
            v_sqlstate,
            v_reason
          )
        on conflict do nothing;

        update app.accounting_work_state ws
        set
          attempts = ws.attempts + 1,
          failed_at = case
            when ws.attempts + 1 >= 5 then pg_catalog.clock_timestamp ()
            else ws.failed_at
          end,
          last_reason = v_reason,
          last_error_code = v_sqlstate,
          last_attempt_id = p_attempt_id,
          updated_at = pg_catalog.clock_timestamp ()
        where
          ws.order_id = v_pending.order_id;

        v_failed := v_failed + 1;

        if v_reason = 'critical' then
          v_critical := pg_catalog.jsonb_build_object(
            'order_id',
            v_pending.order_id,
            'work_generation',
            v_gen
          );
        end if;
    end;

    exit when v_critical is not null
    or pg_catalog.clock_timestamp () - v_started > interval '2 seconds';
  end loop;

  select
    p.order_id,
    p.eff_generation
  into v_head
  from
    app.accounting_pending_orders (1) p;

  select
    count(*)
  into v_remaining
  from
    app.accounting_pending_orders (1001);

  v_status := case
    when v_critical is not null then 'critical'
    when v_processed = 0
    and v_failed = 0
    and v_head.order_id is null
    and not exists (
      select
        1
      from
        app.accounting_rederive_spans sp
      where
        sp.completed_at is null
    ) then 'empty'
    else 'processed'
  end;

  return pg_catalog.jsonb_build_object(
    'status',
    v_status,
    'processed',
    v_processed,
    'applied',
    v_applied,
    'unchanged',
    v_unchanged,
    'incomplete',
    v_incomplete,
    'none',
    v_none,
    'blocked',
    v_blocked_count,
    'disposition_pending',
    v_pending_count,
    'failed',
    v_failed,
    'remaining',
    v_remaining,
    'head',
    case
      when v_head.order_id is null then null
      else pg_catalog.jsonb_build_object(
        'order_id',
        v_head.order_id,
        'work_generation',
        v_head.eff_generation
      )
    end,
    'critical',
    v_critical
  );
end;
$$;

comment on function app.run_accounting_work (uuid, integer) is 'Owner or service_role. Processes up to p_limit pending orders in occurrence order under the ledger lock, after one bounded slice of a rederive span. Each order runs in its own subtransaction; a caught error rolls back that order and records the attempt. Five attempts in one work generation park the order (failed_at) until a new event or retry_accounting_work. blocked, none and disposition_pending count as success. critical stops the worker. Returns not_activated before an inventory_activation row exists, busy when the ledger lock is held, sync_running while a POS sync run is open. head is the next pending order and the generation a failure of this call would be charged to.';

revoke all on function app.run_accounting_work (uuid, integer)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.run_accounting_work (uuid, integer) to authenticated,
service_role;

-- ============================================================================
-- 12. Escaped failures and retry.
-- ============================================================================
create function app.record_accounting_call_failure (p_attempt_id uuid, p_work_generation integer) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_head record;
  v_inserted integer;
begin
  perform app.assert_pos_write_allowed ();

  if p_attempt_id is null then
    raise exception 'attempt id is required'
      using errcode = '22023';
  end if;

  perform pg_catalog.set_config('lock_timeout', '250ms', true);

  if not pg_catalog.pg_try_advisory_xact_lock (7342750000000000001::bigint) then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;

  -- A repeated report of the same call counts once.
  if exists (
    select
      1
    from
      app.accounting_work_attempts t
    where
      t.attempt_id = p_attempt_id
  ) then
    return pg_catalog.jsonb_build_object('status', 'duplicate');
  end if;

  -- The call may have committed after the caller lost the reply.
  if exists (
    select
      1
    from
      app.accounting_work_state ws
    where
      ws.last_attempt_id = p_attempt_id
  )
  or exists (
    select
      1
    from
      app.order_cost_applications a
    where
      a.attempt_id = p_attempt_id
  ) then
    return pg_catalog.jsonb_build_object('status', 'committed');
  end if;

  select
    p.order_id,
    p.has_new,
    p.eff_generation
  into v_head
  from
    app.accounting_pending_orders (1) p;

  if v_head.order_id is null then
    return pg_catalog.jsonb_build_object('status', 'no_work');
  end if;

  if p_work_generation is not null
  and p_work_generation is distinct from v_head.eff_generation then
    return pg_catalog.jsonb_build_object('status', 'stale');
  end if;

  insert into
    app.accounting_work_state (order_id)
  values
    (v_head.order_id)
  on conflict (order_id) do nothing;

  perform 1
  from
    app.accounting_work_state ws
  where
    ws.order_id = v_head.order_id
  for update;

  if v_head.has_new then
    update app.accounting_work_events e
    set
      work_generation = v_head.eff_generation
    where
      e.order_id = v_head.order_id
      and e.work_generation is null;

    update app.accounting_work_state ws
    set
      work_generation = v_head.eff_generation,
      attempts = 0,
      failed_at = null
    where
      ws.order_id = v_head.order_id;
  end if;

  insert into
    app.accounting_work_attempts (
      order_id,
      work_generation,
      attempt_id,
      kind,
      sqlstate,
      reason
    )
  values
    (
      v_head.order_id,
      v_head.eff_generation,
      p_attempt_id,
      'escaped',
      null,
      'escaped'
    )
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    update app.accounting_work_state ws
    set
      attempts = ws.attempts + 1,
      failed_at = case
        when ws.attempts + 1 >= 5 then pg_catalog.clock_timestamp ()
        else ws.failed_at
      end,
      last_reason = 'escaped',
      last_error_code = null,
      last_attempt_id = p_attempt_id,
      updated_at = pg_catalog.clock_timestamp ()
    where
      ws.order_id = v_head.order_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    case
      when v_inserted = 1 then 'recorded'
      else 'duplicate'
    end,
    'order_id',
    v_head.order_id,
    'work_generation',
    v_head.eff_generation
  );
end;
$$;

comment on function app.record_accounting_call_failure (uuid, integer) is 'Owner or service_role. Records a worker call that failed without a reply (statement timeout, lost connection). Under the ledger lock it first checks that the call did not commit, then charges one attempt to the order the next call would have processed, in the generation the caller saw. A repeated report of the same attempt id does nothing. Without a reply the failing order is not known; the head order is charged.';

revoke all on function app.record_accounting_call_failure (uuid, integer)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.record_accounting_call_failure (uuid, integer) to authenticated,
service_role;

create function app.retry_accounting_work (p_order_id text) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_failed timestamptz;
begin
  perform app.assert_pos_write_allowed ();

  perform pg_catalog.set_config('lock_timeout', '250ms', true);

  if not pg_catalog.pg_try_advisory_xact_lock (7342750000000000001::bigint) then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;

  select
    ws.failed_at
  into v_failed
  from
    app.accounting_work_state ws
  where
    ws.order_id = p_order_id
  for update;

  if not found
  or v_failed is null then
    return pg_catalog.jsonb_build_object('status', 'not_failed');
  end if;

  update app.accounting_work_state ws
  set
    failed_at = null,
    attempts = 0,
    work_generation = ws.work_generation + 1,
    updated_at = pg_catalog.clock_timestamp ()
  where
    ws.order_id = p_order_id;

  return pg_catalog.jsonb_build_object('status', 'retried');
end;
$$;

comment on function app.retry_accounting_work (text) is 'Owner or service_role. Clears failed_at and the attempt count of one parked order and opens a new work generation, so the next worker call retries it.';

revoke all on function app.retry_accounting_work (text)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.retry_accounting_work (text) to authenticated,
service_role;
