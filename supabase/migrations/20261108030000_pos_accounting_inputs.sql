-- Immutable POS accounting inputs (phase 5, PR 3).
--
-- Sync still posts no stock and does not take the ledger posting lock.
-- Nothing here deducts stock. The tables are the preparation input for a
-- later worker: one accounting snapshot per accepted order version, one
-- refund revision per real change of (shift_id, tx_id), one local cost input
-- per changed digest, and one coverage row per successful sync finish.
--
-- Snapshot capture is explicit inside ingest_pos_batch, after
-- replace_pos_order_lines. The version column is updated before the lines
-- are replaced, so a trigger on the order row would store the new version
-- with the previous lines. Triggers on these new tables only guard
-- append-only writes. They do not capture.
--
-- Replaced functions, each from its latest definition:
--   app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)
--                                        base 20261021000000_pos_refunds_drawer.sql
--   app.finish_pos_sync_run(bigint,text,jsonb,text)
--                                        base 20261016040000_pos_sales.sql
--   app.record_count(jsonb)              base 20261022010000_counts.sql
-- ============================================================================
-- 0. Lock order. The ledger advisory lock is first, then pos_sync_runs in
-- ACCESS EXCLUSIVE mode NOWAIT, then the other POS tables this migration
-- backfills, NOWAIT, in a fixed order.
--
-- Ingest at runtime does not take the advisory lock. Its first statement is
-- a FOR UPDATE on its pos_sync_runs row, which holds ROW SHARE on the table
-- until commit, and it writes that row again later. A weaker lock here
-- (SHARE ROW EXCLUSIVE admits ROW SHARE) would let this migration lock first
-- and then wait in ALTER TABLE for that ingest while the ingest's later
-- write waits for this migration: a deadlock, resolved after
-- deadlock_timeout, while the ledger lock is held. ACCESS EXCLUSIVE NOWAIT
-- conflicts with that ROW SHARE, so a running sync fails the migration at
-- once with 55P03. Once held, no sync statement can start, and every sync
-- transaction reaches pos_sync_runs before any other POS table, so the
-- remaining NOWAIT locks cannot wait on a sync either. The advisory lock
-- stays first because record_count takes it before it reads pos_sync_runs.
-- ============================================================================
select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

do $lock_tables$
begin
  lock table app.pos_sync_runs in access exclusive mode nowait;

  lock table app.pos_sync_run_orders,
  app.pos_shifts,
  app.pos_shift_transactions,
  app.pos_orders,
  app.pos_order_lines in share row exclusive mode nowait;
end;
$lock_tables$;

-- ============================================================================
-- 1. Scope facts the run accumulates. Coverage is written only when the run
-- finishes ok, because a failed finish must not leave a coverage row and the
-- coverage table is append-only.
-- ============================================================================
alter table app.pos_sync_runs
add column scope_kind text null,
add column scope_from timestamptz null,
add column scope_shift_ids text[] not null default '{}'::text[],
add column presented_shift_ids text[] not null default '{}'::text[],
add constraint pos_sync_runs_scope_kind_chk check (
  scope_kind is null
  or scope_kind in ('shift_ids', 'from', 'all')
),
add constraint pos_sync_runs_scope_from_chk check ((scope_kind = 'from') = (scope_from is not null)),
add constraint pos_sync_runs_scope_from_finite_chk check (
  scope_from is null
  or pg_catalog.isfinite (scope_from)
),
add constraint pos_sync_runs_scope_shifts_chk check (
  scope_kind = 'shift_ids'
  or pg_catalog.cardinality (scope_shift_ids) = 0
);

comment on column app.pos_sync_runs.scope_kind is 'Order-read scope applied by this run: shift_ids, from, or all. Null until p_scope is applied, and null on a run that applied its scope before this column existed (scope unknown, never treated as covering). Not a proof of coverage by itself; finish copies it into pos_sync_coverage only when the run ends ok.';

comment on column app.pos_sync_runs.scope_from is 'Lower bound of a from scope. Null unless scope_kind is from.';

comment on column app.pos_sync_runs.scope_shift_ids is 'Shift ids of a shift_ids scope, sorted and distinct. Empty unless scope_kind is shift_ids.';

comment on column app.pos_sync_runs.presented_shift_ids is 'Shifts whose transaction subcollection this run replaced. A shift is added only after that replacement. Sorted and distinct.';

-- ============================================================================
-- 2. Immutable inputs. No foreign keys to the mutable mirror or to
-- pos_sync_runs: a test or a later delete of those rows must not cascade
-- into this history, and a foreign key would block that delete or fire the
-- append-only guard. Ids are plain copies of the accounting keys.
-- No customer, phone, address, or transaction-description columns.
-- ============================================================================
create table app.pos_order_snapshots (
  id bigint generated always as identity primary key,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  version integer not null check (version >= 1),
  order_number integer null,
  shift_id text not null check (length(pg_catalog.btrim (shift_id)) > 0),
  status text not null check (status in ('complete', 'canceled', 'active')),
  order_type text null,
  payment_type text null,
  ordered_at timestamptz not null check (pg_catalog.isfinite (ordered_at)),
  subtotal numeric(14, 2) not null,
  discount numeric(14, 2) not null,
  tax numeric(14, 2) not null,
  service_tax numeric(14, 2) not null,
  delivery_fee numeric(14, 2) not null,
  total numeric(14, 2) not null,
  financial_revision integer null,
  last_financial_operation_key text null,
  pos_update_time timestamptz not null check (pg_catalog.isfinite (pos_update_time)),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  lines jsonb not null,
  origin text not null check (origin in ('sync', 'backfill')),
  source_run_id bigint null,
  captured_at timestamptz not null default pg_catalog.now () check (pg_catalog.isfinite (captured_at)),
  constraint pos_order_snapshots_order_version_key unique (order_id, version),
  constraint pos_order_snapshots_lines_chk check (pg_catalog.jsonb_typeof (lines) = 'array'),
  constraint pos_order_snapshots_money_finite_chk check (
    subtotal not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and discount not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and tax not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and service_tax not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and delivery_fee not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and total not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  )
);

comment on table app.pos_order_snapshots is 'Immutable accounting header and lines for one accepted POS order version. A later cancellation that clears the lines inserts another snapshot and leaves this one in place. origin backfill is the current mirror copied by this migration, not a live accept. No customer fields.';

comment on column app.pos_order_snapshots.lines is 'Accounting line fields copied from pos_order_lines after replace_pos_order_lines: line_id, item_id, item_name, size_name, quantity, weighted_qty, weighted_unit, unit_price, price_per_kg, options, line_total. Options are the stored whitelist, not the raw POS object.';

comment on column app.pos_order_snapshots.origin is 'sync when ingest accepted this version. backfill when the migration copied the mirror version that already existed. PR 4 uses backfill to tell a restored current mirror from a version observed live.';

comment on column app.pos_order_snapshots.source_run_id is 'pos_sync_runs.id that accepted this version. Null on a backfill. Not a foreign key.';

create table app.pos_refund_revisions (
  id bigint generated always as identity primary key,
  shift_id text not null check (length(pg_catalog.btrim (shift_id)) > 0),
  tx_id text not null check (length(pg_catalog.btrim (tx_id)) > 0),
  order_id text null check (
    order_id is null
    or length(pg_catalog.btrim (order_id)) > 0
  ),
  tx_type integer not null,
  amount numeric(14, 2) not null,
  occurred_at timestamptz not null check (pg_catalog.isfinite (occurred_at)),
  present boolean not null,
  origin text not null check (origin in ('sync', 'backfill')),
  source_run_id bigint null,
  captured_at timestamptz not null default pg_catalog.now () check (pg_catalog.isfinite (captured_at)),
  constraint pos_refund_revisions_amount_finite_chk check (
    amount not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  )
);

comment on table app.pos_refund_revisions is 'Immutable accounting changes of one POS shift transaction (shift_id, tx_id), including a disappearance tombstone (present false). A sync that deletes and reinserts the same normalized fields writes nothing. Description is not stored. origin backfill is one present row per mirror transaction at migration time.';

comment on column app.pos_refund_revisions.present is 'False is a disappearance tombstone. The accounting fields are the last values that disappeared. The latest row per (shift_id, tx_id) is the current revision.';

comment on column app.pos_refund_revisions.origin is 'sync when a presented subcollection changed this transaction. backfill when the migration copied a current mirror row.';

create index pos_refund_revisions_key_idx on app.pos_refund_revisions (shift_id, tx_id, id desc);

create index pos_refund_revisions_order_id_idx on app.pos_refund_revisions (order_id)
where
  order_id is not null;

create table app.pos_cost_inputs (
  id bigint generated always as identity primary key,
  order_id text not null check (length(pg_catalog.btrim (order_id)) > 0),
  input_revision integer not null check (input_revision >= 1),
  snapshot_id bigint not null references app.pos_order_snapshots (id) on delete restrict,
  missing_from_pos boolean not null,
  refund_revision_ids bigint[] not null,
  source_run_id bigint null,
  digest text not null check (digest ~ '^[0-9a-f]{32}$'),
  origin text not null check (origin in ('sync', 'backfill')),
  captured_at timestamptz not null default pg_catalog.now () check (pg_catalog.isfinite (captured_at)),
  constraint pos_cost_inputs_order_revision_key unique (order_id, input_revision)
);

comment on table app.pos_cost_inputs is 'Immutable local cost input for one order. A new input_revision is written when the digest changes: accepted snapshot, missing_from_pos flip in either direction, or a change to the normalized linked type-3 refund revisions. An unchanged digest writes nothing. origin backfill is the single input copied from the mirror at migration time.';

comment on column app.pos_cost_inputs.refund_revision_ids is 'Latest present type-3 revision id per (shift_id, tx_id) whose order_id is this order, sorted by id. Empty when none are linked. Not a foreign key.';

comment on column app.pos_cost_inputs.digest is 'md5 of snapshot id, missing_from_pos, and the sorted linked refund revision ids. A change detector for this order, not a POS content hash.';

comment on column app.pos_cost_inputs.origin is 'sync when ingest appended this input. backfill when the migration wrote the first input from the current mirror.';

create index pos_cost_inputs_snapshot_id_idx on app.pos_cost_inputs (snapshot_id);

create table app.pos_sync_coverage (
  run_id bigint primary key,
  started_at timestamptz not null check (pg_catalog.isfinite (started_at)),
  finished_at timestamptz not null check (pg_catalog.isfinite (finished_at)),
  orders_scope_applied boolean not null,
  scope_kind text null check (
    scope_kind is null
    or scope_kind in ('shift_ids', 'from', 'all')
  ),
  scope_from timestamptz null,
  scope_shift_ids text[] not null,
  presented_shift_ids text[] not null,
  transactions_covered boolean not null,
  legacy_direct boolean not null default false,
  constraint pos_sync_coverage_scope_from_chk check ((scope_kind = 'from') = (scope_from is not null)),
  constraint pos_sync_coverage_scope_from_finite_chk check (
    scope_from is null
    or pg_catalog.isfinite (scope_from)
  ),
  constraint pos_sync_coverage_scope_shifts_chk check (
    scope_kind = 'shift_ids'
    or pg_catalog.cardinality (scope_shift_ids) = 0
  )
);

comment on table app.pos_sync_coverage is 'One row per successful POS sync finish: the order scope that finish actually had, the shifts whose transaction subcollections were replaced, and the run start and finish times. A failed finish writes nothing. legacy_direct marks an ok run that was inserted already finished, including runs copied at migration time, so the older time-only count check still applies to those rows.';

comment on column app.pos_sync_coverage.orders_scope_applied is 'True when this run applied p_scope. finish_pos_sync_run does not require it; a true ok finish with this flag false does not cover a count.';

comment on column app.pos_sync_coverage.presented_shift_ids is 'Shifts whose transaction subcollections this run replaced, sorted and distinct.';

comment on column app.pos_sync_coverage.transactions_covered is 'True when every shift the applied scope names was presented, so its transaction subcollection was replaced: the listed shifts for shift_ids, every mirror shift for all, every mirror shift opened at or after scope_from for from. False when any of them was not presented, when the scope is unknown (applied before this column existed), and on legacy_direct rows. Computed at finish; record_count recomputes it from presented_shift_ids for the shifts opened at or before the count.';

comment on column app.pos_sync_coverage.legacy_direct is 'True when the ok run was inserted already finished, not closed by finish_pos_sync_run. record_count then keeps the previous time check and does not apply the scope geometry.';

comment on column app.pos_sync_coverage.started_at is 'Run started_at copied when coverage was written. record_count still reads the live pos_sync_runs times for the existing comparisons.';

-- ============================================================================
-- 3. Append-only guards, RLS, no DML grants.
-- ============================================================================
create trigger trg_pos_order_snapshots_no_update_delete
before update or delete on app.pos_order_snapshots for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_pos_order_snapshots_no_truncate
before truncate on app.pos_order_snapshots for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_pos_refund_revisions_no_update_delete
before update or delete on app.pos_refund_revisions for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_pos_refund_revisions_no_truncate
before truncate on app.pos_refund_revisions for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_pos_cost_inputs_no_update_delete
before update or delete on app.pos_cost_inputs for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_pos_cost_inputs_no_truncate
before truncate on app.pos_cost_inputs for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_pos_sync_coverage_no_update_delete
before update or delete on app.pos_sync_coverage for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_pos_sync_coverage_no_truncate
before truncate on app.pos_sync_coverage for each statement
execute function app.prevent_append_only_mutation ();

alter table app.pos_order_snapshots enable row level security;

alter table app.pos_refund_revisions enable row level security;

alter table app.pos_cost_inputs enable row level security;

alter table app.pos_sync_coverage enable row level security;

create policy pos_order_snapshots_select_owner on app.pos_order_snapshots for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy pos_refund_revisions_select_owner on app.pos_refund_revisions for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy pos_cost_inputs_select_owner on app.pos_cost_inputs for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy pos_sync_coverage_select_owner on app.pos_sync_coverage for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.pos_order_snapshots
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_refund_revisions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_cost_inputs
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_sync_coverage
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.pos_order_snapshots_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.pos_refund_revisions_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.pos_cost_inputs_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.pos_order_snapshots,
  app.pos_refund_revisions,
  app.pos_cost_inputs,
  app.pos_sync_coverage to authenticated,
  service_role;

-- ============================================================================
-- 4. Internal helpers. Revoked from every API role.
-- ============================================================================
create function app.capture_pos_order_snapshot (p_order_id text, p_run_id bigint, p_origin text) returns bigint language plpgsql security definer
set
  search_path = '' as $$
declare
  v_id bigint;
begin
  if p_origin is null
  or p_origin not in ('sync', 'backfill') then
    raise exception 'snapshot origin must be sync or backfill'
      using errcode = '22023';
  end if;

  select
    snap.id
  into v_id
  from
    app.pos_order_snapshots snap
    join app.pos_orders o on o.id = snap.order_id
    and o.version = snap.version
  where
    o.id = p_order_id;

  if found then
    return v_id;
  end if;

  insert into
    app.pos_order_snapshots (
      order_id,
      version,
      order_number,
      shift_id,
      status,
      order_type,
      payment_type,
      ordered_at,
      subtotal,
      discount,
      tax,
      service_tax,
      delivery_fee,
      total,
      financial_revision,
      last_financial_operation_key,
      pos_update_time,
      content_hash,
      lines,
      origin,
      source_run_id
    )
  select
    o.id,
    o.version,
    o.order_number,
    o.shift_id,
    o.status,
    o.order_type,
    o.payment_type,
    o.ordered_at,
    o.subtotal,
    o.discount,
    o.tax,
    o.service_tax,
    o.delivery_fee,
    o.total,
    o.financial_revision,
    o.last_financial_operation_key,
    o.pos_update_time,
    o.content_hash,
    coalesce(
      (
        select
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'line_id',
              line.line_id,
              'item_id',
              line.item_id,
              'item_name',
              line.item_name,
              'size_name',
              line.size_name,
              'quantity',
              line.quantity,
              'weighted_qty',
              line.weighted_qty,
              'weighted_unit',
              line.weighted_unit,
              'unit_price',
              line.unit_price,
              'price_per_kg',
              line.price_per_kg,
              'options',
              line.options,
              'line_total',
              line.line_total
            )
            order by
              line.line_id
          )
        from
          app.pos_order_lines line
        where
          line.order_id = o.id
      ),
      '[]'::jsonb
    ),
    p_origin,
    p_run_id
  from
    app.pos_orders o
  where
    o.id = p_order_id
  returning
    id into v_id;

  if v_id is null then
    raise exception 'unknown POS order'
      using errcode = '22023';
  end if;

  return v_id;
end;
$$;

comment on function app.capture_pos_order_snapshot (text, bigint, text) is 'Copies the current accounting header and lines of one order at its current version. Returns the existing snapshot when that version was already captured. Internal. Does not take the ledger posting lock.';

revoke all on function app.capture_pos_order_snapshot (text, bigint, text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.pos_preparation_input (p_order_id text) returns setof app.pos_order_snapshots language sql stable security definer
set
  search_path = '' as $$
  select
    snap.*
  from
    app.pos_order_snapshots snap
  where
    snap.order_id = p_order_id
    and pg_catalog.jsonb_typeof (snap.lines) = 'array'
    and pg_catalog.jsonb_array_length (snap.lines) > 0
  order by
    snap.version desc
  limit
    1;
$$;

comment on function app.pos_preparation_input (text) is 'Latest non-empty POS snapshot for one order: the preparation input. A later snapshot whose lines were cleared by a cancellation stays stored and is not selected. Internal.';

revoke all on function app.pos_preparation_input (text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.capture_pos_refund_revisions (p_run_id bigint, p_shifts jsonb) returns text[] language plpgsql security definer
set
  search_path = '' as $$
declare
  v_shift jsonb;
  v_affected text[] := '{}'::text[];
  v_shift_orders text[];
begin
  if p_shifts is null
  or pg_catalog.jsonb_typeof (p_shifts) <> 'array' then
    raise exception 'shift transaction sets must be a jsonb array'
      using errcode = '22023';
  end if;

  for v_shift in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_shifts) as e (value)
    order by
      e.value ->> 'shift_id'
  loop
    with
      new_rows as (
        select
          pg_catalog.btrim(e.value ->> 'tx_id') as tx_id,
          nullif(pg_catalog.btrim(e.value ->> 'order_id'), '') as order_id,
          (e.value ->> 'tx_type')::integer as tx_type,
          (e.value ->> 'amount')::numeric(14, 2) as amount,
          (e.value ->> 'occurred_at')::timestamptz as occurred_at
        from
          pg_catalog.jsonb_array_elements(coalesce(v_shift -> 'after', '[]'::jsonb)) as e (value)
      ),
      old_rows as (
        select
          pg_catalog.btrim(e.value ->> 'tx_id') as tx_id,
          nullif(pg_catalog.btrim(e.value ->> 'order_id'), '') as order_id,
          (e.value ->> 'tx_type')::integer as tx_type,
          (e.value ->> 'amount')::numeric(14, 2) as amount,
          (e.value ->> 'occurred_at')::timestamptz as occurred_at
        from
          pg_catalog.jsonb_array_elements(coalesce(v_shift -> 'before', '[]'::jsonb)) as e (value)
      ),
      changed as (
        select
          n.tx_id,
          n.order_id,
          n.tx_type,
          n.amount,
          n.occurred_at,
          true as present,
          o.order_id as old_order_id,
          o.tx_type as old_tx_type
        from
          new_rows n
          left join old_rows o on o.tx_id = n.tx_id
        where
          o.tx_id is null
          or n.order_id is distinct from o.order_id
          or n.tx_type is distinct from o.tx_type
          or n.amount is distinct from o.amount
          or n.occurred_at is distinct from o.occurred_at
        union all
        select
          o.tx_id,
          o.order_id,
          o.tx_type,
          o.amount,
          o.occurred_at,
          false as present,
          o.order_id as old_order_id,
          o.tx_type as old_tx_type
        from
          old_rows o
          left join new_rows n on n.tx_id = o.tx_id
        where
          n.tx_id is null
      ),
      written as (
        insert into
          app.pos_refund_revisions (
            shift_id,
            tx_id,
            order_id,
            tx_type,
            amount,
            occurred_at,
            present,
            origin,
            source_run_id
          )
        select
          v_shift ->> 'shift_id',
          c.tx_id,
          c.order_id,
          c.tx_type,
          c.amount,
          c.occurred_at,
          c.present,
          'sync',
          p_run_id
        from
          changed c
        order by
          c.tx_id,
          c.present desc
        returning
          1
      )
    select
      coalesce(
        pg_catalog.array_agg(distinct affected.order_id) filter (
          where
            affected.order_id is not null
        ),
        '{}'::text[]
      )
    into v_shift_orders
    from
      (
        select
          c.order_id
        from
          changed c
        where
          c.present
          and c.tx_type = 3
          and c.order_id is not null
        union
        select
          c.old_order_id
        from
          changed c
        where
          c.old_tx_type = 3
          and c.old_order_id is not null
      ) as affected
      right join (
        select
          pg_catalog.count(*) as n
        from
          written
      ) as done on true;

    v_affected := v_affected || coalesce(v_shift_orders, '{}'::text[]);
  end loop;

  return coalesce(v_affected, '{}'::text[]);
end;
$$;

comment on function app.capture_pos_refund_revisions (bigint, jsonb) is 'Appends refund revisions for presented shifts whose normalized accounting set changed, and tombstones for keys that disappeared. Identical before and after sets append nothing. Returns order ids linked by a type-3 row on either side of a change. Internal. Does not take the ledger posting lock.';

revoke all on function app.capture_pos_refund_revisions (bigint, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.append_pos_cost_input (p_order_id text, p_run_id bigint, p_origin text) returns bigint language plpgsql security definer
set
  search_path = '' as $$
declare
  v_missing boolean;
  v_snapshot bigint;
  v_refunds bigint[];
  v_digest text;
  v_latest text;
  v_revision integer;
  v_id bigint;
begin
  if p_origin is null
  or p_origin not in ('sync', 'backfill') then
    raise exception 'cost input origin must be sync or backfill'
      using errcode = '22023';
  end if;

  select
    o.missing_from_pos
  into v_missing
  from
    app.pos_orders o
  where
    o.id = p_order_id
  for update;

  if not found then
    raise exception 'unknown POS order'
      using errcode = '22023';
  end if;

  select
    snap.id
  into v_snapshot
  from
    app.pos_order_snapshots snap
  where
    snap.order_id = p_order_id
  order by
    snap.version desc
  limit
    1;

  if v_snapshot is null then
    v_snapshot := app.capture_pos_order_snapshot (p_order_id, p_run_id, p_origin);
  end if;

  select
    coalesce(
      pg_catalog.array_agg(latest.id order by latest.id),
      '{}'::bigint[]
    )
  into v_refunds
  from
    (
      select distinct on (revision.shift_id, revision.tx_id)
        revision.id,
        revision.present,
        revision.tx_type,
        revision.order_id
      from
        app.pos_refund_revisions revision
      order by
        revision.shift_id,
        revision.tx_id,
        revision.id desc
    ) as latest
  where
    latest.present
    and latest.tx_type = 3
    and latest.order_id = p_order_id;

  v_digest := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'snapshot_id',
      v_snapshot,
      'missing_from_pos',
      v_missing,
      'refund_revision_ids',
      to_jsonb(v_refunds)
    )::text
  );

  select
    cost_input.digest
  into v_latest
  from
    app.pos_cost_inputs cost_input
  where
    cost_input.order_id = p_order_id
  order by
    cost_input.input_revision desc
  limit
    1;

  if v_latest is not distinct from v_digest then
    return null;
  end if;

  select
    coalesce(pg_catalog.max(cost_input.input_revision), 0) + 1
  into v_revision
  from
    app.pos_cost_inputs cost_input
  where
    cost_input.order_id = p_order_id;

  insert into
    app.pos_cost_inputs (
      order_id,
      input_revision,
      snapshot_id,
      missing_from_pos,
      refund_revision_ids,
      source_run_id,
      digest,
      origin
    )
  values
    (
      p_order_id,
      v_revision,
      v_snapshot,
      v_missing,
      v_refunds,
      p_run_id,
      v_digest,
      p_origin
    )
  returning
    id into v_id;

  return v_id;
end;
$$;

comment on function app.append_pos_cost_input (text, bigint, text) is 'Appends the next cost input for one order when the digest of the latest snapshot, missing_from_pos, and linked type-3 refund revisions differs from the latest input. Returns null when the digest is unchanged. Locks the order row. Does not take the ledger posting lock. Internal.';

revoke all on function app.append_pos_cost_input (text, bigint, text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.pos_sync_scope_covers_count (
  p_applied boolean,
  p_kind text,
  p_from timestamptz,
  p_shift_ids text[],
  p_counted_at timestamptz
) returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    p_applied is true
    and (
      p_kind = 'all'
      or (
        p_kind = 'shift_ids'
        and not exists (
          select
            1
          from
            app.pos_shifts shift
          where
            shift.opened_at <= p_counted_at
            and shift.id <> all (coalesce(p_shift_ids, '{}'::text[]))
        )
      )
      or (
        p_kind = 'from'
        and p_from is not null
        and p_from <= coalesce(
          (
            select
              min(shift.opened_at)
            from
              app.pos_shifts shift
            where
              shift.opened_at <= p_counted_at
          ),
          p_from
        )
      )
    );
$$;

comment on function app.pos_sync_scope_covers_count (boolean, text, timestamptz, text[], timestamptz) is 'True when an applied order scope covers every shift opened at or before the count. all covers them. shift_ids must list each of them. from must be at or before the earliest such opened_at. No such shift is covered by any applied scope. Null or false for an unknown kind: callers must test is not true. Internal.';

revoke all on function app.pos_sync_scope_covers_count (boolean, text, timestamptz, text[], timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.backfill_pos_accounting_inputs () returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_order_id text;
begin
  -- One snapshot of the current mirror version. Idempotent per (order, version).
  perform
    app.capture_pos_order_snapshot (o.id, null, 'backfill')
  from
    app.pos_orders o
  order by
    o.id;

  insert into
    app.pos_refund_revisions (
      shift_id,
      tx_id,
      order_id,
      tx_type,
      amount,
      occurred_at,
      present,
      origin,
      source_run_id
    )
  select
    tx.shift_id,
    tx.tx_id,
    tx.order_id,
    tx.tx_type,
    tx.amount,
    tx.occurred_at,
    true,
    'backfill',
    null
  from
    app.pos_shift_transactions tx
  where
    not exists (
      select
        1
      from
        app.pos_refund_revisions revision
      where
        revision.shift_id = tx.shift_id
        and revision.tx_id = tx.tx_id
    )
  order by
    tx.shift_id,
    tx.tx_id;

  for v_order_id in
    select
      o.id
    from
      app.pos_orders o
    where
      not exists (
        select
          1
        from
          app.pos_cost_inputs cost_input
        where
          cost_input.order_id = o.id
      )
    order by
      o.id
  loop
    perform app.append_pos_cost_input (v_order_id, null, 'backfill');
  end loop;

  -- Finished ok runs that predate coverage. legacy_direct keeps the old
  -- count time check until a newer run is closed by finish_pos_sync_run.
  insert into
    app.pos_sync_coverage (
      run_id,
      started_at,
      finished_at,
      orders_scope_applied,
      scope_kind,
      scope_from,
      scope_shift_ids,
      presented_shift_ids,
      transactions_covered,
      legacy_direct
    )
  select
    run.id,
    run.started_at,
    run.finished_at,
    true,
    'all',
    null,
    '{}'::text[],
    '{}'::text[],
    false,
    true
  from
    app.pos_sync_runs run
  where
    run.status = 'ok'
    and run.finished_at is not null
    and not exists (
      select
        1
      from
        app.pos_sync_coverage cov
      where
        cov.run_id = run.id
    )
  order by
    run.id;
end;
$$;

comment on function app.backfill_pos_accounting_inputs () is 'Copies the current mirror into one backfill snapshot and one backfill cost input per order, and one present backfill refund revision per current transaction that has none yet. Finished ok runs with no coverage row get a legacy_direct all-scope row. A second call appends nothing. Internal.';

revoke all on function app.backfill_pos_accounting_inputs ()
from
  public,
  anon,
  authenticated,
  service_role;

-- A finished ok row inserted directly (the count tests, and any caller that
-- does not use finish_pos_sync_run) has no scope payload. Record it as
-- legacy_direct so record_count keeps the previous time check. Rows inserted
-- as running, then updated by finish, do not fire this trigger.
create function app.trg_pos_sync_runs_legacy_coverage () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  if new.status = 'ok'
  and new.finished_at is not null
  and not exists (
    select
      1
    from
      app.pos_sync_coverage cov
    where
      cov.run_id = new.id
  ) then
    insert into
      app.pos_sync_coverage (
        run_id,
        started_at,
        finished_at,
        orders_scope_applied,
        scope_kind,
        scope_from,
        scope_shift_ids,
        presented_shift_ids,
        transactions_covered,
        legacy_direct
      )
    values
      (
        new.id,
        new.started_at,
        new.finished_at,
        true,
        'all',
        null,
        '{}'::text[],
        '{}'::text[],
        false,
        true
      );
  end if;

  return new;
end;
$$;

comment on function app.trg_pos_sync_runs_legacy_coverage () is 'Records legacy_direct coverage for an ok run inserted already finished. Does not capture order snapshots. Internal.';

revoke all on function app.trg_pos_sync_runs_legacy_coverage ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_pos_sync_runs_legacy_coverage
after insert on app.pos_sync_runs for each row
execute function app.trg_pos_sync_runs_legacy_coverage ();

-- ============================================================================
-- 5. finish_pos_sync_run. Latest definition: 20261016040000_pos_sales.sql.
-- An ok finish writes coverage. A failed finish does not. scope_applied is
-- still not required to finish.
-- ============================================================================
create or replace function app.finish_pos_sync_run (
  p_run_id bigint,
  p_status text,
  p_counts jsonb,
  p_error text
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_started timestamptz;
  v_finished timestamptz;
  v_applied boolean;
  v_kind text;
  v_from timestamptz;
  v_scope_shifts text[];
  v_presented text[];
  v_transactions boolean;
begin
  perform app.assert_pos_write_allowed ();

  if p_status is null or p_status not in ('ok', 'failed') then
    raise exception 'finish status must be ok or failed'
      using errcode = '22023';
  end if;

  if p_counts is not null and pg_catalog.jsonb_typeof(p_counts) <> 'object' then
    raise exception 'counts must be a jsonb object'
      using errcode = '22023';
  end if;

  update app.pos_sync_runs
  set
    status = p_status,
    finished_at = pg_catalog.now(),
    counts = p_counts,
    error = nullif(pg_catalog.left(coalesce(p_error, ''), 500), '')
  where
    id = p_run_id
    and status = 'running'
  returning
    started_at,
    finished_at,
    scope_applied,
    scope_kind,
    scope_from,
    scope_shift_ids,
    presented_shift_ids
  into
    v_started,
    v_finished,
    v_applied,
    v_kind,
    v_from,
    v_scope_shifts,
    v_presented;

  if not found then
    raise exception 'pos_sync_run is not running'
      using errcode = '22023';
  end if;

  if p_status = 'ok' then
    v_presented := coalesce(v_presented, '{}'::text[]);
    v_scope_shifts := coalesce(v_scope_shifts, '{}'::text[]);
    v_transactions := case
      when v_kind = 'shift_ids' then v_scope_shifts <@ v_presented
      when v_kind = 'all' then not exists (
        select
          1
        from
          app.pos_shifts shift
        where
          shift.id <> all (v_presented)
      )
      when v_kind = 'from' then not exists (
        select
          1
        from
          app.pos_shifts shift
        where
          shift.id <> all (v_presented)
          and (
            shift.opened_at >= v_from
            or exists (
              select
                1
              from
                app.pos_orders o
              where
                o.shift_id = shift.id
                and o.ordered_at >= v_from
            )
          )
      )
      when v_applied then false
      else pg_catalog.cardinality(v_presented) > 0
    end;

    insert into
      app.pos_sync_coverage (
        run_id,
        started_at,
        finished_at,
        orders_scope_applied,
        scope_kind,
        scope_from,
        scope_shift_ids,
        presented_shift_ids,
        transactions_covered,
        legacy_direct
      )
    values
      (
        p_run_id,
        v_started,
        v_finished,
        v_applied,
        case
          when v_applied then v_kind
          else null
        end,
        case
          when v_applied
          and v_kind = 'from' then v_from
          else null
        end,
        case
          when v_applied
          and v_kind = 'shift_ids' then v_scope_shifts
          else '{}'::text[]
        end,
        v_presented,
        v_transactions,
        false
      );
  end if;

  delete from app.pos_sync_run_orders
  where
    run_id = p_run_id;
end;
$$;

comment on function app.finish_pos_sync_run (bigint, text, jsonb, text) is 'Closes a POS sync run and drops the temporary seen-order ids. error is truncated to 500 characters. Status ok appends pos_sync_coverage from the scope and presented shifts accumulated by ingest; transactions_covered is true only when every shift the scope names was presented. Status failed appends nothing. scope_applied is not required. Does not post stock and does not take the ledger posting lock.';

revoke all on function app.finish_pos_sync_run (bigint, text, jsonb, text)
from
  public,
  anon;

grant
execute on function app.finish_pos_sync_run (bigint, text, jsonb, text) to authenticated,
service_role;

-- ============================================================================
-- 6. ingest_pos_batch. Latest definition: 20261021000000_pos_refunds_drawer.sql.
-- ============================================================================
create or replace function app.ingest_pos_batch (
  p_run_id bigint,
  p_shifts jsonb,
  p_orders jsonb,
  p_scope jsonb
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_status text;
  v_mode text;
  v_scope_applied boolean;
  v_started_at timestamptz;
  v_scope_key text;
  v_key_count int;
  v_from timestamptz;
  v_shift jsonb;
  v_order jsonb;
  v_lines jsonb;
  v_shift_wrote int;
  v_existing app.pos_orders;
  v_conflict boolean;
  v_missing_id text;
  v_order_id text;
  v_shift_id text;
  v_status_order text;
  v_ordered_at timestamptz;
  v_update_time timestamptz;
  v_hash text;
  v_attempts int;
  v_inserted int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_stale int := 0;
  v_missing int := 0;
  v_shifts_upserted int := 0;
  v_shifts_skipped int := 0;
  v_tx jsonb;
  v_clean jsonb;
  v_seen text[];
  v_drawer_cash numeric(14, 2);
  v_drawer_credit numeric(14, 2);
  v_tx_id text;
  v_tx_order text;
  v_tx_type integer;
  v_tx_amount numeric(14, 2);
  v_tx_at timestamptz;
  v_transactions integer := 0;
  v_old_txs jsonb;
  v_pending_shifts jsonb := '[]'::jsonb;
  v_cost_orders text[] := '{}'::text[];
  v_refund_orders text[];
  v_cost_order text;
begin
  perform app.assert_pos_write_allowed ();

  if p_run_id is null then
    raise exception 'p_run_id is required'
      using errcode = '22023';
  end if;

  if p_shifts is null or pg_catalog.jsonb_typeof(p_shifts) <> 'array' then
    raise exception 'p_shifts must be a jsonb array'
      using errcode = '22023';
  end if;

  if p_orders is null or pg_catalog.jsonb_typeof(p_orders) <> 'array' then
    raise exception 'p_orders must be a jsonb array'
      using errcode = '22023';
  end if;

  select
    r.status,
    r.mode,
    r.scope_applied,
    r.started_at
  into
    v_status,
    v_mode,
    v_scope_applied,
    v_started_at
  from
    app.pos_sync_runs r
  where
    r.id = p_run_id
  for update;

  if not found then
    raise exception 'unknown pos_sync_run id'
      using errcode = '22023';
  end if;

  if v_status <> 'running' then
    raise exception 'pos_sync_run is not running'
      using errcode = '22023';
  end if;

  v_scope_key := null;
  v_from := null;

  if p_scope is not null then
    if pg_catalog.jsonb_typeof(p_scope) <> 'object' then
      raise exception 'p_scope must be a jsonb object or null'
        using errcode = '22023';
    end if;

    if v_scope_applied then
      raise exception 'scope already applied for this run'
        using errcode = '22023';
    end if;

    select
      pg_catalog.count(*)
    into v_key_count
    from
      pg_catalog.jsonb_object_keys(p_scope) as k;

    if v_key_count <> 1 then
      raise exception 'p_scope must contain exactly one of shift_ids, from, or all'
        using errcode = '22023';
    end if;

    select
      k.key
    into v_scope_key
    from
      pg_catalog.jsonb_object_keys(p_scope) as k (key);

    if v_scope_key = 'shift_ids' then
      if pg_catalog.jsonb_typeof(p_scope -> 'shift_ids') <> 'array' then
        raise exception 'shift_ids must be a jsonb array'
          using errcode = '22023';
      end if;

      if exists (
        select
          1
        from
          pg_catalog.jsonb_array_elements(p_scope -> 'shift_ids') as e (value)
        where
          pg_catalog.jsonb_typeof(e.value) <> 'string'
          or coalesce(length(pg_catalog.btrim(e.value #>> '{}')), 0) = 0
      ) then
        raise exception 'shift_ids must be non-empty strings'
          using errcode = '22023';
      end if;
    elsif v_scope_key = 'from' then
      v_from := (p_scope ->> 'from')::timestamptz;

      if v_from is null or not pg_catalog.isfinite(v_from) then
        raise exception 'scope from must be a finite timestamp'
          using errcode = '22023';
      end if;
    elsif v_scope_key = 'all' then
      if p_scope -> 'all' is distinct from 'true'::jsonb then
        raise exception 'scope all must be true'
          using errcode = '22023';
      end if;
    else
      raise exception 'p_scope must contain exactly one of shift_ids, from, or all'
        using errcode = '22023';
    end if;

    if (
      v_mode = 'recent'
      and v_scope_key is distinct from 'shift_ids'
    )
    or (
      v_mode = 'window35'
      and v_scope_key is distinct from 'from'
    )
    or (
      v_mode = 'full'
      and v_scope_key is distinct from 'all'
    ) then
      raise exception 'p_scope does not match the sync run mode'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_shifts) as e (value)
    where
      coalesce(e.value ->> 'id', '') = ''
  ) then
    raise exception 'shift id is required'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_shifts) as e (value)
    group by
      e.value ->> 'id'
    having
      pg_catalog.count(*) > 1
  ) then
    raise exception 'duplicate shift id in batch'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_orders) as e (value)
    where
      coalesce(e.value ->> 'id', '') = ''
  ) then
    raise exception 'order id is required'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_orders) as e (value)
    group by
      e.value ->> 'id'
    having
      pg_catalog.count(*) > 1
  ) then
    raise exception 'duplicate order id in batch'
      using errcode = '22023';
  end if;

  for v_shift in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_shifts) as e (value)
    order by
      e.value ->> 'id'
  loop
    if pg_catalog.jsonb_typeof(v_shift) <> 'object' then
      raise exception 'each shift must be a jsonb object'
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof(v_shift -> 'is_active') is distinct from 'boolean' then
      raise exception 'is_active must be a boolean'
        using errcode = '22023';
    end if;

    if (v_shift ->> 'opened_at')::timestamptz is null
    or not pg_catalog.isfinite((v_shift ->> 'opened_at')::timestamptz) then
      raise exception 'opened_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    if v_shift -> 'closed_at' is not null
    and v_shift -> 'closed_at' <> 'null'::jsonb
    and (
      (v_shift ->> 'closed_at')::timestamptz is null
      or not pg_catalog.isfinite((v_shift ->> 'closed_at')::timestamptz)
    ) then
      raise exception 'closed_at must be a finite timestamp or null'
        using errcode = '22023';
    end if;

    if (v_shift ->> 'pos_update_time')::timestamptz is null
    or not pg_catalog.isfinite((v_shift ->> 'pos_update_time')::timestamptz) then
      raise exception 'pos_update_time must be a finite timestamp'
        using errcode = '22023';
    end if;

    v_drawer_cash := null;
    v_drawer_credit := null;

    if v_shift -> 'drawer_cash_net' is null
    or v_shift -> 'drawer_cash_net' = 'null'::jsonb then
      v_drawer_cash := null;
    elsif pg_catalog.jsonb_typeof(v_shift -> 'drawer_cash_net') not in ('number', 'string') then
      raise exception 'drawer_cash_net must be a finite number or null'
        using errcode = '22023';
    else
      begin
        v_drawer_cash := app.pos_money ((v_shift ->> 'drawer_cash_net')::numeric);
      exception
        when invalid_text_representation
        or numeric_value_out_of_range
        or invalid_parameter_value then
          raise exception 'drawer_cash_net must be a finite number or null'
            using errcode = '22023';
      end;
    end if;

    if v_shift -> 'drawer_credit' is null
    or v_shift -> 'drawer_credit' = 'null'::jsonb then
      v_drawer_credit := null;
    elsif pg_catalog.jsonb_typeof(v_shift -> 'drawer_credit') not in ('number', 'string') then
      raise exception 'drawer_credit must be a finite number or null'
        using errcode = '22023';
    else
      begin
        v_drawer_credit := app.pos_money ((v_shift ->> 'drawer_credit')::numeric);
      exception
        when invalid_text_representation
        or numeric_value_out_of_range
        or invalid_parameter_value then
          raise exception 'drawer_credit must be a finite number or null'
            using errcode = '22023';
      end;
    end if;

    if v_shift -> 'transactions' is null
    or pg_catalog.jsonb_typeof(v_shift -> 'transactions') is distinct from 'array' then
      raise exception 'transactions must be a jsonb array'
        using errcode = '22023';
    end if;

    v_clean := '[]'::jsonb;
    v_seen := '{}'::text[];

    for v_tx in
      select
        e.value
      from
        pg_catalog.jsonb_array_elements(v_shift -> 'transactions') as e (value)
    loop
      if pg_catalog.jsonb_typeof(v_tx) is distinct from 'object' then
        raise exception 'each transaction must be a jsonb object'
          using errcode = '22023';
      end if;

      v_tx_id := pg_catalog.btrim(v_tx ->> 'tx_id');

      if v_tx_id is null or length(v_tx_id) = 0 then
        raise exception 'tx_id is required'
          using errcode = '22023';
      end if;

      if v_tx_id = any (v_seen) then
        raise exception 'duplicate tx_id'
          using errcode = '22023';
      end if;

      v_seen := v_seen || v_tx_id;

      if v_tx -> 'order_id' is null
      or v_tx -> 'order_id' = 'null'::jsonb then
        v_tx_order := null;
      elsif pg_catalog.jsonb_typeof(v_tx -> 'order_id') is distinct from 'string' then
        raise exception 'order_id must be a string or null'
          using errcode = '22023';
      else
        v_tx_order := nullif(pg_catalog.btrim(v_tx ->> 'order_id'), '');
      end if;

      if pg_catalog.jsonb_typeof(v_tx -> 'tx_type') is distinct from 'number'
      or coalesce(v_tx ->> 'tx_type', '') !~ '^-?[0-9]+$' then
        raise exception 'tx_type must be an integer'
          using errcode = '22023';
      end if;

      begin
        v_tx_type := (v_tx ->> 'tx_type')::integer;
      exception
        when numeric_value_out_of_range then
          raise exception 'tx_type must be an integer'
            using errcode = '22023';
      end;

      if v_tx -> 'amount' is null
      or pg_catalog.jsonb_typeof(v_tx -> 'amount') not in ('number', 'string') then
        raise exception 'amount must be a finite number'
          using errcode = '22023';
      end if;

      begin
        v_tx_amount := app.pos_money ((v_tx ->> 'amount')::numeric);
      exception
        when invalid_text_representation
        or numeric_value_out_of_range
        or invalid_parameter_value then
          raise exception 'amount must be a finite number'
            using errcode = '22023';
      end;

      if pg_catalog.jsonb_typeof(v_tx -> 'occurred_at') is distinct from 'string' then
        raise exception 'occurred_at must be a finite timestamp'
          using errcode = '22023';
      end if;

      begin
        v_tx_at := (v_tx ->> 'occurred_at')::timestamptz;
      exception
        when invalid_datetime_format
        or datetime_field_overflow
        or invalid_text_representation then
          raise exception 'occurred_at must be a finite timestamp'
            using errcode = '22023';
      end;

      if v_tx_at is null or not pg_catalog.isfinite(v_tx_at) then
        raise exception 'occurred_at must be a finite timestamp'
          using errcode = '22023';
      end if;

      v_clean := v_clean || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'tx_id',
          v_tx_id,
          'order_id',
          v_tx_order,
          'tx_type',
          v_tx_type,
          'amount',
          v_tx_amount,
          'occurred_at',
          v_tx_at
        )
      );
    end loop;


    with
      upserted as (
        insert into
          app.pos_shifts (
            id,
            opened_at,
            closed_at,
            is_active,
            pos_update_time,
            drawer_cash_net,
            drawer_credit,
            synced_at
          )
        values
          (
            v_shift ->> 'id',
            (v_shift ->> 'opened_at')::timestamptz,
            case
              when v_shift -> 'closed_at' is null
              or v_shift -> 'closed_at' = 'null'::jsonb then null
              else (v_shift ->> 'closed_at')::timestamptz
            end,
            (v_shift ->> 'is_active')::boolean,
            (v_shift ->> 'pos_update_time')::timestamptz,
            v_drawer_cash,
            v_drawer_credit,
            pg_catalog.now()
          )
        on conflict (id) do update
        set
          opened_at = excluded.opened_at,
          closed_at = excluded.closed_at,
          is_active = excluded.is_active,
          pos_update_time = excluded.pos_update_time,
          drawer_cash_net = excluded.drawer_cash_net,
          drawer_credit = excluded.drawer_credit,
          synced_at = pg_catalog.now()
        where
          app.pos_shifts.pos_update_time <= excluded.pos_update_time
        returning
          id
      )
    select
      pg_catalog.count(*)::int
    into v_shift_wrote
    from
      upserted;

    if v_shift_wrote = 0 then
      v_shifts_skipped := v_shifts_skipped + 1;
    else
      v_shifts_upserted := v_shifts_upserted + 1;
    end if;

    -- Whenever presented, not only when the shift row is written. The
    -- subcollection can change while updateTime does not. One run is running
    -- at a time, this function locks that run, and the presented array is the
    -- complete subcollection read. Shifts are sent on the first chunk only.
    select
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'tx_id',
            tx.tx_id,
            'order_id',
            tx.order_id,
            'tx_type',
            tx.tx_type,
            'amount',
            tx.amount,
            'occurred_at',
            tx.occurred_at
          )
          order by
            tx.tx_id
        ),
        '[]'::jsonb
      )
    into v_old_txs
    from
      app.pos_shift_transactions tx
    where
      tx.shift_id = v_shift ->> 'id';

    delete from app.pos_shift_transactions
    where
      shift_id = v_shift ->> 'id';

    insert into
      app.pos_shift_transactions (
        shift_id,
        tx_id,
        order_id,
        tx_type,
        amount,
        occurred_at
      )
    select
      v_shift ->> 'id',
      e.value ->> 'tx_id',
      e.value ->> 'order_id',
      (e.value ->> 'tx_type')::integer,
      (e.value ->> 'amount')::numeric(14, 2),
      (e.value ->> 'occurred_at')::timestamptz
    from
      pg_catalog.jsonb_array_elements(v_clean) as e (value)
    order by
      e.value ->> 'tx_id';

    v_transactions := v_transactions + coalesce(pg_catalog.jsonb_array_length(v_clean), 0);

    -- Remember the normalized sets. Revisions are appended after orders so a
    -- delete/insert with the same accounting fields does not become a revision
    -- by itself, and cost inputs see the new set.
    v_pending_shifts := v_pending_shifts || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'shift_id',
        v_shift ->> 'id',
        'before',
        v_old_txs,
        'after',
        v_clean
      )
    );

    update app.pos_sync_runs as run
    set
      presented_shift_ids = (
        select
          coalesce(
            pg_catalog.array_agg(distinct presented.shift_id order by presented.shift_id),
            '{}'::text[]
          )
        from
          pg_catalog.unnest(
            run.presented_shift_ids || array[v_shift ->> 'id']::text[]
          ) as presented (shift_id)
      )
    where
      run.id = p_run_id;
  end loop;

  for v_order in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_orders) as e (value)
    order by
      e.value ->> 'id'
  loop
    if pg_catalog.jsonb_typeof(v_order) <> 'object' then
      raise exception 'each order must be a jsonb object'
        using errcode = '22023';
    end if;

    v_order_id := v_order ->> 'id';
    v_shift_id := v_order ->> 'shift_id';
    v_status_order := v_order ->> 'status';
    v_hash := v_order ->> 'content_hash';
    v_ordered_at := (v_order ->> 'ordered_at')::timestamptz;
    v_update_time := (v_order ->> 'pos_update_time')::timestamptz;

    if v_shift_id is null or length(pg_catalog.btrim(v_shift_id)) = 0 then
      raise exception 'shift_id is required'
        using errcode = '22023';
    end if;

    if v_ordered_at is null or not pg_catalog.isfinite(v_ordered_at) then
      raise exception 'ordered_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    if v_update_time is null or not pg_catalog.isfinite(v_update_time) then
      raise exception 'pos_update_time must be a finite timestamp'
        using errcode = '22023';
    end if;

    if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'content_hash must be a sha256 hex digest'
        using errcode = '22023';
    end if;

    v_lines := v_order -> 'lines';

    if v_lines is null or v_lines = 'null'::jsonb then
      v_lines := '[]'::jsonb;
    end if;

    insert into
      app.pos_sync_run_orders (run_id, order_id)
    values
      (p_run_id, v_order_id)
    on conflict (run_id, order_id) do nothing;

    v_attempts := 0;

    loop
      v_attempts := v_attempts + 1;

      if v_attempts > 3 then
        raise exception 'could not lock POS order'
          using errcode = '40001';
      end if;

      select
        o.*
      into v_existing
      from
        app.pos_orders o
      where
        o.id = v_order_id
      for update;

      if not found then
        v_conflict := false;

        begin
          insert into
            app.pos_orders (
              id,
              order_number,
              shift_id,
              status,
              order_type,
              payment_type,
              ordered_at,
              subtotal,
              discount,
              tax,
              service_tax,
              delivery_fee,
              total,
              financial_revision,
              last_financial_operation_key,
              pos_update_time,
              content_hash,
              version,
              missing_from_pos,
              first_synced_at,
              last_synced_at
            )
          values
            (
              v_order_id,
              case
                when v_order -> 'order_number' is null
                or v_order -> 'order_number' = 'null'::jsonb then null
                else (v_order ->> 'order_number')::int
              end,
              v_shift_id,
              v_status_order,
              nullif(pg_catalog.btrim(v_order ->> 'order_type'), ''),
              nullif(pg_catalog.btrim(v_order ->> 'payment_type'), ''),
              v_ordered_at,
              app.pos_money ((v_order ->> 'subtotal')::numeric),
              app.pos_money ((v_order ->> 'discount')::numeric),
              app.pos_money ((v_order ->> 'tax')::numeric),
              app.pos_money ((v_order ->> 'service_tax')::numeric),
              app.pos_money ((v_order ->> 'delivery_fee')::numeric),
              app.pos_money ((v_order ->> 'total')::numeric),
              case
                when v_order -> 'financial_revision' is null
                or v_order -> 'financial_revision' = 'null'::jsonb then null
                else (v_order ->> 'financial_revision')::int
              end,
              nullif(
                pg_catalog.btrim(v_order ->> 'last_financial_operation_key'),
                ''
              ),
              v_update_time,
              v_hash,
              1,
              false,
              pg_catalog.now(),
              pg_catalog.now()
            );
        exception
          when unique_violation then
            v_conflict := true;
        end;

        if v_conflict then
          continue;
        end if;

        perform app.replace_pos_order_lines (v_order_id, v_lines);

        -- Version is already stored. Capture the lines just written, not a trigger.
        perform app.capture_pos_order_snapshot (v_order_id, p_run_id, 'sync');

        v_cost_orders := v_cost_orders || v_order_id;
        v_inserted := v_inserted + 1;
        exit;
      elsif v_update_time < v_existing.pos_update_time then
        -- The payload is older than the stored document. Presence in this read
        -- still means the order is not missing.
        if v_existing.missing_from_pos then
          update app.pos_orders
          set
            missing_from_pos = false
          where
            id = v_order_id;

          v_cost_orders := v_cost_orders || v_order_id;
        end if;

        v_stale := v_stale + 1;
        exit;
      elsif v_update_time = v_existing.pos_update_time
      and v_hash = v_existing.content_hash then
        if v_existing.missing_from_pos then
          update app.pos_orders
          set
            missing_from_pos = false,
            last_synced_at = pg_catalog.now()
          where
            id = v_order_id;

          v_cost_orders := v_cost_orders || v_order_id;
          v_updated := v_updated + 1;
        else
          v_unchanged := v_unchanged + 1;
        end if;

        exit;
      else
        update app.pos_orders
        set
          order_number = case
            when v_order -> 'order_number' is null
            or v_order -> 'order_number' = 'null'::jsonb then null
            else (v_order ->> 'order_number')::int
          end,
          shift_id = v_shift_id,
          status = v_status_order,
          order_type = nullif(pg_catalog.btrim(v_order ->> 'order_type'), ''),
          payment_type = nullif(pg_catalog.btrim(v_order ->> 'payment_type'), ''),
          ordered_at = v_ordered_at,
          subtotal = app.pos_money ((v_order ->> 'subtotal')::numeric),
          discount = app.pos_money ((v_order ->> 'discount')::numeric),
          tax = app.pos_money ((v_order ->> 'tax')::numeric),
          service_tax = app.pos_money ((v_order ->> 'service_tax')::numeric),
          delivery_fee = app.pos_money ((v_order ->> 'delivery_fee')::numeric),
          total = app.pos_money ((v_order ->> 'total')::numeric),
          financial_revision = case
            when v_order -> 'financial_revision' is null
            or v_order -> 'financial_revision' = 'null'::jsonb then null
            else (v_order ->> 'financial_revision')::int
          end,
          last_financial_operation_key = nullif(
            pg_catalog.btrim(v_order ->> 'last_financial_operation_key'),
            ''
          ),
          pos_update_time = v_update_time,
          content_hash = v_hash,
          version = app.pos_orders.version + 1,
          missing_from_pos = false,
          last_synced_at = pg_catalog.now()
        where
          id = v_order_id;

        perform app.replace_pos_order_lines (v_order_id, v_lines);

        -- Version is already stored. Capture the lines just written, not a trigger.
        perform app.capture_pos_order_snapshot (v_order_id, p_run_id, 'sync');

        v_cost_orders := v_cost_orders || v_order_id;
        v_updated := v_updated + 1;
        exit;
      end if;
    end loop;
  end loop;

  if v_scope_key is not null then
    -- Update in id order, matching the per-order lock order above.
    for v_missing_id in
      select
        o.id
      from
        app.pos_orders o
      where
        o.missing_from_pos = false
        and o.last_synced_at < v_started_at
        and not exists (
          select
            1
          from
            app.pos_sync_run_orders s
          where
            s.run_id = p_run_id
            and s.order_id = o.id
        )
        and (
          v_scope_key = 'all'
          or (
            v_scope_key = 'from'
            and o.ordered_at >= v_from
          )
          or (
            v_scope_key = 'shift_ids'
            and o.shift_id in (
              select
                pg_catalog.jsonb_array_elements_text(p_scope -> 'shift_ids')
            )
          )
        )
      order by
        o.id
    loop
      update app.pos_orders
      set
        missing_from_pos = true
      where
        id = v_missing_id
        and missing_from_pos = false;

      if found then
        v_missing := v_missing + 1;
        v_cost_orders := v_cost_orders || v_missing_id;
      end if;
    end loop;

    update app.pos_sync_runs
    set
      scope_applied = true,
      scope_kind = v_scope_key,
      scope_from = case
        when v_scope_key = 'from' then v_from
        else null
      end,
      scope_shift_ids = case
        when v_scope_key = 'shift_ids' then coalesce(
          (
            select
              pg_catalog.array_agg(distinct scope_shift.value order by scope_shift.value)
            from
              pg_catalog.jsonb_array_elements_text(p_scope -> 'shift_ids') as scope_shift (value)
          ),
          '{}'::text[]
        )
        else '{}'::text[]
      end
    where
      id = p_run_id;
  end if;

  -- Refund revisions, then one cost input per affected order, after the
  -- mirror writes. Orders already locked above stay locked. Any other order
  -- is locked here in id order. This does not take the posting lock.
  v_refund_orders := app.capture_pos_refund_revisions (p_run_id, v_pending_shifts);
  v_cost_orders := v_cost_orders || coalesce(v_refund_orders, '{}'::text[]);

  for v_cost_order in
    select distinct
      candidate.order_id
    from
      pg_catalog.unnest(v_cost_orders) as candidate (order_id)
    where
      candidate.order_id is not null
      and exists (
        select
          1
        from
          app.pos_orders existing_order
        where
          existing_order.id = candidate.order_id
      )
    order by
      candidate.order_id
  loop
    perform app.append_pos_cost_input (v_cost_order, p_run_id, 'sync');
  end loop;

  return pg_catalog.jsonb_build_object(
    'inserted',
    v_inserted,
    'updated',
    v_updated,
    'unchanged',
    v_unchanged,
    'stale',
    v_stale,
    'missing',
    v_missing,
    'shifts_upserted',
    v_shifts_upserted,
    'shifts_skipped',
    v_shifts_skipped,
    'transactions',
    v_transactions
  );
end;
$$;

comment on function app.ingest_pos_batch (bigint, jsonb, jsonb, jsonb) is 'Upserts POS shifts and orders for one chunk of a run. Replaces an order only when the incoming document is newer, or the same update time with a different content hash. Replaces every presented shift''s transactions even when the shift row is skipped as older, because the subcollection can change without a new updateTime and only one sync run is running. Marks orders missing only when p_scope is set, the order id was not presented to this run, and last_synced_at is earlier than the run started_at. After each accepted version, copies an accounting snapshot of the lines just stored. Appends refund revisions only when the normalized transaction set changed, then appends a cost input when that digest changed. Does not post stock and does not take the ledger posting lock.';

revoke all on function app.ingest_pos_batch (bigint, jsonb, jsonb, jsonb)
from
  public,
  anon;

grant
execute on function app.ingest_pos_batch (bigint, jsonb, jsonb, jsonb) to authenticated,
service_role;

-- ============================================================================
-- 7. record_count. Latest definition: 20261022010000_counts.sql.
-- The sync-covered check still selects the newest ok run and still returns
-- waiting_for_sync. It also requires that run's pos_sync_coverage to cover
-- the shifts opened at or before the count, unless the row is legacy_direct.
-- ============================================================================
create or replace function app.record_count (p_count jsonb) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_request_text text;
  v_request_id uuid;
  v_frequency text;
  v_at_text text;
  v_counted_at timestamptz;
  v_note text;
  v_elem jsonb;
  v_item_text text;
  v_item_id uuid;
  v_qty_text text;
  v_raw numeric;
  v_whole text;
  v_qty numeric(20, 6);
  v_seen uuid[] := '{}'::uuid[];
  v_item_ids uuid[] := '{}'::uuid[];
  v_counted numeric(20, 6) [] := '{}'::numeric(20, 6) [];
  v_counted_text text[] := '{}'::text[];
  v_expected_units text[] := '{}'::text[];
  v_unit_text text;
  v_base_unit text;
  v_n integer := 0;
  v_existing_id uuid;
  v_existing_frequency text;
  v_existing_at timestamptz;
  v_existing_note text;
  v_lines jsonb;
  v_payload jsonb;
  v_stored_payload jsonb;
  v_prepared timestamptz;
  v_sync_id bigint;
  v_sync_started timestamptz;
  v_sync_finished timestamptz;
  v_cov_applied boolean;
  v_cov_kind text;
  v_cov_from timestamptz;
  v_cov_shifts text[];
  v_cov_presented text[];
  v_cov_legacy boolean;
  v_close_recorded timestamptz;
  v_has_prior_shift boolean := false;
  v_active boolean;
  v_item_frequency text;
  v_bal app.item_balances;
  v_expected numeric(20, 6) [] := '{}'::numeric(20, 6) [];
  v_deltas numeric(20, 6) [] := '{}'::numeric(20, 6) [];
  v_movements jsonb := '[]'::jsonb;
  v_count_id uuid;
  v_movement_id bigint;
  v_delta_qty numeric(20, 6);
  v_delta_value numeric(14, 2);
begin
  perform app.assert_ledger_write_allowed ();

  if p_count is null or pg_catalog.jsonb_typeof(p_count) <> 'object' then
    raise exception 'p_count must be a jsonb object'
      using errcode = '22023';
  end if;

  if p_count ? 'note'
  and pg_catalog.jsonb_typeof(p_count -> 'note') not in ('string', 'null') then
    raise exception 'note must be text'
      using errcode = '22023';
  end if;

  v_request_text := nullif(pg_catalog.btrim(p_count ->> 'request_id'), '');

  if v_request_text is null
  or v_request_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  v_request_id := v_request_text::uuid;

  if pg_catalog.jsonb_typeof(p_count -> 'frequency') is distinct from 'string' then
    raise exception 'frequency must be daily or weekly'
      using errcode = '22023';
  end if;

  v_frequency := pg_catalog.btrim(p_count ->> 'frequency');

  if v_frequency not in ('daily', 'weekly') then
    raise exception 'frequency must be daily or weekly'
      using errcode = '22023';
  end if;

  v_at_text := nullif(pg_catalog.btrim(p_count ->> 'counted_at'), '');

  if v_at_text is null then
    raise exception 'counted_at is required'
      using errcode = '22023';
  end if;

  begin
    v_counted_at := v_at_text::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception 'counted_at must be a finite timestamp'
        using errcode = '22023';
  end;

  if v_counted_at is null or not pg_catalog.isfinite(v_counted_at) then
    raise exception 'counted_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  v_note := nullif(pg_catalog.btrim(p_count ->> 'note'), '');

  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    raise exception 'note must be at most 500 characters'
      using errcode = '22023';
  end if;

  perform app.assert_no_phone_text (v_note);

  if pg_catalog.jsonb_typeof(p_count -> 'lines') is distinct from 'array'
  or pg_catalog.jsonb_array_length(p_count -> 'lines') < 1
  or pg_catalog.jsonb_array_length(p_count -> 'lines') > 200 then
    raise exception 'lines must be a jsonb array of 1 to 200 lines'
      using errcode = '22023';
  end if;

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_count -> 'lines') as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each count line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_text := nullif(pg_catalog.btrim(v_elem ->> 'item_id'), '');
    v_qty_text := nullif(pg_catalog.btrim(v_elem ->> 'counted_qty'), '');

    if v_item_text is null or v_qty_text is null then
      raise exception 'item_id and counted_qty are required'
        using errcode = '22023';
    end if;

    if v_item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'item_id must be a uuid'
        using errcode = '22023';
    end if;

    v_item_id := v_item_text::uuid;

    if v_item_id = any (v_seen) then
      raise exception 'duplicate item'
        using errcode = '22023';
    end if;

    if v_qty_text !~ '^\d+(\.\d+)?$' then
      raise exception 'counted_qty must be a finite number >= 0'
        using errcode = '22023';
    end if;

    if v_qty_text ~ '\.\d{7,}' then
      raise exception 'counted_qty must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    v_whole := pg_catalog.ltrim(pg_catalog.split_part(v_qty_text, '.', 1), '0');

    if v_whole = '' then
      v_whole := '0';
    end if;

    if pg_catalog.char_length(v_whole) > 14 then
      raise exception 'counted_qty is out of range'
        using errcode = '22023';
    end if;

    begin
      v_raw := v_qty_text::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'counted_qty must be a finite number >= 0'
          using errcode = '22023';
    end;

    if v_raw <> pg_catalog.round(v_raw, 6) then
      raise exception 'counted_qty must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    if v_raw >= 100000000000000 then
      raise exception 'counted_qty is out of range'
        using errcode = '22023';
    end if;

    v_qty := v_raw;
    v_unit_text := nullif(pg_catalog.btrim(v_elem ->> 'expected_base_unit'), '');

    if v_unit_text is null then
      raise exception 'expected_base_unit is required'
        using errcode = '22023';
    end if;

    v_seen := v_seen || v_item_id;
    v_item_ids := v_item_ids || v_item_id;
    v_counted := v_counted || v_qty;
    -- Exact decimal text. A JSON number would lose digits in JavaScript.
    v_counted_text := v_counted_text || v_qty::text;
    v_expected_units := v_expected_units || v_unit_text;
    v_n := v_n + 1;
  end loop;

  select
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'item_id',
        u.item_id,
        'counted_qty',
        u.counted_text,
        'expected_base_unit',
        u.expected_base_unit
      )
      order by
        u.line_no
    )
  into v_lines
  from
    rows from (
      pg_catalog.unnest(v_item_ids),
      pg_catalog.unnest(v_counted_text),
      pg_catalog.unnest(v_expected_units)
    ) with ordinality as u (item_id, counted_text, expected_base_unit, line_no);

  -- Built once from the normalized fields. counted_qty is numeric(20, 6)
  -- text and expected_base_unit is trimmed text, so the prepare replay and
  -- the posted replay compare one form. Key order stays stable, and a caller
  -- clock is not part of it.
  v_payload := pg_catalog.jsonb_build_object(
    'request_id',
    v_request_id,
    'frequency',
    v_frequency,
    'counted_at',
    v_counted_at,
    'note',
    v_note,
    'lines',
    v_lines
  );

  -- Replay compares the normalized payload only. No catalog, shift, sync,
  -- or balance read has happened yet. A posted replay returns before the
  -- watermark update.
  select
    counted.id,
    counted.frequency,
    counted.counted_at,
    counted.note
  into
    v_existing_id,
    v_existing_frequency,
    v_existing_at,
    v_existing_note
  from
    app.stock_counts counted
  where
    counted.request_id = v_request_id;

  if found then
    if v_existing_frequency is distinct from v_frequency
    or v_existing_at is distinct from v_counted_at
    or v_existing_note is distinct from v_note
    or (
      select
        count(*)
      from
        app.stock_count_lines line
      where
        line.count_id = v_existing_id
    ) is distinct from v_n::bigint
    or exists (
      select
        1
      from
        rows from (
          pg_catalog.unnest(v_item_ids),
          pg_catalog.unnest(v_counted_text),
          pg_catalog.unnest(v_expected_units)
        ) with ordinality as u (item_id, counted_text, expected_base_unit, line_no)
        join app.stock_count_lines line on line.count_id = v_existing_id
        and line.line_no = u.line_no
      where
        line.item_id is distinct from u.item_id
        or line.counted_qty::text is distinct from u.counted_text
        or line.expected_base_unit is distinct from u.expected_base_unit
    ) then
      raise exception 'request_id already used for a different count'
        using errcode = '22023';
    end if;

    return pg_catalog.jsonb_build_object(
      'status',
      'posted',
      'count_id',
      v_existing_id
    );
  end if;

  -- The coverage read and the shift guards must see one mirror state. POS
  -- ingest does not take the posting lock, so under read committed a close
  -- committed between those statements could pass the guards without its
  -- stamp in the coverage check. SHARE mode blocks shift inserts and updates
  -- until this transaction ends and waits for any in-flight ingest to commit
  -- first. Ingest never waits on the posting lock, so no lock cycle exists.
  lock table app.pos_shifts in share mode;

  select
    request.payload,
    request.prepared_at
  into
    v_stored_payload,
    v_prepared
  from
    app.stock_count_requests request
  where
    request.request_id = v_request_id;

  if not found then
    if exists (
      select
        1
      from
        app.pos_shifts shift
      where
        shift.closed_at is not null
        and shift.opened_at <= v_counted_at
        and v_counted_at < shift.closed_at
    ) then
      raise exception 'count time is inside a shift'
        using errcode = '22023';
    end if;

    if exists (
      select
        1
      from
        app.pos_shifts shift
      where
        shift.closed_at is null
        and shift.opened_at <= v_counted_at
    ) then
      raise exception 'a shift is still open'
        using errcode = '22023';
    end if;

    for v_i in 1..v_n loop
      select
        item.active,
        item.count_frequency,
        item.base_unit
      into
        v_active,
        v_item_frequency,
        v_base_unit
      from
        app.stock_items item
      where
        item.id = v_item_ids[v_i];

      if not found then
        raise exception 'unknown stock item'
          using errcode = '22023';
      end if;

      if v_active is not true then
        raise exception 'item is inactive'
          using errcode = '22023';
      end if;

      if v_item_frequency is distinct from v_frequency then
        raise exception 'item count frequency does not match'
          using errcode = '22023';
      end if;

      if v_expected_units[v_i] is distinct from v_base_unit then
        raise exception 'item base unit changed'
          using errcode = '22023';
      end if;
    end loop;

    insert into app.stock_count_requests (
      request_id,
      payload,
      prepared_at,
      created_by
    )
    values
      (
        v_request_id,
        v_payload,
        pg_catalog.clock_timestamp(),
        auth.uid()
      );

    return pg_catalog.jsonb_build_object('status', 'waiting_for_sync');
  end if;

  if v_stored_payload is distinct from v_payload then
    raise exception 'request_id already used for a different count'
      using errcode = '22023';
  end if;

  -- Overlapping shifts are possible, so take the latest close stamp of every
  -- shift opened at or before the count, not the stamp of the latest-opened
  -- one. The run must start after that stamp and after this submit. Both
  -- comparisons use the database clock. counted_at is not one of them.
  select
    pg_catalog.max(shift.close_recorded_at),
    pg_catalog.count(*) > 0
  into
    v_close_recorded,
    v_has_prior_shift
  from
    app.pos_shifts shift
  where
    shift.opened_at <= v_counted_at;

  select
    run.id,
    run.started_at,
    run.finished_at
  into
    v_sync_id,
    v_sync_started,
    v_sync_finished
  from
    app.pos_sync_runs run
  where
    run.status = 'ok'
  order by
    run.id desc
  limit
    1;

  if v_sync_finished is null
  or v_sync_started is null
  or v_sync_started <= v_prepared
  or (
    v_has_prior_shift
    and (
      v_close_recorded is null
      or v_sync_started <= v_close_recorded
    )
  ) then
    return pg_catalog.jsonb_build_object('status', 'waiting_for_sync');
  end if;

  -- The time check above is unchanged. Coverage then proves that this same
  -- newest ok run actually completed a read of the shifts opened by the count.
  -- legacy_direct is a finished ok row that was not closed by finish_pos_sync_run.
  -- Otherwise the run needs an applied order scope covering every shift opened
  -- at or before the count, and its transaction subcollection must have been
  -- replaced for each of those shifts. An unknown scope (null kind: applied
  -- before scope_kind existed) makes the helper return null, which is not
  -- covered.
  select
    cov.orders_scope_applied,
    cov.scope_kind,
    cov.scope_from,
    cov.scope_shift_ids,
    cov.presented_shift_ids,
    cov.legacy_direct
  into
    v_cov_applied,
    v_cov_kind,
    v_cov_from,
    v_cov_shifts,
    v_cov_presented,
    v_cov_legacy
  from
    app.pos_sync_coverage cov
  where
    cov.run_id = v_sync_id;

  if not found
  or v_cov_legacy is not true then
    if not found
    or v_cov_applied is not true
    or app.pos_sync_scope_covers_count (
      v_cov_applied,
      v_cov_kind,
      v_cov_from,
      v_cov_shifts,
      v_counted_at
    ) is not true
    or exists (
      select
        1
      from
        app.pos_shifts shift
      where
        shift.opened_at <= v_counted_at
        and shift.id <> all (coalesce(v_cov_presented, '{}'::text[]))
    ) then
      return pg_catalog.jsonb_build_object('status', 'waiting_for_sync');
    end if;
  end if;

  if exists (
    select
      1
    from
      app.pos_shifts shift
    where
      shift.closed_at is not null
      and shift.opened_at <= v_counted_at
      and v_counted_at < shift.closed_at
  ) then
    raise exception 'count time is inside a shift'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      app.pos_shifts shift
    where
      shift.closed_at is null
      and shift.opened_at <= v_counted_at
  ) then
    raise exception 'a shift is still open'
      using errcode = '22023';
  end if;

  for v_i in 1..v_n loop
    select
      item.active,
      item.count_frequency,
      item.base_unit
    into
      v_active,
      v_item_frequency,
      v_base_unit
    from
      app.stock_items item
    where
      item.id = v_item_ids[v_i];

    if not found then
      raise exception 'unknown stock item'
        using errcode = '22023';
    end if;

    if v_active is not true then
      raise exception 'item is inactive'
        using errcode = '22023';
    end if;

    if v_item_frequency is distinct from v_frequency then
      raise exception 'item count frequency does not match'
        using errcode = '22023';
    end if;

    if v_expected_units[v_i] is distinct from v_base_unit then
      raise exception 'item base unit changed'
        using errcode = '22023';
    end if;
  end loop;

  for v_i in 1..v_n loop
    v_bal := app.lock_and_validate_item_balance (v_item_ids[v_i], v_counted_at);
    v_expected := v_expected || v_bal.on_hand_qty;
    v_deltas := v_deltas || (v_counted[v_i] - v_bal.on_hand_qty);
  end loop;

  for v_i in 1..v_n loop
    if v_deltas[v_i] <> 0 then
      v_movements := v_movements || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id',
          v_item_ids[v_i],
          'movement_type',
          'count_adjustment',
          'occurred_at',
          v_counted_at,
          'quantity',
          v_deltas[v_i]::text
        )
      );
    end if;
  end loop;

  if pg_catalog.jsonb_array_length(v_movements) > 0 then
    v_count_id := app.post_movements (v_movements);
  else
    v_count_id := pg_catalog.gen_random_uuid ();
  end if;

  insert into
    app.stock_counts (
      id,
      request_id,
      frequency,
      counted_at,
      note,
      created_by
    )
  values
    (
      v_count_id,
      v_request_id,
      v_frequency,
      v_counted_at,
      v_note,
      auth.uid ()
    );

  for v_i in 1..v_n loop
    if v_deltas[v_i] = 0 then
      insert into
        app.stock_count_lines (
          count_id,
          line_no,
          item_id,
          expected_base_unit,
          counted_qty,
          expected_qty,
          delta_qty,
          delta_value,
          movement_id
        )
      values
        (
          v_count_id,
          v_i,
          v_item_ids[v_i],
          v_expected_units[v_i],
          v_counted[v_i],
          v_expected[v_i],
          0,
          0,
          null
        );
    else
      begin
        select
          movement.id,
          movement.quantity,
          movement.total_cost
        into strict
          v_movement_id,
          v_delta_qty,
          v_delta_value
        from
          app.stock_movements movement
        where
          movement.batch_id = v_count_id
          and movement.item_id = v_item_ids[v_i]
          and movement.movement_type = 'count_adjustment';
      exception
        when no_data_found or too_many_rows then
          raise exception 'count adjustment was not posted'
            using errcode = 'P0001';
      end;

      if v_delta_qty is distinct from v_deltas[v_i] then
        raise exception 'count delta does not match the posted movement'
          using errcode = 'P0001';
      end if;

      insert into
        app.stock_count_lines (
          count_id,
          line_no,
          item_id,
          expected_base_unit,
          counted_qty,
          expected_qty,
          delta_qty,
          delta_value,
          movement_id
        )
      values
        (
          v_count_id,
          v_i,
          v_item_ids[v_i],
          v_expected_units[v_i],
          v_counted[v_i],
          v_expected[v_i],
          v_delta_qty,
          v_delta_value,
          v_movement_id
        );
    end if;
  end loop;

  -- A count is an observation at counted_at. The ledger refuses only
  -- occurred_at < last_occurred_at, so a movement at exactly counted_at
  -- would still pass. One microsecond past the count makes any later
  -- movement at or before counted_at back-dated. Replay returns before
  -- this update. A zero delta is included. lock_and_validate_item_balance
  -- already inserted a zero balance row when the item had never moved.
  update app.item_balances as balance
  set
    last_occurred_at = greatest (
      coalesce(balance.last_occurred_at, v_counted_at),
      v_counted_at + interval '1 microsecond'
    )
  where
    balance.item_id = any (v_item_ids);

  return pg_catalog.jsonb_build_object(
    'status',
    'posted',
    'count_id',
    v_count_id
  );
end;
$$;

comment on function app.record_count (jsonb) is 'Prepares, then posts, one stock count. Takes advisory lock 7342750000000000001 first, validates the payload, and replays request_id against stock_counts before any catalog, shift, sync, or balance read. The same normalized payload returns {"status":"posted","count_id":...} and does not post again. counted_qty is stored as numeric(20, 6) text, not a JSON number, and both the prepare replay and the posted replay compare that same text and the trimmed expected_base_unit. A missing or blank expected_base_unit raises 22023 expected_base_unit is required. The first submit and the post both raise 22023 item base unit changed when that unit differs from stock_items.base_unit. A different payload raises 22023 request_id already used for a different count. The first submit stores stock_count_requests with prepared_at = clock_timestamp() and returns {"status":"waiting_for_sync"} without raising, after the shift and item guards. The owner submits only after the physical count, so prepared_at is after the count. A later call with the same payload waits until the newest ok pos_sync_runs row, by id, has finished_at not null, started_at > prepared_at, and started_at > the latest close_recorded_at among shifts with opened_at <= counted_at. Those times are all the database clock. started_at is not compared with counted_at. Sale and shift times are POS-clock and are compared with counted_at only to place movements before or after the count. When that run exists, every guard runs again on the fresh mirror, then non-zero deltas post as one count_adjustment batch (actual minus locked on-hand). After the post, last_occurred_at moves to counted_at plus one microsecond so a later movement at or before the count is back-dated. A sale still missing is refused by that watermark until a later recompute. The same newest ok run must also have app.pos_sync_coverage. A legacy_direct row keeps the time check above. Any other row returns {"status":"waiting_for_sync"} unless that run applied a known order scope covering every shift with opened_at <= counted_at (all, shift_ids containing each such shift, or from at or before the earliest such opened_at; an unknown scope never covers) and its presented_shift_ids contain each such shift, so every one had its transaction subcollection replaced. finish_pos_sync_run does not require scope_applied. A failed finish writes no coverage row.';

revoke all on function app.record_count (jsonb)
from
  public,
  anon;

grant
execute on function app.record_count (jsonb) to authenticated,
service_role;

-- ============================================================================
-- 8. Backfill. Bounded by the current mirror: one snapshot and one cost input
-- per order, one present refund revision per transaction that has none.
-- Ordered by id so a replay of the same mirror assigns identity values in
-- the same order. A second call finds the rows and appends nothing.
-- ============================================================================
select
  app.backfill_pos_accounting_inputs ();
