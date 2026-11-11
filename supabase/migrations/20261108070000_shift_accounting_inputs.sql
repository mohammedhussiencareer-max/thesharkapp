-- Shift accounting inputs (phase 5, PR 7).
--
-- Read models and append-only facts only. Order deductions stay dormant:
-- this file writes no inventory_activation row and does not change
-- record_count, ingest, or the ledger poster. No replaced function.
--
-- Lock order: the ledger advisory lock first, then pos_sync_runs in
-- ACCESS EXCLUSIVE mode NOWAIT, then the tables this migration triggers
-- or backfills, NOWAIT, in a fixed order.
--
-- Ingest does not take the advisory lock. Its first statement locks its
-- pos_sync_runs row (ROW SHARE on that table) and later inserts cost
-- inputs and refund revisions. SHARE ROW EXCLUSIVE admits ROW SHARE, so
-- a weaker lock on pos_sync_runs could let this migration wait in
-- CREATE TRIGGER while ingest waits on the ledger lock. ACCESS EXCLUSIVE
-- NOWAIT fails the migration at once with 55P03 instead. The sales-fact
-- triggers themselves take no advisory lock and do not lock the sync run,
-- so a later ingest keeps its own lock order.
-- ============================================================================
select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

do $lock_tables$
begin
  lock table app.pos_sync_runs in access exclusive mode nowait;

  lock table app.stock_items,
  app.pos_cost_inputs,
  app.pos_refund_revisions,
  app.pos_order_snapshots,
  app.pos_orders,
  app.pos_shifts,
  app.stock_counts,
  app.stock_count_lines,
  app.stock_count_anchors,
  app.stock_movements,
  app.period_revisions,
  app.month_expense_status,
  app.provisional_deficits,
  app.order_cost_state,
  app.order_disposition_state,
  app.accounting_work_events,
  app.accounting_work_state,
  app.order_cost_applications,
  app.waste_documents in share row exclusive mode nowait;
end;
$lock_tables$;

-- ============================================================================
-- 1. Tracking history for active and count_frequency.
-- A later catalog edit appends a row. It does not rewrite the row that was
-- in force at an earlier shift. The backfill's known_since is this
-- migration's clock: changes before it were not observed, so the current
-- values are not pretended to have been known at item creation.
-- ============================================================================
create table app.item_tracking_history (
  id bigint generated always as identity primary key,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  active boolean not null,
  count_frequency text not null check (count_frequency in ('daily', 'weekly')),
  known_since timestamptz not null check (pg_catalog.isfinite (known_since)),
  recorded_at timestamptz not null default pg_catalog.clock_timestamp () check (pg_catalog.isfinite (recorded_at)),
  basis text not null check (basis in ('observed', 'backfill'))
);

comment on table app.item_tracking_history is 'Append-only. One row each time a stock item is inserted or its active flag or count_frequency changes. known_since is when that pair became known: the item created_at on insert, the change clock on update, and this migration''s clock for the backfill of items that already existed. basis is observed for those trigger rows and backfill for the migration clock. A shift''s required roster reads the latest row with known_since at or before the shift opened. A later edit cannot remove an item from that roster. Unknown tracking is a backfill row for an item that already existed when the shift opened and still has no history at or before that open. An item created later is not unknown tracking. An empty roster is not the same cause.';

comment on column app.item_tracking_history.basis is 'observed when a trigger wrote the row from an insert or a real catalog change. backfill when this migration recorded items that already existed, at the migration clock. The clock is not rewritten to created_at.';

comment on column app.item_tracking_history.known_since is 'The earliest instant this active/count_frequency pair is known to have been in force. Not a guess about unobserved edits before the row was written.';

create index item_tracking_history_item_idx on app.item_tracking_history (item_id, known_since desc, id desc);

create trigger trg_item_tracking_history_no_update_delete
before update or delete on app.item_tracking_history for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_item_tracking_history_no_truncate
before truncate on app.item_tracking_history for each statement
execute function app.prevent_append_only_mutation ();

create function app.trg_stock_items_tracking_history () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  if tg_op = 'UPDATE'
  and new.active is not distinct from old.active
  and new.count_frequency is not distinct from old.count_frequency then
    return null;
  end if;

  insert into
    app.item_tracking_history (item_id, active, count_frequency, known_since, basis)
  values
    (
      new.id,
      new.active,
      new.count_frequency,
      case
        when tg_op = 'INSERT' then new.created_at
        else pg_catalog.clock_timestamp()
      end,
      'observed'
    );

  return null;
end;
$$;

comment on function app.trg_stock_items_tracking_history () is 'Appends one tracking row when a stock item is inserted or when active or count_frequency actually changes. A direct catalog update takes the same path as any other update. There is no session flag that skips it. Does not take the ledger lock.';

revoke all on function app.trg_stock_items_tracking_history ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_items_tracking_history
after insert or update of active,
count_frequency on app.stock_items for each row
execute function app.trg_stock_items_tracking_history ();

-- Replica mode skips ordinary triggers. Catalog history must still be written
-- when a session loads or updates rows that way, so a direct update cannot
-- drop the previous roster by turning triggers off.
alter table app.stock_items enable always trigger trg_stock_items_tracking_history;

insert into
  app.item_tracking_history (
    item_id,
    active,
    count_frequency,
    known_since,
    basis
  )
select
  item.id,
  item.active,
  item.count_frequency,
  pg_catalog.clock_timestamp (),
  'backfill'
from
  app.stock_items item
order by
  item.id;

create function app.item_roster_as_of (p_at timestamptz) returns table (
  item_id uuid,
  count_frequency text,
  known_since timestamptz
) language sql stable
set
  search_path = '' as $$
  select
    h.item_id,
    h.count_frequency,
    h.known_since
  from
    (
      select distinct
        on (t.item_id) t.item_id,
        t.count_frequency,
        t.known_since,
        t.active
      from
        app.item_tracking_history t
      where
        p_at is not null
        and pg_catalog.isfinite (p_at)
        and t.known_since <= p_at
      order by
        t.item_id,
        t.known_since desc,
        t.id desc
    ) h
  where
    h.active;
$$;

comment on function app.item_roster_as_of (timestamptz) is 'Active stock items and their count frequency as known at p_at. The latest tracking row with known_since at or before p_at wins. Inactive items are omitted. An item with no row yet is not required.';

revoke all on function app.item_roster_as_of (timestamptz)
from
  public,
  anon;

grant
execute on function app.item_roster_as_of (timestamptz) to authenticated,
service_role;

-- ============================================================================
-- 2. Sales revision facts, written from immutable inputs.
-- The first cost input of an order is its baseline recognition, not a
-- revision. A later input on the same shift records the net change. A later
-- input on a different shift records the removal on the old shift and the
-- new total on the new shift, even when the two totals are equal. Every
-- type-3 refund revision is one fact, keyed by the refund revision,
-- including a change whose net sales difference is zero. captured_at is the
-- immutable ingest clock and orders revisions. source_at is the economic
-- time and does not. recorded_at is when this row was materialized.
-- Re-ingest that inserts no new revision inserts no new fact. These writers
-- take no ledger lock.
-- ============================================================================
create table app.sales_revision_facts (
  id bigint generated always as identity primary key,
  source_kind text not null check (source_kind in ('order_total', 'refund')),
  source_revision_id bigint not null check (source_revision_id > 0),
  order_id text null check (
    order_id is null
    or length(pg_catalog.btrim (order_id)) > 0
  ),
  shift_id text not null check (length(pg_catalog.btrim (shift_id)) > 0),
  net_sales_difference numeric(14, 2) not null,
  captured_at timestamptz not null,
  source_at timestamptz not null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint sales_revision_facts_source_key unique (source_kind, source_revision_id, shift_id),
  constraint sales_revision_facts_finite_chk check (
    net_sales_difference not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and pg_catalog.isfinite (captured_at)
    and pg_catalog.isfinite (source_at)
    and pg_catalog.isfinite (recorded_at)
  )
);

comment on table app.sales_revision_facts is 'Append-only. One row per shift affected by a changed order recognition or a type-3 refund revision. source_kind, source_revision_id and shift_id are the immutable input and the shift the difference belongs to. A shift transfer is two rows for one cost input: the old recognized total removed from the old shift, and the new recognized total added to the new shift. net_sales_difference is the change in recognized sales on that shift. Refunds reduce sales when the refund amount rises. A zero difference is still a row when a refund revision was written. captured_at is the ingest clock and orders revisions. source_at is the economic time and does not. recorded_at is materialization time and is not the revision order. Replaying the same source and shift writes nothing.';

comment on column app.sales_revision_facts.net_sales_difference is 'Recognized sales after this source revision, minus recognized sales before it, on this shift. A transfer writes the full removal and the full addition, not only the net of the two totals. Positive means more net sales. Refund amounts use the opposite sign.';

comment on column app.sales_revision_facts.captured_at is 'Immutable ingest clock of the cost input or refund revision. An amount correction, a tombstone, and a missing or reappearance input keep this later clock even when the economic time does not move. Revision order uses this, not source_at and not recorded_at.';

comment on column app.sales_revision_facts.source_at is 'Economic time, kept apart from the ingest clock: the new snapshot pos_update_time (or ordered_at) for an order total, including both legs of a shift transfer, and the refund revision occurred_at for a refund. A later correction can reuse an earlier economic time.';

create index sales_revision_facts_shift_idx on app.sales_revision_facts (shift_id, captured_at, id);

create trigger trg_sales_revision_facts_no_update_delete
before update or delete on app.sales_revision_facts for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_sales_revision_facts_no_truncate
before truncate on app.sales_revision_facts for each statement
execute function app.prevent_append_only_mutation ();

create function app.note_order_total_sales_revision (p_input_id bigint) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_order text;
  v_revision integer;
  v_missing boolean;
  v_total numeric(14, 2);
  v_status text;
  v_shift text;
  v_captured_at timestamptz;
  v_source_at timestamptz;
  v_prev_missing boolean;
  v_prev_total numeric(14, 2);
  v_prev_status text;
  v_prev_shift text;
  v_new numeric(14, 2);
  v_old numeric(14, 2);
begin
  select
    input.order_id,
    input.input_revision,
    input.missing_from_pos,
    snap.total,
    snap.status,
    snap.shift_id,
    input.captured_at,
    coalesce(snap.pos_update_time, snap.ordered_at)
  into
    v_order,
    v_revision,
    v_missing,
    v_total,
    v_status,
    v_shift,
    v_captured_at,
    v_source_at
  from
    app.pos_cost_inputs input
    join app.pos_order_snapshots snap on snap.id = input.snapshot_id
  where
    input.id = p_input_id;

  if not found or v_revision is null or v_revision <= 1 then
    return;
  end if;

  select
    prev.missing_from_pos,
    snap.total,
    snap.status,
    snap.shift_id
  into
    v_prev_missing,
    v_prev_total,
    v_prev_status,
    v_prev_shift
  from
    app.pos_cost_inputs prev
    join app.pos_order_snapshots snap on snap.id = prev.snapshot_id
  where
    prev.order_id = v_order
    and prev.input_revision = v_revision - 1;

  if not found then
    v_old := 0;
    v_prev_shift := v_shift;
  else
    v_old := case
      when v_prev_status = 'complete'
      and v_prev_missing is not true then v_prev_total
      else 0
    end;
  end if;

  v_new := case
    when v_status = 'complete'
    and v_missing is not true then v_total
    else 0
  end;

  -- Same shift: one net delta, and an unchanged total is not a revision.
  if v_prev_shift is not distinct from v_shift then
    if v_new is not distinct from v_old then
      return;
    end if;

    insert into
      app.sales_revision_facts (
        source_kind,
        source_revision_id,
        order_id,
        shift_id,
        net_sales_difference,
        captured_at,
        source_at
      )
    values
      (
        'order_total',
        p_input_id,
        v_order,
        v_shift,
        (v_new - v_old)::numeric(14, 2),
        v_captured_at,
        v_source_at
      )
    on conflict (source_kind, source_revision_id, shift_id) do nothing;

    return;
  end if;

  -- Different shifts: the old shift loses its recognized total and the new
  -- shift gains the new total. Equal totals still move. A zero leg is omitted.
  if v_old is distinct from 0::numeric then
    insert into
      app.sales_revision_facts (
        source_kind,
        source_revision_id,
        order_id,
        shift_id,
        net_sales_difference,
        captured_at,
        source_at
      )
    values
      (
        'order_total',
        p_input_id,
        v_order,
        v_prev_shift,
        (- v_old)::numeric(14, 2),
        v_captured_at,
        v_source_at
      )
    on conflict (source_kind, source_revision_id, shift_id) do nothing;
  end if;

  if v_new is distinct from 0::numeric then
    insert into
      app.sales_revision_facts (
        source_kind,
        source_revision_id,
        order_id,
        shift_id,
        net_sales_difference,
        captured_at,
        source_at
      )
    values
      (
        'order_total',
        p_input_id,
        v_order,
        v_shift,
        v_new::numeric(14, 2),
        v_captured_at,
        v_source_at
      )
    on conflict (source_kind, source_revision_id, shift_id) do nothing;
  end if;
end;
$$;

comment on function app.note_order_total_sales_revision (bigint) is 'Appends order_total sales facts for a cost input after the first. Recognized total is the snapshot total only while the order is complete and not missing; otherwise it is zero. The same shift records the net change and writes nothing when that net is zero. A different shift records the old total removed from the old shift and the new total added to the new shift, including a move that does not change the total. Both legs use the cost input captured_at as the revision order and the snapshot pos_update_time (or ordered_at) as the economic source_at, including a missing or reappearance input that reuses an older snapshot. The first input is the baseline and writes nothing. A repeated call for the same input and shift writes nothing. Does not take the ledger lock.';

revoke all on function app.note_order_total_sales_revision (bigint)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.note_refund_sales_revision (p_revision_id bigint) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_row app.pos_refund_revisions;
  v_prev_present boolean;
  v_prev_type integer;
  v_prev_amount numeric(14, 2);
  v_prev_eff numeric(14, 2);
  v_new_eff numeric(14, 2);
begin
  select
    revision.*
  into
    v_row
  from
    app.pos_refund_revisions revision
  where
    revision.id = p_revision_id;

  if not found then
    return;
  end if;

  select
    revision.present,
    revision.tx_type,
    revision.amount
  into
    v_prev_present,
    v_prev_type,
    v_prev_amount
  from
    app.pos_refund_revisions revision
  where
    revision.shift_id = v_row.shift_id
    and revision.tx_id = v_row.tx_id
    and revision.id < v_row.id
  order by
    revision.id desc
  limit
    1;

  if v_row.tx_type is distinct from 3
  and v_prev_type is distinct from 3 then
    return;
  end if;

  v_prev_eff := case
    when v_prev_present is true
    and v_prev_type = 3 then v_prev_amount
    else 0
  end;

  v_new_eff := case
    when v_row.present
    and v_row.tx_type = 3 then v_row.amount
    else 0
  end;

  insert into
    app.sales_revision_facts (
      source_kind,
      source_revision_id,
      order_id,
      shift_id,
      net_sales_difference,
      captured_at,
      source_at
    )
  values
    (
      'refund',
      v_row.id,
      v_row.order_id,
      v_row.shift_id,
      (v_prev_eff - v_new_eff)::numeric(14, 2),
      v_row.captured_at,
      v_row.occurred_at
    )
  on conflict (source_kind, source_revision_id, shift_id) do nothing;
end;
$$;

comment on function app.note_refund_sales_revision (bigint) is 'Appends one refund sales fact for a type-3 revision, or for a revision that replaces a type-3 row. The difference is the previous effective refund amount minus the new one, so a larger refund reduces net sales. A zero difference is still stored. captured_at is the revision ingest clock, so an amount correction or tombstone captured later stays later even when occurred_at does not move. source_at keeps that economic occurred_at. Keyed by the revision id, so a repeated call writes nothing. Does not take the ledger lock. Drawer types that never were type 3 write nothing.';

revoke all on function app.note_refund_sales_revision (bigint)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.trg_pos_cost_inputs_sales_revision () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  perform app.note_order_total_sales_revision (new.id);

  return null;
end;
$$;

revoke all on function app.trg_pos_cost_inputs_sales_revision ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_pos_cost_inputs_sales_revision
after insert on app.pos_cost_inputs for each row
execute function app.trg_pos_cost_inputs_sales_revision ();

create function app.trg_pos_refund_revisions_sales_revision () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  perform app.note_refund_sales_revision (new.id);

  return null;
end;
$$;

revoke all on function app.trg_pos_refund_revisions_sales_revision ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_pos_refund_revisions_sales_revision
after insert on app.pos_refund_revisions for each row
execute function app.trg_pos_refund_revisions_sales_revision ();

do $backfill_sales_facts$
declare
  v_id bigint;
begin
  for v_id in
    select
      input.id
    from
      app.pos_cost_inputs input
    order by
      input.order_id,
      input.input_revision
  loop
    perform app.note_order_total_sales_revision (v_id);
  end loop;

  for v_id in
    select
      revision.id
    from
      app.pos_refund_revisions revision
    order by
      revision.shift_id,
      revision.tx_id,
      revision.id
  loop
    perform app.note_refund_sales_revision (v_id);
  end loop;
end;
$backfill_sales_facts$;

-- ============================================================================
-- 3. Sync-scope predicate and count-roster coverage.
-- A shift is scope-covered when some successful pos_sync_coverage row, other
-- than a legacy_direct row, applied a known order scope that includes the
-- shift and presented that shift. Existence is the proof: a later narrower
-- run does not erase an earlier one. record_count's acceptance rules are
-- not changed. The count check uses the same relevant shifts record_count
-- uses (every shift opened at or before the count, plus the shift of every
-- order at or before the count) and exposes a miss as a cause.
-- ============================================================================
create function app.sync_coverage_covers_shift (
  p_applied boolean,
  p_kind text,
  p_from timestamptz,
  p_scope_shifts text[],
  p_presented text[],
  p_legacy boolean,
  p_shift_id text,
  p_opened_at timestamptz
) returns boolean language sql immutable
set
  search_path = '' as $$
  select
    p_legacy is not true
    and p_applied is true
    and p_shift_id = any (coalesce(p_presented, '{}'::text[]))
    and (
      p_kind = 'all'
      or (
        p_kind = 'shift_ids'
        and p_shift_id = any (coalesce(p_scope_shifts, '{}'::text[]))
      )
      or (
        p_kind = 'from'
        and p_from is not null
        and p_from <= p_opened_at
      )
    );
$$;

comment on function app.sync_coverage_covers_shift (
  boolean,
  text,
  timestamptz,
  text[],
  text[],
  boolean,
  text,
  timestamptz
) is 'True when one pos_sync_coverage row covers one shift. legacy_direct and an unknown scope kind do not cover. all covers a presented shift. shift_ids must list it. from must start at or before the shift opened. No table read.';

revoke all on function app.sync_coverage_covers_shift (
  boolean,
  text,
  timestamptz,
  text[],
  text[],
  boolean,
  text,
  timestamptz
)
from
  public,
  anon;

grant
execute on function app.sync_coverage_covers_shift (
  boolean,
  text,
  timestamptz,
  text[],
  text[],
  boolean,
  text,
  timestamptz
) to authenticated,
service_role;

create function app.count_sync_scope_covered (p_counted_at timestamptz) returns boolean language sql stable
set
  search_path = '' as $$
  select
    not exists (
      select
        1
      from
        (
          select
            shift.id,
            shift.opened_at
          from
            app.pos_shifts shift
          where
            shift.opened_at <= p_counted_at
          union
          select
            o.shift_id,
            shift.opened_at
          from
            app.pos_orders o
            join app.pos_shifts shift on shift.id = o.shift_id
          where
            o.ordered_at <= p_counted_at
        ) as required (id, opened_at)
      where
        not exists (
          select
            1
          from
            app.pos_sync_coverage cov
          where
            app.sync_coverage_covers_shift (
              cov.orders_scope_applied,
              cov.scope_kind,
              cov.scope_from,
              cov.scope_shift_ids,
              cov.presented_shift_ids,
              cov.legacy_direct,
              required.id,
              required.opened_at
            )
        )
    );
$$;

comment on function app.count_sync_scope_covered (timestamptz) is 'True when every shift opened at or before p_counted_at, and every shift of an order at or before p_counted_at, is covered by some non-legacy pos_sync_coverage row. No such shift is covered. Does not change whether record_count accepts a count.';

revoke all on function app.count_sync_scope_covered (timestamptz)
from
  public,
  anon;

grant
execute on function app.count_sync_scope_covered (timestamptz) to authenticated,
service_role;

create view app.shift_count_coverage
with
  (security_invoker = true) as
with
  anchors as materialized (
    select
      anchor.count_id,
      anchor.line_no,
      anchor.item_id,
      anchor.counted_at,
      anchor.shift_id as owning_shift_id,
      counted.frequency,
      lag(anchor.counted_at) over (
        partition by
          anchor.item_id,
          counted.frequency
        order by
          anchor.counted_at,
          anchor.count_id,
          anchor.line_no
      ) as interval_start
    from
      app.stock_count_anchors anchor
      join app.stock_counts counted on counted.id = anchor.count_id
  ),
  scope as materialized (
    select
      times.counted_at,
      app.count_sync_scope_covered (times.counted_at) as sync_scope_covered,
      (
        select
          shift.id
        from
          app.pos_shifts shift
        where
          shift.opened_at <= times.counted_at
        order by
          shift.opened_at desc,
          shift.id desc
        limit
          1
      ) as interval_owning_shift_id
    from
      (
        select distinct
          anchor.counted_at
        from
          anchors anchor
      ) times
  ),
  placed as (
    select
      anchor.count_id,
      anchor.line_no,
      anchor.item_id,
      anchor.counted_at,
      anchor.frequency,
      anchor.owning_shift_id,
      anchor.interval_start,
      scope.interval_owning_shift_id,
      scope.sync_scope_covered
    from
      anchors anchor
      join scope on scope.counted_at = anchor.counted_at
  ),
  roster as (
    select
      shift.id as shift_id,
      shift.opened_at,
      hist.item_id,
      hist.count_frequency,
      hist.known_since
    from
      app.pos_shifts shift
      join lateral (
        select distinct
          on (row.item_id) row.item_id,
          row.count_frequency,
          row.known_since,
          row.active
        from
          app.item_tracking_history row
        where
          row.known_since <= shift.opened_at
        order by
          row.item_id,
          row.known_since desc,
          row.id desc
      ) hist on hist.active
  )
select
  roster.shift_id,
  roster.item_id,
  roster.count_frequency,
  roster.known_since,
  cover.count_id as anchor_count_id,
  cover.line_no as anchor_line_no,
  cover.counted_at as anchor_counted_at,
  cover.interval_start,
  cover.counted_at as interval_end,
  cover.owning_shift_id,
  cover.interval_owning_shift_id,
  cover.sync_scope_covered,
  (cover.count_id is not null) as covered
from
  roster
  left join lateral (
    select
      placed.count_id,
      placed.line_no,
      placed.counted_at,
      placed.interval_start,
      placed.owning_shift_id,
      placed.interval_owning_shift_id,
      placed.sync_scope_covered
    from
      placed
    where
      placed.item_id = roster.item_id
      and placed.frequency = roster.count_frequency
      and (
        (
          roster.count_frequency = 'daily'
          and placed.owning_shift_id = roster.shift_id
        )
        or (
          roster.count_frequency = 'weekly'
          and roster.opened_at > coalesce(placed.interval_start, '-infinity'::timestamptz)
          and roster.opened_at <= placed.counted_at
        )
      )
    order by
      placed.counted_at desc,
      placed.count_id desc,
      placed.line_no desc
    limit
      1
  ) cover on true;

comment on view app.shift_count_coverage is 'One row per shift and item required at that shift''s open. owning_shift_id is the shift pinned on the anchor when the count was recorded. interval_owning_shift_id is the separate policy of the last shift that had opened at or before the count, and a later boundary edit can move it. A daily item is covered only by a daily anchor whose pinned shift is this shift. A weekly item is covered by a weekly anchor whose interval (previous same-item anchor, this count] contains the shift open. Previous anchors and the count scope proof are computed once per count, not once per item line. sync_scope_covered is null when the item has no anchor. A partial count leaves the missing items uncovered. security_invoker so owner RLS applies.';

-- Batch lookups for the revision view. The view also builds one receipt map
-- per query; these indexes keep a nested lookup off a sequential scan.
create index order_cost_applications_retire_batch_idx on app.order_cost_applications (retire_batch)
where
  retire_batch is not null;

create index order_cost_applications_posting_batch_idx on app.order_cost_applications (posting_batch)
where
  posting_batch is not null;

create index waste_documents_batch_idx on app.waste_documents (batch_id)
where
  batch_id is not null;

create index waste_documents_retire_batch_idx on app.waste_documents (retire_batch_id)
where
  retire_batch_id is not null;

-- ============================================================================
-- 4. Unified revision differences.
-- Grouped by cause and shift. Cost columns are the negated ledger total_cost
-- of the revision movements (a cost increase is positive). They do not add
-- period_revisions.amount: that column already describes those movements.
-- A cost_adjustment inherits its target movement's bucket, the same cases
-- as app.profit_bucket in 20261108010000_outflow_reversals.sql. Sorting
-- transfers are left out. A coordinator correction's retirement batch and
-- replacement batch are one cause, normalized through the application
-- receipt. A manual waste correction's retirement batch and replacement
-- batch are one waste_document cause. The receipt map is built once per
-- query. Each row is one cause. Cumulative columns and is_latest follow
-- captured_at, then the numeric source id, then cause kind and id.
-- is_latest is not the row that was materialized last. source_at stays the
-- economic time. profit = net sales − cogs − waste − count.
-- ============================================================================
create view app.accounting_revision_differences
with
  (security_invoker = true) as
with
  receipts as materialized (
    select distinct
      on (mapped.batch_id) mapped.batch_id,
      mapped.cause_kind,
      mapped.cause_id,
      mapped.cause_sort,
      mapped.captured_at,
      mapped.economic_at
    from
      (
        select
          application.retire_batch as batch_id,
          'application'::text as cause_kind,
          application.id::text as cause_id,
          application.id as cause_sort,
          application.created_at as captured_at,
          application.occurred_at as economic_at,
          0 as preference
        from
          app.order_cost_applications application
        where
          application.retire_batch is not null
        union all
        select
          application.posting_batch,
          'application'::text,
          application.id::text,
          application.id,
          application.created_at,
          application.occurred_at,
          0
        from
          app.order_cost_applications application
        where
          application.posting_batch is not null
        union all
        select
          document.retire_batch_id,
          'waste_document'::text,
          document.id::text,
          document.id,
          document.created_at,
          document.occurred_at,
          1
        from
          app.waste_documents document
        where
          document.retire_batch_id is not null
        union all
        select
          document.batch_id,
          'waste_document'::text,
          document.id::text,
          document.id,
          document.created_at,
          document.occurred_at,
          1
        from
          app.waste_documents document
        where
          document.batch_id is not null
      ) mapped
    order by
      mapped.batch_id,
      mapped.preference,
      mapped.cause_sort
  ),
  ledger as (
    select
      coalesce(receipt.cause_kind, 'ledger') as cause_kind,
      coalesce(receipt.cause_id, revision.cause_batch_id::text) as cause_id,
      receipt.cause_sort,
      revision.shift_id,
      min(
        coalesce(receipt.captured_at, revision.created_at)
      ) as captured_at,
      min(
        coalesce(receipt.economic_at, movement.occurred_at)
      ) as source_at,
      min(revision.created_at) as recorded_at,
      0::numeric(14, 2) as net_sales_difference,
      coalesce(
        - sum(movement.total_cost) filter (
          where
            bucket.bucket = 'cogs'
        ),
        0
      )::numeric(14, 2) as cogs_difference,
      coalesce(
        - sum(movement.total_cost) filter (
          where
            bucket.bucket = 'waste'
        ),
        0
      )::numeric(14, 2) as waste_difference,
      coalesce(
        - sum(movement.total_cost) filter (
          where
            bucket.bucket = 'count'
        ),
        0
      )::numeric(14, 2) as count_difference
    from
      app.period_revisions revision
      join app.stock_movements movement on movement.id = revision.source_movement_id
      left join app.stock_movements target on target.id = movement.adjusts_movement_id
      cross join lateral (
        select
          case
            when movement.movement_type = 'cost_adjustment'::app.movement_type then case target.movement_type
              when 'sale'::app.movement_type then 'cogs'
              when 'sale_reversal'::app.movement_type then 'cogs'
              when 'waste'::app.movement_type then 'waste'
              when 'waste_reversal'::app.movement_type then 'waste'
              when 'sort_loss'::app.movement_type then 'waste'
              when 'count_adjustment'::app.movement_type then 'count'
              when 'count_compensation'::app.movement_type then 'count'
              else null
            end
            when movement.movement_type = 'sale'::app.movement_type then 'cogs'
            when movement.movement_type = 'sale_reversal'::app.movement_type then 'cogs'
            when movement.movement_type = 'waste'::app.movement_type then 'waste'
            when movement.movement_type = 'waste_reversal'::app.movement_type then 'waste'
            when movement.movement_type = 'sort_loss'::app.movement_type then 'waste'
            when movement.movement_type = 'count_adjustment'::app.movement_type then 'count'
            when movement.movement_type = 'count_compensation'::app.movement_type then 'count'
            else null
          end as bucket
      ) bucket
      left join receipts receipt on receipt.batch_id = revision.cause_batch_id
    where
      revision.shift_id is not null
    group by
      1,
      2,
      3,
      revision.shift_id
    having
      count(*) filter (
        where
          bucket.bucket in ('cogs', 'waste', 'count')
      ) > 0
  ),
  events as (
    select
      ledger.cause_kind,
      ledger.cause_id,
      ledger.cause_sort,
      ledger.shift_id,
      ledger.captured_at,
      ledger.source_at,
      ledger.recorded_at,
      ledger.net_sales_difference,
      ledger.cogs_difference,
      ledger.waste_difference,
      ledger.count_difference
    from
      ledger
    union all
    select
      fact.source_kind,
      fact.source_revision_id::text,
      fact.source_revision_id,
      fact.shift_id,
      fact.captured_at,
      fact.source_at,
      fact.recorded_at,
      fact.net_sales_difference,
      0::numeric(14, 2),
      0::numeric(14, 2),
      0::numeric(14, 2)
    from
      app.sales_revision_facts fact
  ),
  rolled as (
    select
      events.cause_kind,
      events.cause_id,
      events.cause_sort,
      events.shift_id,
      events.captured_at,
      events.source_at,
      events.recorded_at,
      events.net_sales_difference,
      events.cogs_difference,
      events.waste_difference,
      events.count_difference,
      (
        events.net_sales_difference - events.cogs_difference - events.waste_difference - events.count_difference
      )::numeric(14, 2) as profit_difference,
      sum(events.net_sales_difference) over shift_order as cumulative_net_sales_difference,
      sum(events.cogs_difference) over shift_order as cumulative_cogs_difference,
      sum(events.waste_difference) over shift_order as cumulative_waste_difference,
      sum(events.count_difference) over shift_order as cumulative_count_difference,
      (
        row_number() over (
          partition by
            events.shift_id
          order by
            events.captured_at desc,
            events.cause_sort desc nulls first,
            events.cause_kind desc,
            events.cause_id desc
        ) = 1
      ) as is_latest
    from
      events
    window
      shift_order as (
        partition by
          events.shift_id
        order by
          events.captured_at,
          events.cause_sort nulls last,
          events.cause_kind,
          events.cause_id rows between unbounded preceding
          and current row
      )
  )
select
  rolled.cause_kind,
  rolled.cause_id,
  rolled.cause_sort,
  rolled.shift_id,
  rolled.captured_at,
  rolled.source_at,
  rolled.recorded_at,
  rolled.is_latest,
  rolled.net_sales_difference::numeric(14, 2)::text as net_sales_difference,
  rolled.cogs_difference::numeric(14, 2)::text as cogs_difference,
  rolled.waste_difference::numeric(14, 2)::text as waste_difference,
  rolled.count_difference::numeric(14, 2)::text as count_difference,
  rolled.profit_difference::text as profit_difference,
  rolled.cumulative_net_sales_difference::numeric(14, 2)::text as cumulative_net_sales_difference,
  rolled.cumulative_cogs_difference::numeric(14, 2)::text as cumulative_cogs_difference,
  rolled.cumulative_waste_difference::numeric(14, 2)::text as cumulative_waste_difference,
  rolled.cumulative_count_difference::numeric(14, 2)::text as cumulative_count_difference,
  (
    rolled.cumulative_net_sales_difference - rolled.cumulative_cogs_difference - rolled.cumulative_waste_difference - rolled.cumulative_count_difference
  )::numeric(14, 2)::text as cumulative_profit_difference
from
  rolled;

comment on view app.accounting_revision_differences is 'One cause on one shift: its own net sales, COGS, waste, count and profit differences, and the cumulative differences of that shift through this cause. Money is decimal text. captured_at orders the rows, then cause_sort for a numeric source id, then cause kind and id. cause_sort is null for a ledger batch uuid. source_at is the economic time and is not the order. recorded_at is materialization time and does not order the rows. A retirement batch and its replacement batch that share one application receipt are one application cause, so a reclass from COGS to waste is one zero-profit vector. A manual waste correction is one waste_document cause for the same reason. The receipt map is built once per query from indexed batch columns. A zero profit difference is still a row. Sorting transfers are absent. Cost adjustments use the economic target''s bucket. Ledger amounts come from stock_movements.total_cost, not from period_revisions.amount. security_invoker so owner RLS applies.';

-- Shifts that still own an order's unsettled work: the latest cost-input
-- snapshot, the live application's pinned shift, and, when the latest
-- receipt is incomplete, the shift of the application it retired.
create function app.order_settlement_shifts (p_order_id text) returns table (shift_id text) language sql stable
set
  search_path = '' as $$
  (
    select
      snap.shift_id
    from
      app.pos_cost_inputs input
      join app.pos_order_snapshots snap on snap.id = input.snapshot_id
    where
      input.order_id = p_order_id
    order by
      input.input_revision desc
    limit
      1
  )
  union
  (
    select
      owner_app.shift_id
    from
      app.order_cost_state state
      join app.order_cost_applications owner_app on owner_app.id = state.owner_application_id
    where
      state.order_id = p_order_id
      and owner_app.shift_id is not null
  )
  union
  (
    select
      retired.shift_id
    from
      app.order_cost_state state
      join app.order_cost_applications latest on latest.id = state.latest_application_id
      join app.order_cost_applications retired on retired.id = latest.retired_application_id
    where
      state.order_id = p_order_id
      and latest.disposition = 'incomplete'
      and retired.shift_id is not null
  );
$$;

comment on function app.order_settlement_shifts (text) is 'Shifts that still carry one order''s unsettled accounting: the latest cost-input snapshot shift, the live owner application shift, and the retired application shift when the latest receipt is incomplete. Does not follow a mutable pos_orders.shift_id on its own. Private.';

revoke all on function app.order_settlement_shifts (text)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 5. Shift status. Independent causes, a derived label, and the revised badge.
-- Owner only. Keyset by (opened_at, id). Quantities and money are decimal text.
-- Completed-order coverage counts only complete, present orders at or after
-- the first opening. With no opening the denominator is zero: those orders
-- stay sales-only and are not an incomplete-mapping blocker.
-- ============================================================================
create function app.list_shift_accounting_status (
  p_after_opened_at timestamptz default null,
  p_after_id text default null,
  p_limit integer default null
) returns setof jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_limit integer;
  v_opening timestamptz;
  v_shift record;
  v_daily_required integer;
  v_daily_covered integer;
  v_weekly_required integer;
  v_weekly_covered integer;
  v_anchor_sync boolean;
  v_finished timestamptz;
  v_scope_covered boolean;
  v_fresh boolean;
  v_budget interval;
  v_open_orders integer;
  v_pending integer;
  v_blocked integer;
  v_stale integer;
  v_unreviewed integer;
  v_preparation integer;
  v_refunds integer;
  v_deficit_count integer;
  v_deficit_qty numeric;
  v_missing_cost integer;
  v_orders_denom integer;
  v_orders_covered integer;
  v_lines_denom integer;
  v_lines_covered integer;
  v_coverage jsonb;
  v_pack jsonb;
  v_tracking integer;
  v_incomplete integer;
  v_incomplete_codes text[];
  v_extra text[];
  v_order record;
  v_resolved jsonb;
  v_line_count integer;
  v_expenses boolean;
  v_month date;
  v_causes text[];
  v_label text;
  v_revised boolean;
  v_latest jsonb;
  v_cumulative jsonb;
  v_history jsonb;
  v_daily jsonb;
  v_weekly jsonb;
  v_zero jsonb := pg_catalog.jsonb_build_object(
    'net_sales_difference',
    '0.00',
    'cogs_difference',
    '0.00',
    'waste_difference',
    '0.00',
    'count_difference',
    '0.00',
    'profit_difference',
    '0.00'
  );
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if (p_after_opened_at is null) is distinct from (p_after_id is null) then
    raise exception 'shift page cursor is incomplete'
      using errcode = '22023';
  end if;

  if p_after_opened_at is not null
  and not pg_catalog.isfinite (p_after_opened_at) then
    raise exception 'shift page cursor is incomplete'
      using errcode = '22023';
  end if;

  v_limit := coalesce(p_limit, 50);

  if v_limit < 1
  or v_limit > 100 then
    raise exception 'shift page limit is out of range'
      using errcode = '22023';
  end if;

  select
    min(opening.occurred_at)
  into v_opening
  from
    app.opening_stocks opening;

  -- One read of the coverage view for this page. The view already computes
  -- previous anchors once and the scope proof once per count.
  select
    coalesce(
      pg_catalog.jsonb_object_agg(page.shift_id, page.payload),
      '{}'::jsonb
    )
  into v_coverage
  from
    (
      select
        coverage.shift_id,
        pg_catalog.jsonb_build_object(
          'daily_required',
          count(*) filter (
            where
              coverage.count_frequency = 'daily'
          ),
          'daily_covered',
          count(*) filter (
            where
              coverage.count_frequency = 'daily'
              and coverage.covered
          ),
          'weekly_required',
          count(*) filter (
            where
              coverage.count_frequency = 'weekly'
          ),
          'weekly_covered',
          count(*) filter (
            where
              coverage.count_frequency = 'weekly'
              and coverage.covered
          ),
          'anchor_sync',
          coalesce(
            bool_and(coverage.sync_scope_covered) filter (
              where
                coverage.covered
            ),
            true
          ),
          'daily',
          coalesce(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'item_id',
                coverage.item_id,
                'covered',
                coverage.covered,
                'anchor_count_id',
                coverage.anchor_count_id,
                'known_since',
                app.costing_timestamptz_text (coverage.known_since)
              )
              order by
                coverage.item_id
            ) filter (
              where
                coverage.count_frequency = 'daily'
            ),
            '[]'::jsonb
          ),
          'weekly',
          coalesce(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'item_id',
                coverage.item_id,
                'covered',
                coverage.covered,
                'anchor_count_id',
                coverage.anchor_count_id,
                'counted_at',
                app.costing_timestamptz_text (coverage.anchor_counted_at),
                'interval_start',
                app.costing_timestamptz_text (coverage.interval_start),
                'interval_end',
                app.costing_timestamptz_text (coverage.interval_end),
                'owning_shift_id',
                coverage.owning_shift_id,
                'interval_owning_shift_id',
                coverage.interval_owning_shift_id,
                'sync_scope_covered',
                coverage.sync_scope_covered,
                'known_since',
                app.costing_timestamptz_text (coverage.known_since)
              )
              order by
                coverage.item_id
            ) filter (
              where
                coverage.count_frequency = 'weekly'
            ),
            '[]'::jsonb
          )
        ) as payload
      from
        app.shift_count_coverage coverage
      where
        coverage.shift_id in (
          select
            shift.id
          from
            app.pos_shifts shift
          where
            p_after_opened_at is null
            or (shift.opened_at, shift.id) > (p_after_opened_at, p_after_id)
          order by
            shift.opened_at,
            shift.id
          limit
            v_limit
        )
      group by
        coverage.shift_id
    ) page;

  for v_shift in
    select
      shift.id,
      shift.opened_at,
      shift.closed_at,
      shift.is_active
    from
      app.pos_shifts shift
    where
      p_after_opened_at is null
      or (shift.opened_at, shift.id) > (p_after_opened_at, p_after_id)
    order by
      shift.opened_at,
      shift.id
    limit
      v_limit
  loop
    v_pack := v_coverage -> v_shift.id;
    v_daily_required := coalesce((v_pack ->> 'daily_required')::integer, 0);
    v_daily_covered := coalesce((v_pack ->> 'daily_covered')::integer, 0);
    v_weekly_required := coalesce((v_pack ->> 'weekly_required')::integer, 0);
    v_weekly_covered := coalesce((v_pack ->> 'weekly_covered')::integer, 0);
    v_anchor_sync := coalesce((v_pack ->> 'anchor_sync')::boolean, true);
    v_daily := coalesce(v_pack -> 'daily', '[]'::jsonb);
    v_weekly := coalesce(v_pack -> 'weekly', '[]'::jsonb);

    select
      exists (
        select
          1
        from
          app.pos_sync_coverage cov
        where
          app.sync_coverage_covers_shift (
            cov.orders_scope_applied,
            cov.scope_kind,
            cov.scope_from,
            cov.scope_shift_ids,
            cov.presented_shift_ids,
            cov.legacy_direct,
            v_shift.id,
            v_shift.opened_at
          )
      ),
      max(cov.finished_at) filter (
        where
          app.sync_coverage_covers_shift (
            cov.orders_scope_applied,
            cov.scope_kind,
            cov.scope_from,
            cov.scope_shift_ids,
            cov.presented_shift_ids,
            cov.legacy_direct,
            v_shift.id,
            v_shift.opened_at
          )
      )
    into
      v_scope_covered,
      v_finished
    from
      app.pos_sync_coverage cov;

    v_budget := case
      when v_shift.opened_at >= pg_catalog.now() - interval '35 days' then interval '1 day'
      else interval '7 days'
    end;

    v_fresh := v_finished is not null
    and v_finished >= pg_catalog.now() - v_budget;

    select
      count(*)
    into v_open_orders
    from
      app.pos_orders o
    where
      o.shift_id = v_shift.id
      and o.status = 'active'
      and not o.missing_from_pos;

    select
      count(distinct hit.order_id)
    into v_pending
    from
      (
        select
          event.order_id
        from
          app.accounting_work_events event
        where
          event.processed_at is null
          and exists (
            select
              1
            from
              app.order_settlement_shifts (event.order_id) settled
            where
              settled.shift_id = v_shift.id
          )
        union
        select
          snap.order_id
        from
          app.accounting_rederive_spans span
          join app.pos_order_snapshots snap on snap.ordered_at >= span.effective_from
          and (
            span.effective_to is null
            or snap.ordered_at < span.effective_to
          )
          and (
            span.cursor_ordered_at is null
            or (snap.ordered_at, snap.order_id) > (span.cursor_ordered_at, span.cursor_order_id)
          )
          and snap.id = (
            select
              input.snapshot_id
            from
              app.pos_cost_inputs input
            where
              input.order_id = snap.order_id
            order by
              input.input_revision desc
            limit
              1
          )
        where
          span.completed_at is null
          and exists (
            select
              1
            from
              app.order_settlement_shifts (snap.order_id) settled
            where
              settled.shift_id = v_shift.id
          )
      ) hit;

    select
      count(*)
    into v_blocked
    from
      app.accounting_work_state state
    where
      (
        state.last_outcome = 'blocked'
        or state.failed_at is not null
      )
      and exists (
        select
          1
        from
          app.order_settlement_shifts (state.order_id) settled
        where
          settled.shift_id = v_shift.id
      );

    select
      count(*)
    into v_stale
    from
      app.order_cost_state state
      join app.order_cost_applications application on application.id = state.latest_application_id
    where
      state.latest_input_id is not null
      and application.cost_input_id is distinct from state.latest_input_id
      and exists (
        select
          1
        from
          app.order_settlement_shifts (state.order_id) settled
        where
          settled.shift_id = v_shift.id
      );

    select
      count(distinct state.order_id),
      coalesce(
        pg_catalog.array_agg(distinct cause.value ->> 'code') filter (
          where
            cause.value ->> 'code' is not null
        ),
        '{}'::text[]
      )
    into
      v_incomplete,
      v_incomplete_codes
    from
      app.order_cost_state state
      join app.order_cost_applications application on application.id = state.latest_application_id
      left join lateral pg_catalog.jsonb_array_elements(application.causes) as cause (value) on true
    where
      application.disposition = 'incomplete'
      and exists (
        select
          1
        from
          app.order_settlement_shifts (state.order_id) settled
        where
          settled.shift_id = v_shift.id
      );

    select
      count(*)
    into v_tracking
    from
      app.stock_items item
    where
      item.created_at <= v_shift.opened_at
      and exists (
        select
          1
        from
          app.item_tracking_history backfill
        where
          backfill.item_id = item.id
          and backfill.basis = 'backfill'
          and backfill.known_since > v_shift.opened_at
      )
      and not exists (
        select
          1
        from
          app.item_tracking_history earlier
        where
          earlier.item_id = item.id
          and earlier.known_since <= v_shift.opened_at
      );

    select
      count(*)
    into v_unreviewed
    from
      app.order_disposition_state state
      join app.pos_orders o on o.id = state.order_id
      left join app.order_disposition_events event on event.id = state.event_id
    where
      o.shift_id = v_shift.id
      and state.is_open
      and (
        state.review_reason is not null
        or event.owner_reviewed is not true
      );

    select
      count(*)
    into v_preparation
    from
      app.order_cost_state state
      join app.pos_orders o on o.id = state.order_id
    where
      o.shift_id = v_shift.id
      and exists (
        select
          1
        from
          pg_catalog.jsonb_array_elements(state.causes) as cause (value)
        where
          cause.value ->> 'code' = 'missing_preparation_basis'
      );

    select
      count(*)
    into v_refunds
    from
      (
        select
          1
        from
          (
            select distinct
              on (revision.tx_id) revision.present,
              revision.tx_type,
              revision.order_id,
              revision.amount
            from
              app.pos_refund_revisions revision
            where
              revision.shift_id = v_shift.id
            order by
              revision.tx_id,
              revision.id desc
          ) as latest
        where
          latest.present
          and latest.tx_type = 3
          and (
            latest.order_id is null
            or latest.amount < 0
          )
        union all
        select
          1
        from
          app.order_disposition_state state
          join app.pos_orders o on o.id = state.order_id
        where
          o.shift_id = v_shift.id
          and (
            state.class = 'unresolved_refund'
            or state.review_reason = 'unresolved_refund'
          )
      ) as hit;

    select
      count(*),
      coalesce(sum(deficit.qty_uncovered), 0)
    into
      v_deficit_count,
      v_deficit_qty
    from
      app.provisional_deficits deficit
      join app.stock_movements movement on movement.id = deficit.movement_id
      left join app.movement_attributions attribution on attribution.movement_id = movement.id
    where
      deficit.qty_uncovered > 0
      and coalesce(movement.shift_id, attribution.shift_id) = v_shift.id;

    select
      count(*)
    into v_missing_cost
    from
      app.pos_orders o
    where
      o.shift_id = v_shift.id
      and (
        exists (
          select
            1
          from
            app.order_cost_state state
            cross join lateral pg_catalog.jsonb_array_elements(state.causes) as cause (value)
          where
            state.order_id = o.id
            and cause.value ->> 'code' = 'missing_cost_basis'
        )
        or exists (
          select
            1
          from
            app.accounting_work_state state
          where
            state.order_id = o.id
            and state.last_reason = 'missing_cost_basis'
        )
      );

    v_orders_denom := 0;
    v_orders_covered := 0;
    v_lines_denom := 0;
    v_lines_covered := 0;

    for v_order in
      select
        o.id
      from
        app.pos_orders o
      where
        o.shift_id = v_shift.id
        and o.status = 'complete'
        and not o.missing_from_pos
        and v_opening is not null
        and o.ordered_at >= v_opening
      order by
        o.id
    loop
      select
        count(*)
      into v_line_count
      from
        app.pos_order_lines line
      where
        line.order_id = v_order.id
        and (
          line.quantity > 0
          or line.weighted_qty > 0
        );

      v_orders_denom := v_orders_denom + 1;
      v_lines_denom := v_lines_denom + v_line_count;

      begin
        v_resolved := app.resolve_order_requirements (v_order.id, null);
      exception
        when others then
          v_resolved := pg_catalog.jsonb_build_object('status', 'incomplete');
      end;

      if v_resolved ->> 'status' = 'ready' then
        v_orders_covered := v_orders_covered + 1;
      end if;

      -- Line coverage follows each line's own ready or exception status.
      -- An unresolved order (packaging, another line) does not zero the lines
      -- that are already eligible.
      select
        count(*)
      into v_line_count
      from
        app.pos_order_lines line
      where
        line.order_id = v_order.id
        and (
          line.quantity > 0
          or line.weighted_qty > 0
        )
        and exists (
          select
            1
          from
            pg_catalog.jsonb_array_elements(coalesce(v_resolved -> 'lines', '[]'::jsonb)) as resolved (value)
          where
            resolved.value ->> 'line_id' = line.line_id
            and resolved.value ->> 'status' in ('ready', 'exception')
        );

      v_lines_covered := v_lines_covered + v_line_count;
    end loop;

    v_month := pg_catalog.date_trunc(
      'month',
      (v_shift.opened_at at time zone 'Africa/Cairo')
    )::date;

    select
      coalesce(
        (
          select
            status.complete
          from
            app.month_expense_status status
          where
            status.month = v_month
        ),
        false
      )
    into v_expenses;

    v_causes := '{}'::text[];

    if v_shift.closed_at is null
    or v_shift.is_active then
      v_causes := v_causes || array['shift_open']::text[];
    end if;

    if v_open_orders > 0 then
      v_causes := v_causes || array['open_orders']::text[];
    end if;

    if not v_scope_covered then
      v_causes := v_causes || array['sync_scope_not_covered']::text[];
    end if;

    if v_scope_covered
    and not v_fresh then
      v_causes := v_causes || array['sync_stale']::text[];
    end if;

    if v_pending > 0 then
      v_causes := v_causes || array['pending_applications']::text[];
    end if;

    if v_blocked > 0 then
      v_causes := v_causes || array['blocked_applications']::text[];
    end if;

    if v_stale > 0 then
      v_causes := v_causes || array['stale_applications']::text[];
    end if;

    if v_tracking > 0 then
      v_causes := v_causes || array['tracking_unknown']::text[];
    end if;

    if v_incomplete > 0 then
      v_causes := v_causes || array['incomplete_application']::text[];

      select
        coalesce(pg_catalog.array_agg(extra.code), '{}'::text[])
      into v_extra
      from
        (
          select distinct
            code
          from
            pg_catalog.unnest(coalesce(v_incomplete_codes, '{}'::text[])) as code
          where
            code is not null
            and code <> all (v_causes)
        ) extra;

      v_causes := v_causes || coalesce(v_extra, '{}'::text[]);
    end if;

    if v_unreviewed > 0 then
      v_causes := v_causes || array['unreviewed_decisions']::text[];
    end if;

    if v_preparation > 0 then
      v_causes := v_causes || array['unresolved_preparation']::text[];
    end if;

    if v_refunds > 0 then
      v_causes := v_causes || array['unresolved_refund_attribution']::text[];
    end if;

    if v_deficit_count > 0 then
      v_causes := v_causes || array['provisional_deficits']::text[];
    end if;

    if v_missing_cost > 0 then
      v_causes := v_causes || array['missing_cost_basis']::text[];
    end if;

    if v_orders_denom > v_orders_covered
    or v_lines_denom > v_lines_covered then
      v_causes := v_causes || array['order_coverage_incomplete']::text[];
    end if;

    if not v_anchor_sync then
      v_causes := v_causes || array['count_sync_scope_not_covered']::text[];
    end if;

    if pg_catalog.cardinality(v_causes) > 0 then
      v_label := 'ناقص';
    elsif v_daily_required > v_daily_covered then
      v_label := 'تقديري';
    elsif v_weekly_required > v_weekly_covered
    or not v_expenses then
      v_label := 'السمك مقفول';
    else
      v_label := 'مقفول نهائي';
    end if;

    select
      exists (
        select
          1
        from
          app.accounting_revision_differences diff
        where
          diff.shift_id = v_shift.id
      )
    into v_revised;

    select
      pg_catalog.jsonb_build_object(
        'net_sales_difference',
        diff.net_sales_difference,
        'cogs_difference',
        diff.cogs_difference,
        'waste_difference',
        diff.waste_difference,
        'count_difference',
        diff.count_difference,
        'profit_difference',
        diff.profit_difference
      ),
      pg_catalog.jsonb_build_object(
        'net_sales_difference',
        diff.cumulative_net_sales_difference,
        'cogs_difference',
        diff.cumulative_cogs_difference,
        'waste_difference',
        diff.cumulative_waste_difference,
        'count_difference',
        diff.cumulative_count_difference,
        'profit_difference',
        diff.cumulative_profit_difference
      )
    into
      v_latest,
      v_cumulative
    from
      app.accounting_revision_differences diff
    where
      diff.shift_id = v_shift.id
      and diff.is_latest;

    v_latest := coalesce(v_latest, v_zero);
    v_cumulative := coalesce(v_cumulative, v_zero);

    select
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'cause_kind',
            diff.cause_kind,
            'cause_id',
            diff.cause_id,
            'cause_sort',
            diff.cause_sort::text,
            'captured_at',
            app.costing_timestamptz_text (diff.captured_at),
            'source_at',
            app.costing_timestamptz_text (diff.source_at),
            'recorded_at',
            app.costing_timestamptz_text (diff.recorded_at),
            'is_latest',
            diff.is_latest,
            'net_sales_difference',
            diff.net_sales_difference,
            'cogs_difference',
            diff.cogs_difference,
            'waste_difference',
            diff.waste_difference,
            'count_difference',
            diff.count_difference,
            'profit_difference',
            diff.profit_difference,
            'cumulative_net_sales_difference',
            diff.cumulative_net_sales_difference,
            'cumulative_cogs_difference',
            diff.cumulative_cogs_difference,
            'cumulative_waste_difference',
            diff.cumulative_waste_difference,
            'cumulative_count_difference',
            diff.cumulative_count_difference,
            'cumulative_profit_difference',
            diff.cumulative_profit_difference
          )
          order by
            diff.captured_at,
            diff.cause_sort nulls last,
            diff.cause_kind,
            diff.cause_id
        ),
        '[]'::jsonb
      )
    into v_history
    from
      app.accounting_revision_differences diff
    where
      diff.shift_id = v_shift.id;

    return next pg_catalog.jsonb_build_object(
      'shift_id',
      v_shift.id,
      'opened_at',
      app.costing_timestamptz_text (v_shift.opened_at),
      'closed_at',
      app.costing_timestamptz_text (v_shift.closed_at),
      'status_label',
      v_label,
      'revised',
      v_revised,
      'causes',
      to_jsonb(v_causes),
      'shift_open',
      v_shift.closed_at is null
      or v_shift.is_active,
      'open_order_count',
      v_open_orders,
      'completed_orders_covered',
      v_orders_covered::text,
      'completed_orders_denominator',
      v_orders_denom::text,
      'completed_lines_covered',
      v_lines_covered::text,
      'completed_lines_denominator',
      v_lines_denom::text,
      'pending_applications',
      v_pending,
      'incomplete_applications',
      v_incomplete,
      'tracking_unknown_items',
      v_tracking,
      'stale_applications',
      v_stale,
      'blocked_applications',
      v_blocked,
      'unreviewed_decisions',
      v_unreviewed,
      'unresolved_preparation',
      v_preparation,
      'unresolved_refund_attribution',
      v_refunds,
      'provisional_deficit_count',
      v_deficit_count,
      'provisional_deficit_qty',
      pg_catalog.trim_scale (v_deficit_qty)::text,
      'sync_scope_covered',
      v_scope_covered,
      'sync_fresh',
      v_fresh,
      'sync_due',
      (not v_scope_covered)
      or (not v_fresh),
      'count_sync_scope_covered',
      v_anchor_sync,
      'daily_required',
      v_daily_required,
      'daily_covered',
      v_daily_covered,
      'weekly_required',
      v_weekly_required,
      'weekly_covered',
      v_weekly_covered,
      'daily_due',
      v_daily_required > v_daily_covered,
      'weekly_due',
      v_weekly_required > v_weekly_covered,
      'expenses_confirmed',
      v_expenses,
      'expense_month',
      to_char(v_month, 'YYYY-MM-DD'),
      'daily_roster',
      v_daily,
      'weekly_roster',
      v_weekly,
      'latest_difference',
      v_latest,
      'cumulative_difference',
      v_cumulative,
      'revisions',
      v_history
    );
  end loop;

  return;
end;
$$;

comment on function app.list_shift_accounting_status (timestamptz, text, integer) is 'Owner only. One page of shifts after the (opened_at, id) cursor, at most 100, default 50. Each object lists independent causes, the derived label (ناقص, تقديري, السمك مقفول, مقفول نهائي), and the separate revised badge. Daily coverage is per required item and uses the anchor''s pinned shift. Weekly settlement names that pinned shift, the separate interval-owning shift, and the covered interval. Count coverage for the page is read once. A partial daily roster is تقديري only when no blocker is set. Unknown backfill tracking applies only to an item that already existed when the shift opened. An incomplete application, an unfinished rederive span, and unsettled work on either the latest snapshot shift or the live application shift are ناقص. Revision history follows captured_at, then the numeric cause_sort, then cause kind and id. source_at in that history is the economic time. Final closure also needs weekly coverage and the existing month_expense_status confirmation for the shift''s Cairo month. Completed-order readiness is atomic. Line coverage counts ready and exception lines on their own. Quantities and money are decimal text. Does not post stock and does not change record_count.';

revoke all on function app.list_shift_accounting_status (timestamptz, text, integer)
from
  public,
  anon,
  service_role;

grant
execute on function app.list_shift_accounting_status (timestamptz, text, integer) to authenticated;

-- ============================================================================
-- 6. RLS and grants. Owner-only select. No DML grant for any API role.
-- ============================================================================
alter table app.item_tracking_history enable row level security;

alter table app.sales_revision_facts enable row level security;

create policy item_tracking_history_select_owner on app.item_tracking_history for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy sales_revision_facts_select_owner on app.sales_revision_facts for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.item_tracking_history
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.sales_revision_facts
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.item_tracking_history,
  app.sales_revision_facts to authenticated,
  service_role;

revoke all on sequence app.item_tracking_history_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.sales_revision_facts_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.shift_count_coverage
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.shift_count_coverage to authenticated,
  service_role;

revoke all on table app.accounting_revision_differences
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.accounting_revision_differences to authenticated,
  service_role;
