-- Order dispositions (phase 5, PR 5).
--
-- Cancel and refund decisions, partial returns, and the owner decision RPC.
-- Deductions stay dormant: every coordinator entry point still returns
-- not_activated until a row exists in app.inventory_activation, and this
-- migration writes none. No API role can write any table here; the writers are
-- the coordinator and set_order_disposition, both under the ledger lock.
--
-- Replaced functions, each from its latest definition:
--   app.process_order_accounting(text,uuid,integer)
--                                        base 20261108040000_order_deduction_engine.sql
-- It keeps its signature, owner, and privileges. Orders that are not canceled,
-- missing, or refunded, and that have no open decision episode, take exactly
-- the PR 4 path and produce the same signatures.
--
-- Vocabulary. An episode is one spell in which an order is canceled, missing,
-- or refunded. Its first event is a system default (made); owner events follow.
-- An event stores the classification basis it was made on. Terminal classes
-- (canceled, missing, full_refund): made posts prepared waste of the
-- preparation basis, not_made posts nothing. Partial classes (partial_refund,
-- unresolved_refund): the sale stays; not_made with returned quantities R
-- retires the sale and posts the kept quantities Q - R at the order instant.
-- ============================================================================
-- 0. Lock order. The ledger advisory lock is first, then the tables this
-- migration references by foreign key, NOWAIT, in a fixed order.
-- ============================================================================
select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

do $lock_tables$
begin
  lock table app.pos_order_snapshots,
  app.pos_cost_inputs,
  app.order_cost_applications in share row exclusive mode nowait;
end;
$lock_tables$;

-- ============================================================================
-- 1. Events. Append-only decisions with the basis each was made on.
-- ============================================================================
create table app.order_disposition_events (
  id bigint generated always as identity primary key,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  episode integer not null check (episode >= 1),
  decision text not null check (decision in ('made', 'not_made')),
  class text not null check (
    class in (
      'canceled',
      'missing',
      'full_refund',
      'partial_refund',
      'unresolved_refund',
      'none'
    )
  ),
  source text not null check (source in ('system_default', 'owner')),
  owner_reviewed boolean not null,
  actor uuid null references auth.users (id) on delete restrict,
  reason text null check (
    reason is null
    or (
      reason = pg_catalog.btrim (reason)
      and length(reason) between 1 and 300
    )
  ),
  prior_event_id bigint null references app.order_disposition_events (id) on delete restrict,
  cost_input_id bigint not null references app.pos_cost_inputs (id) on delete restrict,
  prep_snapshot_id bigint null references app.pos_order_snapshots (id) on delete restrict,
  prep_hash text null check (
    prep_hash is null
    or prep_hash ~ '^[0-9a-f]{32}$'
  ),
  q_items jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof (q_items) = 'array'),
  q_signature text null check (
    q_signature is null
    or q_signature ~ '^[0-9a-f]{32}$'
  ),
  refund_revision_ids bigint[] not null default '{}'::bigint[],
  refund_signature text not null check (refund_signature ~ '^[0-9a-f]{32}$'),
  order_total numeric(14, 2) not null,
  refund_total numeric(14, 2) not null check (refund_total >= 0),
  returned jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof (returned) = 'array'),
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint order_disposition_events_reviewed_chk check ((source = 'owner') = owner_reviewed),
  constraint order_disposition_events_actor_chk check (
    (
      source = 'owner'
      and actor is not null
    )
    or (
      source = 'system_default'
      and actor is null
      and reason is null
    )
  )
);

comment on table app.order_disposition_events is 'Append-only. One row per decision about a canceled, missing or refunded order: the first of an episode is a system default (made, owner_reviewed false), later rows are owner decisions. Each row keeps the basis it was decided on (preparation snapshot and hash, preparation quantities q_items, the linked refund revisions and their value signature, the order total frozen at decision time) and the cumulative returned quantities R per stock item against the preparation basis. returned is applied only for not_made on a partial refund; it is carried, not applied, in other cases. No customer data; reason is owner free text of at most 300 characters.';

comment on column app.order_disposition_events.returned is 'Cumulative returned quantity per stock item, [{stock_item_id, returned}], decimal text, zero entries dropped, sorted by item. A new owner event replaces it as a whole; a null request keeps the prior value.';

comment on column app.order_disposition_events.order_total is 'The order total the classification used. Frozen while the linked refund set is unchanged, so a total-only edit does not move the order between full and partial.';

create index order_disposition_events_order_idx on app.order_disposition_events (order_id, id);

-- ============================================================================
-- 2. Derived head, requests, application links.
-- ============================================================================
create table app.order_disposition_state (
  order_id text primary key check (length(pg_catalog.btrim (order_id)) > 0),
  episode integer not null default 0 check (episode >= 0),
  is_open boolean not null default false,
  event_id bigint null references app.order_disposition_events (id) on delete restrict,
  class text null check (
    class is null
    or class in (
      'canceled',
      'missing',
      'full_refund',
      'partial_refund',
      'unresolved_refund'
    )
  ),
  review_reason text null check (
    review_reason is null
    or review_reason in (
      'refund_changed',
      'class_changed',
      'items_changed',
      'quantities_changed',
      'unresolved_refund'
    )
  ),
  cost_input_id bigint null references app.pos_cost_inputs (id) on delete restrict,
  context jsonb not null default '{}'::jsonb,
  token text null,
  updated_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint order_disposition_state_open_chk check (
    not is_open
    or (
      event_id is not null
      and cost_input_id is not null
    )
  )
);

comment on table app.order_disposition_state is 'Derived head per order, written only by the coordinator and set_order_disposition under the ledger lock. is_open marks a running episode. class is the current classification of the latest input. review_reason is set while the application and allocation stay in force and the owner must decide again (refund_changed, class_changed, items_changed, quantities_changed), or while a negative refund amount makes the order unresolved. token is the optimistic token the owner screen must send.';

create table app.order_disposition_requests (
  request_id uuid primary key,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{32}$'),
  event_id bigint not null references app.order_disposition_events (id) on delete restrict,
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.order_disposition_requests is 'Append-only. The stored result of each committed set_order_disposition request id. A repeat with the same payload returns this result without reading mutable state; a different payload for the same id is rejected.';

create table app.order_disposition_applications (
  application_id bigint primary key references app.order_cost_applications (id) on delete restrict,
  event_id bigint not null references app.order_disposition_events (id) on delete restrict,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  stock_qty_delta numeric(20, 6) not null,
  stock_value_delta numeric(14, 2) not null,
  cogs_cost_delta numeric(14, 2) not null,
  waste_cost_delta numeric(14, 2) not null,
  profit_delta numeric(14, 2) not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.order_disposition_applications is 'Append-only. Each posting receipt written while an episode was open, with the exact stock and profit differences of its retire and posting batches: stock quantity and value (movement sums), cogs and waste as cost change (the negated ledger-sign revision sum, so a cost increase is positive), and profit as the ledger-sign sum of the cogs, waste and count revisions.';

create index order_disposition_applications_event_idx on app.order_disposition_applications (event_id);

create trigger trg_order_disposition_events_no_update_delete
before update or delete on app.order_disposition_events for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_order_disposition_events_no_truncate
before truncate on app.order_disposition_events for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_order_disposition_requests_no_update_delete
before update or delete on app.order_disposition_requests for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_order_disposition_requests_no_truncate
before truncate on app.order_disposition_requests for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_order_disposition_applications_no_update_delete
before update or delete on app.order_disposition_applications for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_order_disposition_applications_no_truncate
before truncate on app.order_disposition_applications for each statement
execute function app.prevent_append_only_mutation ();

-- ============================================================================
-- 3. RLS and grants. Owner-only SELECT. No DML grant for any API role.
-- ============================================================================
alter table app.order_disposition_events enable row level security;

alter table app.order_disposition_state enable row level security;

alter table app.order_disposition_requests enable row level security;

alter table app.order_disposition_applications enable row level security;

create policy order_disposition_events_select_owner on app.order_disposition_events for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy order_disposition_state_select_owner on app.order_disposition_state for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy order_disposition_requests_select_owner on app.order_disposition_requests for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy order_disposition_applications_select_owner on app.order_disposition_applications for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.order_disposition_events,
app.order_disposition_state,
app.order_disposition_requests,
app.order_disposition_applications
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.order_disposition_events_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.order_disposition_events,
  app.order_disposition_state,
  app.order_disposition_requests,
  app.order_disposition_applications to authenticated,
  service_role;

-- ============================================================================
-- 4. Classification helpers. Pure reads of the immutable inputs.
-- ============================================================================
create function app.disposition_family (p_class text) returns text language sql immutable
set
  search_path = '' as $$
  select
    case
      when p_class in ('canceled', 'missing', 'full_refund') then 'terminal'
      when p_class in ('partial_refund', 'unresolved_refund') then 'partial'
      else null
    end;
$$;

comment on function app.disposition_family (text) is 'terminal for canceled, missing and full_refund; partial for partial_refund and unresolved_refund; null otherwise. Private.';

revoke all on function app.disposition_family (text)
from
  public,
  anon,
  authenticated,
  service_role;

-- Missing takes precedence over an underlying status. A linked set with any
-- negative amount is an unresolved correction. Zero-only rows do not qualify.
-- Full needs a positive total: a total of zero or less with a qualifying
-- refund is partial.
create function app.disposition_class_of (p_ctx jsonb, p_total numeric) returns text language sql immutable
set
  search_path = '' as $$
  select
    case
      when (p_ctx ->> 'missing')::boolean then 'missing'
      when p_ctx ->> 'status' = 'canceled' then 'canceled'
      when (p_ctx ->> 'has_negative')::boolean then 'unresolved_refund'
      when (p_ctx ->> 'refund_count')::integer = 0 then null
      when p_total > 0
      and (p_ctx ->> 'refund_total')::numeric >= p_total then 'full_refund'
      else 'partial_refund'
    end;
$$;

comment on function app.disposition_class_of (jsonb, numeric) is 'Classifies an order from a disposition context and an order total. Private.';

revoke all on function app.disposition_class_of (jsonb, numeric)
from
  public,
  anon,
  authenticated,
  service_role;

-- The classification context of one cost input: refunds, the preparation
-- input (the latest non-empty snapshot) and its resolved quantities Q.
create function app.disposition_context (p_input_id bigint) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_in record;
  v_snap record;
  v_prep record;
  v_found boolean;
  v_ids bigint[];
  v_count integer;
  v_sum numeric;
  v_neg boolean;
  v_sig text;
  v_hash text := null;
  v_exact jsonb := null;
  v_res jsonb := null;
  v_status text := 'none';
  v_items jsonb := '[]'::jsonb;
  v_qsig text := null;
  v_base jsonb;
begin
  select
    i.*
  into v_in
  from
    app.pos_cost_inputs i
  where
    i.id = p_input_id;

  if not found then
    raise exception 'unknown cost input'
      using errcode = '22023';
  end if;

  select
    s.*
  into v_snap
  from
    app.pos_order_snapshots s
  where
    s.id = v_in.snapshot_id;

  select
    coalesce(
      pg_catalog.array_agg(
        r.id
        order by
          r.id
      ),
      '{}'::bigint[]
    ),
    count(*) filter (
      where
        r.amount > 0
    ),
    coalesce(
      sum(r.amount) filter (
        where
          r.amount > 0
      ),
      0
    ),
    coalesce(
      pg_catalog.bool_or(r.amount < 0),
      false
    ),
    pg_catalog.md5(
      coalesce(
        pg_catalog.string_agg(
          r.shift_id || '|' || r.tx_id || '|' || r.amount::text,
          ';'
          order by
            r.shift_id,
            r.tx_id
        ),
        ''
      )
    )
  into
    v_ids,
    v_count,
    v_sum,
    v_neg,
    v_sig
  from
    app.pos_refund_revisions r
  where
    r.id = any (v_in.refund_revision_ids)
    and r.tx_type = 3
    and r.present;

  select
    p.*
  into v_prep
  from
    app.pos_preparation_input (v_in.order_id) p;

  v_found := found;

  if v_found then
    v_hash := pg_catalog.md5(
      pg_catalog.concat_ws(
        '|',
        coalesce(v_prep.order_type, ''),
        app.costing_timestamptz_text (v_prep.ordered_at),
        (
          select
            coalesce(
              pg_catalog.string_agg(
                pg_catalog.concat_ws(
                  '~',
                  coalesce(l.value ->> 'line_id', ''),
                  coalesce(l.value ->> 'item_id', ''),
                  coalesce(l.value ->> 'item_name', ''),
                  coalesce(l.value ->> 'size_name', ''),
                  coalesce(l.value ->> 'quantity', ''),
                  coalesce(l.value ->> 'weighted_qty', ''),
                  coalesce(l.value ->> 'weighted_unit', ''),
                  coalesce((l.value -> 'options')::text, '')
                ),
                ';'
                order by
                  l.value ->> 'line_id',
                  l.value ->> 'item_id'
              ),
              ''
            )
          from
            pg_catalog.jsonb_array_elements(v_prep.lines) as l (value)
        )
      )
    );

    v_exact := app.resolve_order_snapshot_exact (v_prep.id, true, false);
    v_res := app.round_order_requirements (v_exact);

    if v_res ->> 'status' = 'ready' then
      v_status := 'ready';
      v_items := v_res -> 'requirements';
      v_qsig := pg_catalog.md5(
        coalesce(
          (
            select
              pg_catalog.string_agg(
                e.value ->> 'stock_item_id' || ':' || (e.value ->> 'quantity'),
                ','
                order by
                  e.value ->> 'stock_item_id'
              )
            from
              pg_catalog.jsonb_array_elements(v_items) as e (value)
          ),
          ''
        )
      );
    else
      v_status := 'incomplete';
    end if;
  end if;

  v_base := pg_catalog.jsonb_build_object(
    'missing',
    v_in.missing_from_pos,
    'status',
    v_snap.status,
    'has_negative',
    v_neg,
    'refund_count',
    v_count,
    'refund_total',
    v_sum::text,
    'order_total',
    v_snap.total::text
  );

  return v_base || pg_catalog.jsonb_build_object(
    'class',
    app.disposition_class_of (v_base, v_snap.total),
    'refund_ids',
    pg_catalog.to_jsonb(v_ids),
    'refund_signature',
    v_sig,
    'prep_snapshot_id',
    case
      when v_found then pg_catalog.to_jsonb(v_prep.id)
      else 'null'::jsonb
    end,
    'prep_hash',
    pg_catalog.to_jsonb(v_hash),
    'q_status',
    v_status,
    'q_items',
    v_items,
    'q_signature',
    pg_catalog.to_jsonb(v_qsig),
    'exact',
    coalesce(v_exact, 'null'::jsonb),
    'res',
    coalesce(v_res, 'null'::jsonb)
  );
end;
$$;

comment on function app.disposition_context (bigint) is 'Classification context of one cost input as jsonb: class by the snapshot total, linked refunds (qualifying count and sum, negative flag, ids, value signature over shift, tx and amount of every linked row), the preparation snapshot (latest non-empty) with a hash of its physical lines and its resolved quantities Q (q_status ready, incomplete or none), and the exact and rounded resolver results. Private.';

revoke all on function app.disposition_context (bigint)
from
  public,
  anon,
  authenticated,
  service_role;

-- The context a decision is judged against: while the linked refund set still
-- equals the one the event was made on, the class uses the event's frozen
-- total, so a total-only edit cannot widen or narrow the decision's scope.
create function app.disposition_effective_context (p_input_id bigint, p_event_id bigint) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_ctx jsonb;
  v_ev record;
  v_same boolean := false;
begin
  v_ctx := app.disposition_context (p_input_id);

  if p_event_id is not null then
    select
      e.refund_signature,
      e.order_total
    into v_ev
    from
      app.order_disposition_events e
    where
      e.id = p_event_id;

    if found
    and v_ev.refund_signature = v_ctx ->> 'refund_signature' then
      v_same := true;
      v_ctx := v_ctx || pg_catalog.jsonb_build_object(
        'class',
        app.disposition_class_of (v_ctx, v_ev.order_total)
      );
    end if;
  end if;

  return v_ctx || pg_catalog.jsonb_build_object('sig_same', v_same);
end;
$$;

comment on function app.disposition_effective_context (bigint, bigint) is 'disposition_context with the class recomputed on the event''s frozen order total when the refund value signature is unchanged. sig_said true when it is. Private.';

revoke all on function app.disposition_effective_context (bigint, bigint)
from
  public,
  anon,
  authenticated,
  service_role;

-- Optimistic token: classification, preparation basis hash and quantities,
-- the linked refund revision set, and the decision it would replace.
create function app.disposition_token (p_ctx jsonb, p_event_id bigint) returns text language sql immutable
set
  search_path = '' as $$
  select
    pg_catalog.md5(
      pg_catalog.concat_ws(
        '|',
        coalesce(p_ctx ->> 'class', '-'),
        coalesce(p_ctx ->> 'prep_hash', ''),
        coalesce(p_ctx ->> 'q_status', ''),
        coalesce(p_ctx ->> 'q_signature', ''),
        coalesce(p_ctx -> 'refund_ids', '[]'::jsonb)::text,
        coalesce(p_event_id::text, '')
      )
    );
$$;

comment on function app.disposition_token (jsonb, bigint) is 'md5 of class, preparation hash, quantity status and signature, refund revision ids and the prior event id. Private.';

revoke all on function app.disposition_token (jsonb, bigint)
from
  public,
  anon,
  authenticated,
  service_role;

-- Exact differences caused by one retire batch and one posting batch.
create function app.disposition_effect (p_retire uuid, p_post uuid) returns table (
  stock_qty_delta numeric,
  stock_value_delta numeric,
  cogs_cost_delta numeric,
  waste_cost_delta numeric,
  profit_delta numeric
) language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      (
        select
          sum(sm.quantity)
        from
          app.stock_movements sm
        where
          sm.batch_id in (p_retire, p_post)
      ),
      0
    ),
    coalesce(
      (
        select
          sum(sm.total_cost)
        from
          app.stock_movements sm
        where
          sm.batch_id in (p_retire, p_post)
      ),
      0
    ),
    - coalesce(
      (
        select
          sum(pr.amount)
        from
          app.period_revisions pr
        where
          pr.cause_batch_id in (p_retire, p_post)
          and pr.bucket = 'cogs'
      ),
      0
    ),
    - coalesce(
      (
        select
          sum(pr.amount)
        from
          app.period_revisions pr
        where
          pr.cause_batch_id in (p_retire, p_post)
          and pr.bucket = 'waste'
      ),
      0
    ),
    coalesce(
      (
        select
          sum(pr.amount)
        from
          app.period_revisions pr
        where
          pr.cause_batch_id in (p_retire, p_post)
          and pr.bucket in ('cogs', 'waste', 'count')
      ),
      0
    );
$$;

comment on function app.disposition_effect (uuid, uuid) is 'Stock quantity and value (sums over the movements of the two batches), cogs and waste cost change (negated ledger-sign revision sums) and profit (ledger-sign sum of cogs, waste and count revisions). Private.';

revoke all on function app.disposition_effect (uuid, uuid)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 5. Coordinator. Replaces process_order_accounting from
-- 20261108040000_order_deduction_engine.sql.
-- ============================================================================
create or replace function app.process_order_accounting (
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
  v_needs boolean;
  v_ds record;
  v_ev app.order_disposition_events%rowtype;
  v_ctx jsonb;
  v_path text := 'ordinary';
  v_target text := 'sale';
  v_open boolean := false;
  v_alloc boolean := false;
  v_review text;
  v_kept jsonb;
  v_over boolean;
  v_episode integer;
  v_eff record;
  v_move text;
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

  -- Does this order take part in a decision episode?
  v_needs := v_input.missing_from_pos
  or v_snap.status = 'canceled'
  or coalesce(pg_catalog.cardinality (v_input.refund_revision_ids), 0) > 0;

  select
    ds.*
  into v_ds
  from
    app.order_disposition_state ds
  where
    ds.order_id = p_order_id;

  if v_snap.ordered_at < v_start then
    v_path := 'before_start';
  elsif v_needs
  or coalesce(v_ds.is_open, false) then
    insert into
      app.order_disposition_state (order_id)
    values
      (p_order_id)
    on conflict (order_id) do nothing;

    select
      ds.*
    into v_ds
    from
      app.order_disposition_state ds
    where
      ds.order_id = p_order_id
    for update;

    if v_ds.is_open then
      select
        e.*
      into v_ev
      from
        app.order_disposition_events e
      where
        e.id = v_ds.event_id;
    end if;

    v_ctx := app.disposition_effective_context (v_input.id, v_ev.id);

    if v_ev.id is not null then
      if v_ctx ->> 'class' is null
      and v_ev.class in ('canceled', 'missing', 'none') then
        -- The order is an ordinary sale again; the history stays.
        update app.order_disposition_state ds
        set
          is_open = false,
          class = null,
          review_reason = null,
          cost_input_id = v_input.id,
          context = v_ctx - 'exact' - 'res',
          token = null,
          updated_at = v_now
        where
          ds.order_id = p_order_id;
      else
        v_alloc := v_ev.decision = 'not_made'
        and app.disposition_family (v_ctx ->> 'class') = 'partial'
        and pg_catalog.jsonb_array_length(v_ev.returned) > 0;

        if v_ctx ->> 'refund_signature' is distinct from v_ev.refund_signature then
          v_review := 'refund_changed';
        elsif app.disposition_family (v_ctx ->> 'class') is distinct from app.disposition_family (v_ev.class) then
          v_review := 'class_changed';
        elsif v_alloc then
          if v_ctx ->> 'q_status' is distinct from 'ready' then
            v_review := 'items_changed';
          elsif v_ctx ->> 'q_signature' is distinct from v_ev.q_signature then
            v_review := case
              when (
                select
                  pg_catalog.array_agg(
                    e.value ->> 'stock_item_id'
                    order by
                      e.value ->> 'stock_item_id'
                  )
                from
                  pg_catalog.jsonb_array_elements(v_ctx -> 'q_items') as e (value)
              ) is distinct from (
                select
                  pg_catalog.array_agg(
                    e.value ->> 'stock_item_id'
                    order by
                      e.value ->> 'stock_item_id'
                  )
                from
                  pg_catalog.jsonb_array_elements(v_ev.q_items) as e (value)
              ) then 'items_changed'
              else 'quantities_changed'
            end;
          end if;
        end if;

        if v_review is not null then
          -- The application and the allocation stay in force.
          update app.order_disposition_state ds
          set
            class = v_ctx ->> 'class',
            review_reason = v_review,
            cost_input_id = v_input.id,
            context = v_ctx - 'exact' - 'res',
            token = app.disposition_token (v_ctx, v_ev.id),
            updated_at = v_now
          where
            ds.order_id = p_order_id;

          update app.order_cost_state h
          set
            latest_input_id = v_input.id,
            causes = pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'code',
                'disposition_pending',
                'reason',
                'needs_review',
                'detail',
                v_review
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
            'needs_review',
            'review_reason',
            v_review
          );
        end if;

        v_open := true;
        v_path := case
          when app.disposition_family (v_ev.class) = 'terminal'
          and v_ev.decision = 'made' then 'waste'
          when app.disposition_family (v_ev.class) = 'terminal' then 'not_made'
          else 'ordinary'
        end;
      end if;
    elsif v_ctx ->> 'class' is not null then
      v_episode := v_ds.episode + 1;

      insert into
        app.order_disposition_events (
          order_id,
          episode,
          decision,
          class,
          source,
          owner_reviewed,
          actor,
          reason,
          prior_event_id,
          cost_input_id,
          prep_snapshot_id,
          prep_hash,
          q_items,
          q_signature,
          refund_revision_ids,
          refund_signature,
          order_total,
          refund_total,
          returned
        )
      values
        (
          p_order_id,
          v_episode,
          'made',
          v_ctx ->> 'class',
          'system_default',
          false,
          null,
          null,
          null,
          v_input.id,
          (v_ctx ->> 'prep_snapshot_id')::bigint,
          v_ctx ->> 'prep_hash',
          v_ctx -> 'q_items',
          v_ctx ->> 'q_signature',
          v_input.refund_revision_ids,
          v_ctx ->> 'refund_signature',
          (v_ctx ->> 'order_total')::numeric,
          (v_ctx ->> 'refund_total')::numeric,
          '[]'::jsonb
        )
      returning
        * into v_ev;

      update app.order_disposition_state ds
      set
        episode = v_episode,
        is_open = true,
        event_id = v_ev.id,
        class = v_ctx ->> 'class',
        review_reason = null,
        cost_input_id = v_input.id
      where
        ds.order_id = p_order_id;

      v_ctx := v_ctx || pg_catalog.jsonb_build_object('sig_same', true);
      v_open := true;
      v_path := case
        when app.disposition_family (v_ev.class) = 'terminal' then 'waste'
        else 'ordinary'
      end;
    end if;
  end if;

  -- Desired state, in this order.
  if v_path = 'before_start' then
    v_disposition := 'none';
    v_reason := 'before_stock_start';
    v_causes := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('code', v_reason)
    );
  elsif v_path = 'not_made' then
    v_disposition := 'none';
    v_reason := 'not_made';
    v_causes := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('code', v_reason)
    );
  elsif v_path = 'waste' then
    v_target := 'prepared_waste';

    if v_ctx ->> 'q_status' = 'none' then
      v_disposition := 'incomplete';
      v_reason := 'missing_preparation_basis';
      v_causes := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('code', v_reason)
      );
    else
      v_exact := v_ctx -> 'exact';
      v_res := v_ctx -> 'res';
    end if;
  elsif v_snap.status = 'active' then
    v_disposition := 'none';
    v_reason := 'open';
    v_causes := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('code', v_reason)
    );
  else
    v_exact := app.resolve_order_snapshot_exact (v_snap.id, false, false);
    v_res := app.round_order_requirements (v_exact);
  end if;

  if v_disposition is null then
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
          v_disposition := v_target;
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

  -- Not made, partly returned: the kept quantities are the preparation
  -- quantities less the returned ones, per stock item. Never a money ratio.
  if v_disposition = 'sale'
  and v_alloc then
    if exists (
      select
        1
      from
        pg_catalog.jsonb_array_elements(v_ev.returned) as r (value)
      where
        not exists (
          select
            1
          from
            pg_catalog.jsonb_array_elements(v_reqs) as q (value)
          where
            q.value ->> 'stock_item_id' = r.value ->> 'stock_item_id'
        )
    ) then
      raise exception 'returned item is not in the preparation basis'
        using errcode = '55000';
    end if;

    select
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          k.item,
          'base_unit',
          k.unit,
          'quantity',
          pg_catalog.trim_scale(k.kept)::text
        )
        order by
          k.item
      ) filter (
        where
          k.kept > 0
      ),
      coalesce(
        pg_catalog.bool_or(k.kept < 0),
        false
      )
    into
      v_kept,
      v_over
    from
      (
        select
          e.value ->> 'stock_item_id' as item,
          e.value ->> 'base_unit' as unit,
          (e.value ->> 'quantity')::numeric - coalesce(r.ret, 0) as kept
        from
          pg_catalog.jsonb_array_elements(v_reqs) as e (value)
          left join (
            select
              x.value ->> 'stock_item_id' as item,
              (x.value ->> 'returned')::numeric as ret
            from
              pg_catalog.jsonb_array_elements(v_ev.returned) as x (value)
          ) r on r.item = e.value ->> 'stock_item_id'
      ) k;

    if v_over then
      raise exception 'returned quantity exceeds the preparation basis'
        using errcode = '55000';
    end if;

    if v_kept is null then
      v_disposition := 'none';
      v_reason := 'returned_all';
      v_causes := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('code', v_reason)
      );
      v_reqs := null;
    else
      v_reqs := v_kept;
    end if;
  end if;

  if v_disposition in ('sale', 'prepared_waste') then
    v_sig := pg_catalog.md5(
      pg_catalog.concat_ws(
        '|',
        v_disposition,
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
  -- The order's own position, kept across incomplete and canceled spells.
  v_event := v_head.event_position;

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

      if v_disposition in ('sale', 'prepared_waste') then
        if v_event is null then
          v_event := pg_catalog.nextval(
            pg_catalog.pg_get_serial_sequence('app.stock_movements', 'id')
          );
        end if;

        v_move := case v_disposition
          when 'sale' then 'sale'
          else 'waste'
        end;

        select
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'item_id',
              e.value ->> 'stock_item_id',
              'movement_type',
              v_move,
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
        when v_disposition in ('sale', 'prepared_waste') then v_id
        else null
      end,
      case
        when v_disposition in ('sale', 'prepared_waste') then v_snap.ordered_at
        else null
      end,
      case
        when v_disposition in ('sale', 'prepared_waste') then v_snap.shift_id
        else null
      end,
      case
        when v_disposition in ('sale', 'prepared_waste') then v_event
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
      and sm.movement_type in ('sale', 'waste');

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
      when v_disposition in ('sale', 'prepared_waste') then v_id
      else null
    end,
    disposition = v_disposition,
    signature = v_sig,
    causes = v_causes,
    event_position = coalesce(h.event_position, v_event),
    evaluated_at = v_now,
    updated_at = v_now
  where
    h.order_id = p_order_id;

  if v_open then
    -- A default that keeps the sale is the baseline, not a difference.
    if v_kind = 'posting'
    and not (
      v_ev.source = 'system_default'
      and v_disposition = 'sale'
    ) then
      select
        *
      into v_eff
      from
        app.disposition_effect (v_retire_batch, v_batch);

      insert into
        app.order_disposition_applications (
          application_id,
          event_id,
          order_id,
          stock_qty_delta,
          stock_value_delta,
          cogs_cost_delta,
          waste_cost_delta,
          profit_delta
        )
      values
        (
          v_id,
          v_ev.id,
          p_order_id,
          v_eff.stock_qty_delta,
          v_eff.stock_value_delta,
          v_eff.cogs_cost_delta,
          v_eff.waste_cost_delta,
          v_eff.profit_delta
        );
    end if;

    update app.order_disposition_state ds
    set
      class = v_ctx ->> 'class',
      review_reason = case
        when v_ctx ->> 'class' = 'unresolved_refund' then 'unresolved_refund'
        else null
      end,
      cost_input_id = v_input.id,
      context = v_ctx - 'exact' - 'res',
      token = app.disposition_token (v_ctx, v_ev.id),
      updated_at = v_now
    where
      ds.order_id = p_order_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome',
    case
      when v_disposition in ('sale', 'prepared_waste')
      and v_kind = 'posting' then 'applied'
      when v_disposition in ('sale', 'prepared_waste') then 'unchanged'
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

comment on function app.process_order_accounting (text, uuid, integer) is 'Evaluates one order against its latest cost input and brings its stock effect to the desired state: retire every movement of the previous application, then post the replacement at the snapshot instant and shift, or record an incomplete or none result. An identical economic signature writes an evaluation receipt only. missing_cost_basis rolls the transition back and returns blocked. Canceled, missing and refunded orders open a decision episode with a system default (made) the first time they appear: canceled, missing and fully refunded orders post prepared waste of the preparation basis when made and nothing when not made; a partial refund stays a sale, and when not made it posts the kept quantities (preparation quantities less the returned ones). Missing takes precedence over the underlying status. A change of the linked refund set, of the class family, or (for a returned allocation) of the preparation quantities leaves the application and allocation in force and returns disposition_pending for an owner decision. Without an episode the path is the PR 4 path. A sale or waste takes its same-instant event position once, from order_cost_state.event_position. Caller holds the ledger lock. Private.';

revoke all on function app.process_order_accounting (text, uuid, integer)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 6. Inline worker step for the owner RPC. The same claim, run and complete
-- steps as run_accounting_work for one named order, without its error
-- swallowing: an error rolls back the whole owner call.
-- ============================================================================
create function app.apply_decision_work (p_order_id text) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_new boolean;
  v_gen integer;
  v_attempt uuid := pg_catalog.gen_random_uuid ();
  v_result jsonb;
  v_blocked uuid[];
begin
  perform app.assert_ledger_lock_held ();

  select
    pe.has_new,
    pe.eff_generation
  into
    v_new,
    v_gen
  from
    app.accounting_order_pending (p_order_id) pe;

  if v_gen is null then
    raise exception 'no pending accounting work for the order'
      using errcode = '55000';
  end if;

  if v_new then
    update app.accounting_work_events e
    set
      work_generation = v_gen
    where
      e.order_id = p_order_id
      and e.work_generation is null;

    update app.accounting_work_state ws
    set
      work_generation = v_gen,
      attempts = 0,
      failed_at = null,
      updated_at = pg_catalog.clock_timestamp ()
    where
      ws.order_id = p_order_id;
  end if;

  v_result := app.process_order_accounting (p_order_id, v_attempt, v_gen);

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
    updated_at = pg_catalog.clock_timestamp ()
  where
    ws.order_id = p_order_id;

  update app.accounting_work_events e
  set
    processed_at = pg_catalog.clock_timestamp ()
  where
    e.order_id = p_order_id
    and e.work_generation is not null
    and e.work_generation <= v_gen
    and e.processed_at is null;

  insert into
    app.accounting_work_completions (
      attempt_id,
      order_id,
      work_generation,
      outcome,
      application_id
    )
  values
    (
      v_attempt,
      p_order_id,
      v_gen,
      v_result ->> 'outcome',
      (v_result ->> 'application_id')::bigint
    );

  return v_result;
end;
$$;

comment on function app.apply_decision_work (text) is 'Claims the order''s unclaimed work events into the next generation, runs process_order_accounting once, and marks the events processed with a completion row, as run_accounting_work does for a named order. Errors propagate. Caller holds the ledger lock and the order''s work, cost and decision rows. Private.';

revoke all on function app.apply_decision_work (text)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 7. Owner RPC.
-- Lock order, as the worker: ledger advisory lock, pos_sync_runs SHARE (a
-- running sync is 55P03, retry with the same request id), pos_shifts SHARE,
-- work state, cost state, decision state by order id, then balances inside
-- the posting functions.
-- ============================================================================
create function app.set_order_disposition (
  p_request_id uuid,
  p_order_id text,
  p_decision text,
  p_token text,
  p_reason text,
  p_returned jsonb
) returns jsonb language plpgsql volatile security definer
set
  search_path = ''
set
  lock_timeout = '2s'
set
  statement_timeout = '15s' as $$
declare
  v_reason text;
  v_ret jsonb := null;
  v_hash text;
  v_req record;
  v_ds record;
  v_ev app.order_disposition_events%rowtype;
  v_input record;
  v_ctx jsonb;
  v_class text;
  v_r jsonb;
  v_applicable boolean;
  v_total numeric;
  v_new bigint;
  v_work jsonb;
  v_diff record;
  v_result jsonb;
  v_elem jsonb;
  v_seen text[] := '{}'::text[];
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_request_id is null
  or p_order_id is null
  or pg_catalog.btrim (p_order_id) = ''
  or p_decision is null
  or p_decision not in ('made', 'not_made')
  or p_token is null
  or pg_catalog.btrim (p_token) = '' then
    raise exception 'invalid decision request'
      using errcode = '22023';
  end if;

  v_reason := nullif(pg_catalog.btrim (p_reason), '');

  if v_reason is not null
  and length(v_reason) > 300 then
    raise exception 'reason is longer than 300 characters'
      using errcode = '22023';
  end if;

  if p_returned is not null then
    if pg_catalog.jsonb_typeof (p_returned) <> 'array' then
      raise exception 'returned quantities must be an array'
        using errcode = '22023';
    end if;

    for v_elem in
      select
        e.value
      from
        pg_catalog.jsonb_array_elements(p_returned) as e (value)
    loop
      if pg_catalog.jsonb_typeof (v_elem) <> 'object'
      or pg_catalog.jsonb_typeof (v_elem -> 'stock_item_id') is distinct from 'string'
      or pg_catalog.jsonb_typeof (v_elem -> 'returned') is distinct from 'string'
      or (
        select
          count(*)
        from
          pg_catalog.jsonb_object_keys(v_elem)
      ) <> 2
      or v_elem ->> 'stock_item_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or v_elem ->> 'returned' !~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' then
        raise exception 'each returned quantity is {stock_item_id, returned} with decimal text'
          using errcode = '22023';
      end if;

      if (v_elem ->> 'stock_item_id') = any (v_seen) then
        raise exception 'a stock item is listed twice'
          using errcode = '22023';
      end if;

      v_seen := v_seen || (v_elem ->> 'stock_item_id');
    end loop;

    select
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'stock_item_id',
            x.item,
            'returned',
            pg_catalog.trim_scale(x.ret)::text
          )
          order by
            x.item
        ) filter (
          where
            x.ret > 0
        ),
        '[]'::jsonb
      )
    into v_ret
    from
      (
        select
          e.value ->> 'stock_item_id' as item,
          (e.value ->> 'returned')::numeric as ret
        from
          pg_catalog.jsonb_array_elements(p_returned) as e (value)
      ) x;
  end if;

  v_hash := pg_catalog.md5(
    pg_catalog.concat_ws(
      '|',
      p_order_id,
      p_decision,
      pg_catalog.btrim (p_token),
      coalesce(v_reason, ''),
      coalesce(v_ret::text, 'carry')
    )
  );

  -- Replay: the stored result, before any mutable state is read.
  select
    r.*
  into v_req
  from
    app.order_disposition_requests r
  where
    r.request_id = p_request_id;

  if found then
    if v_req.payload_hash <> v_hash then
      raise exception 'request id was used for a different decision'
        using errcode = '22023';
    end if;

    return v_req.result;
  end if;

  if not exists (
    select
      1
    from
      app.inventory_activation
  ) then
    return pg_catalog.jsonb_build_object('status', 'not_activated');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  select
    r.*
  into v_req
  from
    app.order_disposition_requests r
  where
    r.request_id = p_request_id;

  if found then
    if v_req.payload_hash <> v_hash then
      raise exception 'request id was used for a different decision'
        using errcode = '22023';
    end if;

    return v_req.result;
  end if;

  lock table app.pos_sync_runs in share mode;

  if exists (
    select
      1
    from
      app.pos_sync_runs r
    where
      r.status = 'running'
  ) then
    raise exception 'a POS sync is running'
      using errcode = '55P03';
  end if;

  lock table app.pos_shifts in share mode;

  select
    ds.*
  into v_ds
  from
    app.order_disposition_state ds
  where
    ds.order_id = p_order_id;

  if not found
  or not v_ds.is_open then
    raise exception 'the order has no open decision'
      using errcode = '22023';
  end if;

  insert into
    app.accounting_work_state (order_id)
  values
    (p_order_id)
  on conflict (order_id) do nothing;

  insert into
    app.order_cost_state (order_id)
  values
    (p_order_id)
  on conflict (order_id) do nothing;

  perform 1
  from
    app.accounting_work_state ws
  where
    ws.order_id = p_order_id
  for update;

  perform 1
  from
    app.order_cost_state h
  where
    h.order_id = p_order_id
  for update;

  select
    ds.*
  into v_ds
  from
    app.order_disposition_state ds
  where
    ds.order_id = p_order_id
  for update;

  select
    e.*
  into v_ev
  from
    app.order_disposition_events e
  where
    e.id = v_ds.event_id;

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

  v_ctx := app.disposition_effective_context (v_input.id, v_ev.id);

  if app.disposition_token (v_ctx, v_ev.id) <> pg_catalog.btrim (p_token) then
    raise exception 'the order changed since it was loaded'
      using errcode = '40001';
  end if;

  v_class := v_ctx ->> 'class';

  if v_class = 'unresolved_refund' then
    raise exception 'a refund with a negative amount must be corrected first'
      using errcode = '22023';
  end if;

  if v_class is null
  and p_decision <> 'made' then
    raise exception 'an order with no cancel or refund can only be confirmed as made'
      using errcode = '22023';
  end if;

  if p_decision <> v_ev.decision
  and v_reason is null then
    raise exception 'a reason is required to change a decision'
      using errcode = '22023';
  end if;

  v_applicable := p_decision = 'not_made'
  and v_class = 'partial_refund';

  if v_ret is not null
  and pg_catalog.jsonb_array_length(v_ret) > 0
  and not v_applicable then
    raise exception 'returned quantities apply only to a not-made partial refund'
      using errcode = '22023';
  end if;

  v_r := coalesce(v_ret, v_ev.returned);

  if v_applicable
  and pg_catalog.jsonb_array_length(v_r) > 0 then
    if v_ctx ->> 'q_status' <> 'ready' then
      raise exception 'the preparation basis is not available'
        using errcode = '22023';
    end if;

    if exists (
      select
        1
      from
        pg_catalog.jsonb_array_elements(v_r) as r (value)
      where
        not exists (
          select
            1
          from
            pg_catalog.jsonb_array_elements(v_ctx -> 'q_items') as q (value)
          where
            q.value ->> 'stock_item_id' = r.value ->> 'stock_item_id'
            and (r.value ->> 'returned')::numeric <= (q.value ->> 'quantity')::numeric
        )
    ) then
      raise exception 'returned quantities must be listed items and not exceed the prepared quantities'
        using errcode = '22023';
    end if;
  end if;

  v_total := case
    when (v_ctx ->> 'sig_same')::boolean then v_ev.order_total
    else (v_ctx ->> 'order_total')::numeric
  end;

  insert into
    app.order_disposition_events (
      order_id,
      episode,
      decision,
      class,
      source,
      owner_reviewed,
      actor,
      reason,
      prior_event_id,
      cost_input_id,
      prep_snapshot_id,
      prep_hash,
      q_items,
      q_signature,
      refund_revision_ids,
      refund_signature,
      order_total,
      refund_total,
      returned
    )
  values
    (
      p_order_id,
      v_ds.episode,
      p_decision,
      coalesce(v_class, 'none'),
      'owner',
      true,
      auth.uid (),
      v_reason,
      v_ev.id,
      v_input.id,
      (v_ctx ->> 'prep_snapshot_id')::bigint,
      v_ctx ->> 'prep_hash',
      v_ctx -> 'q_items',
      v_ctx ->> 'q_signature',
      v_input.refund_revision_ids,
      v_ctx ->> 'refund_signature',
      v_total,
      (v_ctx ->> 'refund_total')::numeric,
      v_r
    )
  returning
    id into v_new;

  update app.order_disposition_state ds
  set
    event_id = v_new,
    is_open = v_class is not null,
    class = v_class,
    review_reason = null,
    cost_input_id = v_input.id,
    context = v_ctx - 'exact' - 'res',
    token = case
      when v_class is null then null
      else app.disposition_token (v_ctx, v_new)
    end,
    updated_at = pg_catalog.clock_timestamp ()
  where
    ds.order_id = p_order_id;

  insert into
    app.accounting_work_events (order_id, cause, source_key, cost_input_id)
  values
    (
      p_order_id,
      'decision',
      'decision:' || v_new::text,
      v_input.id
    );

  v_work := app.apply_decision_work (p_order_id);

  select
    coalesce(sum(a.stock_qty_delta), 0) as qty,
    coalesce(sum(a.stock_value_delta), 0)::numeric(14, 2) as val,
    coalesce(sum(a.cogs_cost_delta), 0)::numeric(14, 2) as cogs,
    coalesce(sum(a.waste_cost_delta), 0)::numeric(14, 2) as waste,
    coalesce(sum(a.profit_delta), 0)::numeric(14, 2) as profit
  into v_diff
  from
    app.order_disposition_applications a
  where
    a.event_id = v_new;

  v_result := pg_catalog.jsonb_build_object(
    'status',
    'ok',
    'order_id',
    p_order_id,
    'event_id',
    v_new,
    'decision',
    p_decision,
    'class',
    coalesce(v_class, 'none'),
    'outcome',
    v_work ->> 'outcome',
    'reason',
    v_work ->> 'reason',
    'differences',
    pg_catalog.jsonb_build_object(
      'stock_quantity',
      pg_catalog.trim_scale(v_diff.qty)::text,
      'stock_value',
      v_diff.val::text,
      'cogs',
      v_diff.cogs::text,
      'waste',
      v_diff.waste::text,
      'profit',
      v_diff.profit::text
    )
  );

  insert into
    app.order_disposition_requests (request_id, order_id, payload_hash, event_id, result)
  values
    (p_request_id, p_order_id, v_hash, v_new, v_result);

  return v_result;
end;
$$;

comment on function app.set_order_disposition (uuid, text, text, text, text, jsonb) is 'Owner only. Records the owner''s made or not_made decision for the order''s open episode and applies it, in one transaction under the ledger lock, with the worker''s lock order. p_token is the order_decision_queue token; a changed order is 40001. A flip (a decision different from the prior one) needs a non-blank reason of at most 300 characters. p_returned replaces the cumulative returned quantities ([{stock_item_id, returned}], decimal text, only for a not-made partial refund); null keeps the prior ones. The request id makes the call idempotent: the same payload returns the stored result, a different payload is 22023. An unresolved refund (a negative amount) cannot be decided. Returns not_activated, without writing, before inventory activation. A running POS sync is 55P03 and the call can be retried with the same request id. Returns the outcome and the exact resulting differences as decimal text.';

revoke all on function app.set_order_disposition (uuid, text, text, text, text, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.set_order_disposition (uuid, text, text, text, text, jsonb) to authenticated;

-- ============================================================================
-- 8. Read side. security_invoker views, so the owner-only RLS of the base
-- tables applies. One row per order with an open episode, keyed by order id
-- (text, unique, never changes) for keyset reads. Quantities and money are
-- decimal text. Empty before activation.
-- ============================================================================
create view app.order_decision_queue
with
  (security_invoker = true) as
select
  st.order_id,
  st.episode,
  st.class as current_class,
  ev.class as decided_class,
  st.review_reason,
  st.token,
  (
    not ev.owner_reviewed
    or st.review_reason is not null
  ) as needs_decision,
  ev.id as event_id,
  ev.decision,
  ev.source,
  ev.owner_reviewed,
  ev.reason as decision_reason,
  ev.created_at as decided_at,
  snap.order_number,
  snap.ordered_at,
  snap.status as order_status,
  inp.missing_from_pos,
  snap.total::text as order_total,
  ev.order_total::text as decided_order_total,
  (st.context ->> 'refund_total') as refund_total,
  ev.refund_total::text as decided_refund_total,
  (st.context ->> 'q_status') as basis_status,
  coalesce(bs.items, '[]'::jsonb) as basis_items,
  coalesce(rf.refunds, '[]'::jsonb) as refunds,
  ev.returned,
  pg_catalog.jsonb_build_object (
    'stock_quantity',
    pg_catalog.trim_scale (coalesce(df.qty, 0))::text,
    'stock_value',
    coalesce(df.val, 0)::numeric(14, 2)::text,
    'cogs',
    coalesce(df.cogs, 0)::numeric(14, 2)::text,
    'waste',
    coalesce(df.waste, 0)::numeric(14, 2)::text,
    'profit',
    coalesce(df.profit, 0)::numeric(14, 2)::text
  ) as differences,
  coalesce(hs.history, '[]'::jsonb) as history
from
  app.order_disposition_state st
  join app.order_disposition_events ev on ev.id = st.event_id
  join app.pos_cost_inputs inp on inp.id = st.cost_input_id
  join app.pos_order_snapshots snap on snap.id = inp.snapshot_id
  left join lateral (
    select
      pg_catalog.jsonb_agg (
        pg_catalog.jsonb_build_object (
          'stock_item_id',
          q.value ->> 'stock_item_id',
          'name',
          si.name,
          'base_unit',
          si.base_unit,
          'quantity',
          q.value ->> 'quantity'
        )
        order by
          si.name,
          q.value ->> 'stock_item_id'
      ) as items
    from
      pg_catalog.jsonb_array_elements (st.context -> 'q_items') as q (value)
      left join app.stock_items si on si.id = (q.value ->> 'stock_item_id')::uuid
  ) bs on true
  left join lateral (
    select
      pg_catalog.jsonb_agg (
        pg_catalog.jsonb_build_object (
          'shift_id',
          r.shift_id,
          'tx_id',
          r.tx_id,
          'amount',
          r.amount::text,
          'occurred_at',
          r.occurred_at
        )
        order by
          r.shift_id,
          r.tx_id
      ) as refunds
    from
      app.pos_refund_revisions r
    where
      r.id = any (inp.refund_revision_ids)
  ) rf on true
  left join lateral (
    select
      sum(a.stock_qty_delta) as qty,
      sum(a.stock_value_delta) as val,
      sum(a.cogs_cost_delta) as cogs,
      sum(a.waste_cost_delta) as waste,
      sum(a.profit_delta) as profit
    from
      app.order_disposition_applications a
    where
      a.event_id = ev.id
  ) df on true
  left join lateral (
    select
      pg_catalog.jsonb_agg (
        pg_catalog.jsonb_build_object (
          'event_id',
          h.id,
          'episode',
          h.episode,
          'decision',
          h.decision,
          'class',
          h.class,
          'source',
          h.source,
          'owner_reviewed',
          h.owner_reviewed,
          'reason',
          h.reason,
          'created_at',
          h.created_at,
          'returned',
          h.returned,
          'differences',
          (
            select
              pg_catalog.jsonb_build_object (
                'stock_quantity',
                pg_catalog.trim_scale (coalesce(sum(a.stock_qty_delta), 0))::text,
                'stock_value',
                coalesce(sum(a.stock_value_delta), 0)::numeric(14, 2)::text,
                'cogs',
                coalesce(sum(a.cogs_cost_delta), 0)::numeric(14, 2)::text,
                'waste',
                coalesce(sum(a.waste_cost_delta), 0)::numeric(14, 2)::text,
                'profit',
                coalesce(sum(a.profit_delta), 0)::numeric(14, 2)::text
              )
            from
              app.order_disposition_applications a
            where
              a.event_id = h.id
          )
        )
        order by
          h.id desc
      ) as history
    from
      app.order_disposition_events h
    where
      h.order_id = st.order_id
  ) hs on true
where
  st.is_open;

comment on view app.order_decision_queue is 'One row per order with an open cancel, missing or refund episode: the current decision (default or owner reviewed), the preparation basis, the linked refund references, the review reason when the owner must decide again (needs_decision is true for an unreviewed default or a review reason), the exact differences of the current decision and the audit history. token is the optimistic token for set_order_disposition. security_invoker so owner-only RLS applies. Keyset by order_id. Quantities and money are decimal text.';

revoke all on table app.order_decision_queue
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.order_decision_queue to authenticated,
  service_role;

-- A refund transaction that names no order cannot be attributed. It is
-- listed so it is not forgotten; no decision applies to it.
create view app.unlinked_refunds
with
  (security_invoker = true) as
select
  latest.shift_id,
  latest.tx_id,
  latest.amount::text as amount,
  latest.occurred_at
from
  (
    select distinct
      on (r.shift_id, r.tx_id) r.shift_id,
      r.tx_id,
      r.order_id,
      r.tx_type,
      r.amount,
      r.occurred_at,
      r.present
    from
      app.pos_refund_revisions r
    order by
      r.shift_id,
      r.tx_id,
      r.id desc
  ) latest
where
  latest.present
  and latest.tx_type = 3
  and latest.order_id is null;

comment on view app.unlinked_refunds is 'Present type-3 shift transactions that name no order: an unresolved attribution. Keyset by (shift_id, tx_id). security_invoker so owner-only RLS applies.';

revoke all on table app.unlinked_refunds
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.unlinked_refunds to authenticated,
  service_role;
