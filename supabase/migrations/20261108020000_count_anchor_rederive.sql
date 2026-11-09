-- Count anchors and compensation (phase 5, PR 2).
--
-- Every stock_count_lines row is an anchor: item, counted_at, actual quantity.
-- Replay does not apply the original count movement or later compensators as
-- physical events. It replays surviving ordinary events through the anchor
-- instant, including events at that exact instant, then applies the whole
-- required adjustment D = actual - expected with the existing count valuation
-- formulas and continues from exactly the actual quantity.
--
-- Compensation is the gap between that required adjustment and the settlement
-- already posted for the line. A nonzero quantity gap appends
-- count_compensation carrying both the quantity gap and the value gap. The
-- value is that gap, not quantity times a unit cost. A zero quantity gap with
-- a nonzero value gap appends cost_adjustment on the group's first economic
-- movement. Both zero appends nothing, so a second replay posts nothing.
--
-- stock_count_anchors is a table, not a view: a zero-delta line has no
-- movement to read a shift from, and the shift is pinned when the line is
-- inserted. resolve_shift_id at read time would move if a shift boundary
-- changed. Linked count movements and posted compensators are left out of
-- the physical replay. An unlinked count_compensation stays a normal replay
-- input.
--
-- record_count is unchanged. A count at or before last_occurred_at is still
-- refused by the incremental guard. This migration does not add backdated
-- counts. Late ordinary movements go through anchor-aware replay.
-- post_backdated_batch no longer calls assert_count_barrier. The opening
-- floor and the finite-timestamp checks stay.
--
-- Replaced functions, each from its latest definition:
--   app.replay_prepare_tables()          base 20261103000000_backdated_recompute.sql
--   app.replay_execute(uuid[],jsonb,uuid,boolean)
--                                        base 20261108010000_outflow_reversals.sql
--   app.replay_component(uuid[],jsonb,uuid,boolean)
--                                        base 20261108010000_outflow_reversals.sql
--   app.post_backdated_batch(uuid,jsonb) base 20261103000000_backdated_recompute.sql
-- ============================================================================
-- 0. Lock order. The ledger advisory lock is first, then the tables this
-- migration touches, NOWAIT, so a session that holds a stock_items row lock
-- and wants this advisory lock fails with 55P03 instead of deadlocking.
-- ============================================================================
select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

do $lock_tables$
begin
  lock table app.stock_items,
  app.stock_movements,
  app.stock_counts,
  app.stock_count_lines,
  app.item_balances,
  app.provisional_deficits,
  app.period_revisions,
  app.shift_report_flags,
  app.movement_attributions,
  app.pos_shifts,
  app.units,
  ledger_scratch.recompute_bal,
  ledger_scratch.recompute_def,
  ledger_scratch.recompute_effect,
  ledger_scratch.recompute_piece,
  ledger_scratch.recompute_override,
  ledger_scratch.recompute_row,
  ledger_scratch.recompute_seq in share row exclusive mode nowait;
end;
$lock_tables$;

-- ============================================================================
-- 1. Anchor, derivation, and settlement membership
-- ============================================================================
create table app.stock_count_anchors (
  count_id uuid not null,
  line_no integer not null,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  counted_at timestamptz not null,
  actual_qty numeric(20, 6) not null,
  base_unit text not null,
  shift_id text null,
  primary key (count_id, line_no),
  foreign key (count_id, line_no) references app.stock_count_lines (count_id, line_no) on delete restrict,
  constraint stock_count_anchors_counted_at_chk check (pg_catalog.isfinite (counted_at)),
  constraint stock_count_anchors_actual_chk check (
    actual_qty <> 'NaN'::numeric
    and actual_qty >= 0
  ),
  constraint stock_count_anchors_base_unit_chk check (base_unit in ('kg', 'piece', 'liter'))
);

comment on table app.stock_count_anchors is 'One immutable anchor per stock count line, including a zero delta. actual_qty is the owner observation. shift_id is pinned at insert and is not re-resolved later.';

comment on column app.stock_count_anchors.actual_qty is 'Quantity the owner observed, copied from stock_count_lines.counted_qty.';

comment on column app.stock_count_anchors.shift_id is 'Shift pinned when the line was inserted: the count movement shift when it has one, otherwise resolve_shift_id(counted_at) at that moment. Null when no shift contains or precedes the count.';

create index stock_count_anchors_item_at_idx on app.stock_count_anchors (item_id, counted_at, count_id, line_no);

create table app.stock_count_derivations (
  id bigint generated always as identity primary key,
  count_id uuid not null,
  line_no integer not null,
  expected_qty numeric(20, 6) not null,
  required_qty numeric(20, 6) not null,
  required_value numeric(14, 2) not null,
  cause_batch_id uuid not null,
  predecessor_id bigint null references app.stock_count_derivations (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  unique (count_id, line_no, cause_batch_id),
  foreign key (count_id, line_no) references app.stock_count_lines (count_id, line_no) on delete restrict,
  constraint stock_count_derivations_finite_chk check (
    expected_qty <> 'NaN'::numeric
    and required_qty <> 'NaN'::numeric
    and required_value <> 'NaN'::numeric
    and required_value <> 'Infinity'::numeric
    and required_value <> '-Infinity'::numeric
    and pg_catalog.isfinite (created_at)
  )
);

comment on table app.stock_count_derivations is 'Append-only required count adjustment for one line. expected_qty is the replayed book quantity before the anchor. required_qty is actual minus that book quantity. required_value is the count-valuation value of that whole adjustment. A row is written only when the required result differs from the latest derivation, or from the original line when none exists.';

comment on column app.stock_count_derivations.predecessor_id is 'The previous derivation of this line. Null on the first derivation.';

comment on column app.stock_count_derivations.cause_batch_id is 'The replay cause batch that calculated this derivation. One derivation per line and cause.';

create index stock_count_derivations_line_idx on app.stock_count_derivations (count_id, line_no, id);

create table app.stock_count_postings (
  movement_id bigint primary key references app.stock_movements (id) on delete restrict,
  count_id uuid not null,
  line_no integer not null,
  posting_role text not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  foreign key (count_id, line_no) references app.stock_count_lines (count_id, line_no) on delete restrict,
  constraint stock_count_postings_role_chk check (posting_role in ('original', 'compensation')),
  constraint stock_count_postings_created_at_chk check (pg_catalog.isfinite (created_at))
);

comment on table app.stock_count_postings is 'Membership of the original count movement and later count_compensation rows in one line''s settlement group. A movement belongs to one line. Value-only cost adjustments are not members; they hang off the group''s first economic movement and are included in its effective value.';

comment on column app.stock_count_postings.posting_role is 'original is the count_adjustment stored on the line. compensation is a later count_compensation.';

create index stock_count_postings_line_idx on app.stock_count_postings (count_id, line_no);

create function app.trg_stock_count_postings_shape () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_type app.movement_type;
  v_item uuid;
  v_line_item uuid;
begin
  select
    sm.movement_type,
    sm.item_id
  into
    v_type,
    v_item
  from
    app.stock_movements sm
  where
    sm.id = new.movement_id;

  if not found then
    raise exception 'unknown count posting'
      using errcode = '22023';
  end if;

  select
    line.item_id
  into v_line_item
  from
    app.stock_count_lines line
  where
    line.count_id = new.count_id
    and line.line_no = new.line_no;

  if v_item is distinct from v_line_item then
    raise exception 'count posting item must match the line'
      using errcode = '22023';
  end if;

  if new.posting_role = 'original'
  and v_type is distinct from 'count_adjustment'::app.movement_type then
    raise exception 'original count posting must be a count_adjustment'
      using errcode = '22023';
  end if;

  if new.posting_role = 'compensation'
  and v_type is distinct from 'count_compensation'::app.movement_type then
    raise exception 'compensation posting must be a count_compensation'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function app.trg_stock_count_postings_shape ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_count_postings_shape
before insert on app.stock_count_postings for each row
execute function app.trg_stock_count_postings_shape ();

create trigger trg_stock_count_anchors_no_update_delete
before update or delete on app.stock_count_anchors for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_stock_count_anchors_no_truncate
before truncate on app.stock_count_anchors for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_stock_count_derivations_no_update_delete
before update or delete on app.stock_count_derivations for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_stock_count_derivations_no_truncate
before truncate on app.stock_count_derivations for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_stock_count_postings_no_update_delete
before update or delete on app.stock_count_postings for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_stock_count_postings_no_truncate
before truncate on app.stock_count_postings for each statement
execute function app.prevent_append_only_mutation ();

create function app.trg_stock_count_lines_anchor () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_at timestamptz;
  v_shift text;
begin
  select
    counted.counted_at
  into v_at
  from
    app.stock_counts counted
  where
    counted.id = new.count_id;

  if not found or v_at is null then
    raise exception 'count anchor is missing its count'
      using errcode = '23503';
  end if;

  if new.movement_id is not null then
    select
      sm.shift_id
    into v_shift
    from
      app.stock_movements sm
    where
      sm.id = new.movement_id;
  end if;

  if v_shift is null then
    v_shift := app.resolve_shift_id (v_at);
  end if;

  insert into
    app.stock_count_anchors (
      count_id,
      line_no,
      item_id,
      counted_at,
      actual_qty,
      base_unit,
      shift_id
    )
  values
    (
      new.count_id,
      new.line_no,
      new.item_id,
      v_at,
      new.counted_qty,
      new.expected_base_unit,
      v_shift
    );

  if new.movement_id is not null then
    insert into
      app.stock_count_postings (movement_id, count_id, line_no, posting_role)
    values
      (new.movement_id, new.count_id, new.line_no, 'original');
  end if;

  return new;
end;
$$;

comment on function app.trg_stock_count_lines_anchor () is 'Copies a new count line into stock_count_anchors and, when the line posted a movement, into stock_count_postings. The shift is the movement shift or resolve_shift_id(counted_at) at insert.';

revoke all on function app.trg_stock_count_lines_anchor ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_count_lines_anchor
after insert on app.stock_count_lines for each row
execute function app.trg_stock_count_lines_anchor ();

insert into
  app.stock_count_anchors (
    count_id,
    line_no,
    item_id,
    counted_at,
    actual_qty,
    base_unit,
    shift_id
  )
select
  line.count_id,
  line.line_no,
  line.item_id,
  counted.counted_at,
  line.counted_qty,
  line.expected_base_unit,
  coalesce(
    sm.shift_id,
    app.resolve_shift_id (counted.counted_at)
  )
from
  app.stock_count_lines line
  join app.stock_counts counted on counted.id = line.count_id
  left join app.stock_movements sm on sm.id = line.movement_id;

insert into
  app.stock_count_postings (movement_id, count_id, line_no, posting_role)
select
  line.movement_id,
  line.count_id,
  line.line_no,
  'original'
from
  app.stock_count_lines line
where
  line.movement_id is not null;

alter table app.stock_count_anchors enable row level security;

alter table app.stock_count_derivations enable row level security;

alter table app.stock_count_postings enable row level security;

create policy stock_count_anchors_select_owner on app.stock_count_anchors for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy stock_count_derivations_select_owner on app.stock_count_derivations for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy stock_count_postings_select_owner on app.stock_count_postings for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.stock_count_anchors
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.stock_count_derivations
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.stock_count_postings
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_count_anchors,
  app.stock_count_derivations,
  app.stock_count_postings to authenticated,
  service_role;

-- ============================================================================
-- 2. Scratch for the anchors applied during one replay
-- ============================================================================
create table ledger_scratch.recompute_anchor (
  anchor_ord bigint primary key,
  count_id uuid not null,
  line_no integer not null,
  item_id uuid not null,
  counted_at timestamptz not null,
  actual_qty numeric(20, 6) not null,
  shift_id text null,
  expected_qty numeric(20, 6) null,
  required_qty numeric(20, 6) null,
  required_value numeric(14, 2) null
);

comment on table ledger_scratch.recompute_anchor is 'Anchors applied by the current replay. required_qty and required_value are filled as each anchor is applied. Truncated with the other scratch tables.';

revoke all on table ledger_scratch.recompute_anchor
from
  public,
  anon,
  authenticated,
  service_role;

alter table ledger_scratch.recompute_anchor enable row level security;

create or replace function app.replay_prepare_tables () returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  truncate ledger_scratch.recompute_row,
  ledger_scratch.recompute_bal,
  ledger_scratch.recompute_def,
  ledger_scratch.recompute_effect,
  ledger_scratch.recompute_piece,
  ledger_scratch.recompute_override,
  ledger_scratch.recompute_seq,
  ledger_scratch.recompute_anchor;
end;
$$;

comment on function app.replay_prepare_tables () is 'Truncates the replay scratch tables, including count anchors. Caller holds the ledger lock.';

revoke all on function app.replay_prepare_tables ()
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 3. Apply one anchor virtually, then settle the ledger gap on write
-- ============================================================================
create function app.replay_apply_anchor (p_anchor_ord bigint) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_item uuid;
  v_at timestamptz;
  v_actual numeric(20, 6);
  v_expected numeric(20, 6);
  v_avg numeric(20, 6);
  v_required_qty numeric(20, 6);
  v_required_value numeric(14, 2);
  v_syn bigint;
  v_after numeric(20, 6);
begin
  select
    a.item_id,
    a.counted_at,
    a.actual_qty
  into
    v_item,
    v_at,
    v_actual
  from
    ledger_scratch.recompute_anchor a
  where
    a.anchor_ord = p_anchor_ord;

  if not found then
    perform app.raise_recompute_failure ('critical');
  end if;

  select
    b.on_hand_qty,
    b.avg_cost
  into
    v_expected,
    v_avg
  from
    ledger_scratch.recompute_bal b
  where
    b.item_id = v_item;

  if not found then
    perform app.raise_recompute_failure ('critical');
  end if;

  v_required_qty := app.assert_recompute_range (v_actual - v_expected, 6, true);

  if v_required_qty = 0 then
    v_required_value := 0;
  else
    -- Negative ids cannot collide with ledger ids or pending stand-ins.
    v_syn := -p_anchor_ord;

    if v_required_qty > 0 then
      perform app.replay_inflow (
        v_syn,
        v_item,
        'count_adjustment',
        v_at,
        v_required_qty,
        v_avg,
        0,
        false,
        0,
        null,
        null,
        null,
        null
      );
    else
      perform app.replay_outflow (
        v_syn,
        v_item,
        'count_adjustment',
        v_at,
        -v_required_qty,
        null,
        false,
        0,
        null,
        null,
        null,
        null
      );
    end if;

    select
      fx.base_total
    into v_required_value
    from
      ledger_scratch.recompute_effect fx
    where
      fx.movement_id = v_syn;

    if not found then
      perform app.raise_recompute_failure ('critical');
    end if;
  end if;

  select
    b.on_hand_qty
  into v_after
  from
    ledger_scratch.recompute_bal b
  where
    b.item_id = v_item;

  if v_after is distinct from v_actual then
    perform app.raise_recompute_failure ('critical');
  end if;

  update ledger_scratch.recompute_anchor
  set
    expected_qty = v_expected,
    required_qty = v_required_qty,
    required_value = v_required_value
  where
    anchor_ord = p_anchor_ord;
end;
$$;

comment on function app.replay_apply_anchor (bigint) is 'Applies one count anchor in scratch. Ordinary events at the same instant have already run. The required value is the count valuation of D = actual - expected, not a replay of the stored count movement.';

revoke all on function app.replay_apply_anchor (bigint)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.settle_count_anchors (p_cause uuid, p_item_ids uuid[]) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  a record;
  v_posted_qty numeric(20, 6);
  v_posted_value numeric(14, 2);
  v_qty_diff numeric(20, 6);
  v_val_diff numeric(14, 2);
  v_new_id bigint;
  v_target_id bigint;
  v_target_type app.movement_type;
  v_line_qty numeric(20, 6);
  v_line_value numeric(14, 2);
  v_prev_id bigint;
  v_prev_qty numeric(20, 6);
  v_prev_value numeric(14, 2);
  v_compare_qty numeric(20, 6);
  v_compare_value numeric(14, 2);
begin
  for a in
    select
      anchor.anchor_ord,
      anchor.count_id,
      anchor.line_no,
      anchor.item_id,
      anchor.counted_at,
      anchor.shift_id,
      anchor.expected_qty,
      anchor.required_qty,
      anchor.required_value
    from
      ledger_scratch.recompute_anchor anchor
    where
      anchor.item_id = any (p_item_ids)
    order by
      anchor.anchor_ord
  loop
    if a.required_qty is null
    or a.required_value is null
    or a.expected_qty is null then
      perform app.raise_recompute_failure ('critical');
    end if;

    select
      coalesce(sum(sm.quantity), 0),
      coalesce(
        sum(
          sm.total_cost + coalesce(
            (
              select
                sum(ca.total_cost)
              from
                app.stock_movements ca
              where
                ca.adjusts_movement_id = sm.id
                and ca.movement_type = 'cost_adjustment'
            ),
            0
          )
        ),
        0
      )
    into
      v_posted_qty,
      v_posted_value
    from
      app.stock_count_postings posting
      join app.stock_movements sm on sm.id = posting.movement_id
    where
      posting.count_id = a.count_id
      and posting.line_no = a.line_no
      and sm.movement_type in ('count_adjustment', 'count_compensation');

    v_qty_diff := app.assert_recompute_range (a.required_qty - v_posted_qty, 6, true);
    v_val_diff := app.assert_recompute_range (a.required_value - v_posted_value, 2, true);

    if v_qty_diff <> 0 then
      insert into
        app.stock_movements (
          batch_id,
          item_id,
          movement_type,
          occurred_at,
          quantity,
          unit_cost,
          total_cost,
          is_provisional,
          shift_id,
          source_type,
          source_id
        )
      values
        (
          p_cause,
          a.item_id,
          'count_compensation',
          a.counted_at,
          v_qty_diff,
          0,
          v_val_diff,
          false,
          a.shift_id,
          'recompute',
          p_cause::text
        )
      returning
        id into v_new_id;

      insert into
        app.stock_count_postings (movement_id, count_id, line_no, posting_role)
      values
        (v_new_id, a.count_id, a.line_no, 'compensation');

      perform app.note_period_revision (
        v_new_id,
        a.shift_id,
        'count',
        v_val_diff,
        a.item_id,
        p_cause
      );
    elsif v_val_diff <> 0 then
      select
        sm.id,
        sm.movement_type
      into
        v_target_id,
        v_target_type
      from
        app.stock_count_postings posting
        join app.stock_movements sm on sm.id = posting.movement_id
      where
        posting.count_id = a.count_id
        and posting.line_no = a.line_no
        and sm.movement_type in ('count_adjustment', 'count_compensation')
      order by
        sm.id
      limit
        1;

      if v_target_id is null then
        perform app.raise_recompute_failure ('critical');
      end if;

      insert into
        app.stock_movements (
          batch_id,
          item_id,
          movement_type,
          occurred_at,
          quantity,
          unit_cost,
          total_cost,
          is_provisional,
          adjusts_movement_id,
          shift_id,
          source_type,
          source_id
        )
      values
        (
          p_cause,
          a.item_id,
          'cost_adjustment',
          a.counted_at,
          0,
          0,
          v_val_diff,
          false,
          v_target_id,
          a.shift_id,
          'recompute',
          p_cause::text
        )
      returning
        id into v_new_id;

      perform app.note_period_revision (
        v_new_id,
        a.shift_id,
        app.profit_bucket (v_target_type),
        v_val_diff,
        a.item_id,
        p_cause
      );
    end if;

    select
      line.delta_qty,
      line.delta_value
    into
      v_line_qty,
      v_line_value
    from
      app.stock_count_lines line
    where
      line.count_id = a.count_id
      and line.line_no = a.line_no;

    select
      deriv.id,
      deriv.required_qty,
      deriv.required_value
    into
      v_prev_id,
      v_prev_qty,
      v_prev_value
    from
      app.stock_count_derivations deriv
    where
      deriv.count_id = a.count_id
      and deriv.line_no = a.line_no
    order by
      deriv.id desc
    limit
      1;

    if found then
      v_compare_qty := v_prev_qty;
      v_compare_value := v_prev_value;
    else
      v_prev_id := null;
      v_compare_qty := v_line_qty;
      v_compare_value := v_line_value;
    end if;

    if a.required_qty is distinct from v_compare_qty
    or a.required_value is distinct from v_compare_value then
      if exists (
        select
          1
        from
          app.stock_count_derivations deriv
        where
          deriv.count_id = a.count_id
          and deriv.line_no = a.line_no
          and deriv.cause_batch_id = p_cause
      ) then
        perform app.raise_recompute_failure ('critical');
      end if;

      insert into
        app.stock_count_derivations (
          count_id,
          line_no,
          expected_qty,
          required_qty,
          required_value,
          cause_batch_id,
          predecessor_id
        )
      values
        (
          a.count_id,
          a.line_no,
          a.expected_qty,
          a.required_qty,
          a.required_value,
          p_cause,
          v_prev_id
        );
    end if;
  end loop;
end;
$$;

comment on function app.settle_count_anchors (uuid, uuid[]) is 'Posts the gap between each applied anchor and its settlement group. Nonzero quantity posts count_compensation with the value gap. Zero quantity and nonzero value posts cost_adjustment on the earliest economic member. A matching replay posts nothing.';

revoke all on function app.settle_count_anchors (uuid, uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 4. Anchor-aware replay. Body is the outflow-reversals replay_execute with
-- count settlement rows omitted and anchors interleaved after ordinary events.
-- ============================================================================
create or replace function app.replay_execute (
  p_item_ids uuid[],
  p_pending jsonb,
  p_cause uuid,
  p_write boolean
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  r record;
  s record;
  sz record;
  v_base bigint;
  v_done uuid[] := '{}'::uuid[];
  v_raw uuid;
  v_out_n bigint;
  v_loss_n bigint;
  v_size_n bigint;
  v_size_i bigint;
  v_qty_taken numeric(20, 6);
  v_on_qty numeric(20, 6);
  v_on_value numeric(14, 2);
  v_avg numeric(20, 6);
  v_has_def boolean;
  v_value_taken numeric(14, 2);
  v_loss_qty numeric(20, 6);
  v_loss_value numeric(14, 2);
  v_remaining_value numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_size_value numeric(14, 2);
  v_size_unit numeric(20, 6);
  v_forced numeric(14, 2);
  v_unit numeric(20, 6);
  v_old numeric(14, 2);
  v_required numeric(14, 2);
  v_existing numeric(14, 2);
  v_diff numeric(14, 2);
  v_unit_diff numeric(20, 6);
  v_shift text;
  v_new_id bigint;
  e record;
begin
  if p_pending is null then
    p_pending := '[]'::jsonb;
  end if;

  perform app.replay_prepare_tables ();

  insert into
    ledger_scratch.recompute_bal (
      item_id,
      on_hand_qty,
      on_hand_value,
      avg_cost,
      has_uncovered_deficit
    )
  select distinct
    t.item_id,
    0,
    0,
    0,
    false
  from
    pg_catalog.unnest(p_item_ids) as t (item_id)
  where
    t.item_id is not null;

  insert into
    ledger_scratch.recompute_row (
      movement_id,
      is_pending,
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      is_input_total,
      shift_id,
      source_type,
      source_id,
      note,
      ord_class,
      line_key,
      consumed,
      event_position,
      piece_position,
      engine_valued
    )
  select
    sm.id,
    false,
    sm.batch_id,
    sm.item_id,
    sm.movement_type,
    sm.occurred_at,
    sm.quantity,
    sm.unit_cost,
    sm.total_cost,
    sm.movement_type in ('purchase', 'opening'),
    sm.shift_id,
    sm.source_type,
    sm.source_id,
    sm.note,
    case
      when sm.movement_type = 'count_adjustment'
      and exists (
        select
          1
        from
          app.stock_count_lines scl
        where
          scl.movement_id = sm.id
      ) then 1
      else 0
    end,
    0,
    false,
    coalesce(sm.event_position, sm.id),
    coalesce(sm.piece_position, 0),
    coalesce(sm.engine_valued, false)
  from
    app.stock_movements sm
  where
    sm.item_id = any (p_item_ids)
    and sm.movement_type <> 'cost_adjustment'
    and sm.reverses_movement_id is null
    and sm.movement_type not in ('sale_reversal', 'waste_reversal')
    and not exists (
      select
        1
      from
        app.stock_movements rev
      where
        rev.reverses_movement_id = sm.id
    )
    and not exists (
      select
        1
      from
        app.stock_count_lines linked
      where
        linked.movement_id = sm.id
    )
    and not exists (
      select
        1
      from
        app.stock_count_postings posting
      where
        posting.movement_id = sm.id
    );

  select
    coalesce(max(sm.id), 0)
  into v_base
  from
    app.stock_movements sm;

  insert into
    ledger_scratch.recompute_row (
      movement_id,
      is_pending,
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      is_input_total,
      shift_id,
      source_type,
      source_id,
      note,
      ord_class,
      line_key,
      consumed,
      event_position,
      piece_position,
      engine_valued
    )
  select
    v_base + (elem.value ->> 'line_key')::integer,
    true,
    (elem.value ->> 'batch_id')::uuid,
    (elem.value ->> 'item_id')::uuid,
    (elem.value ->> 'movement_type')::app.movement_type,
    (elem.value ->> 'occurred_at')::timestamptz,
    (elem.value ->> 'quantity')::numeric,
    coalesce((elem.value ->> 'unit_cost')::numeric, 0),
    coalesce((elem.value ->> 'total_cost')::numeric, 0),
    coalesce((elem.value ->> 'is_input_total')::boolean, false),
    elem.value ->> 'shift_id',
    elem.value ->> 'source_type',
    elem.value ->> 'source_id',
    elem.value ->> 'note',
    0,
    (elem.value ->> 'line_key')::integer,
    false,
    coalesce(
      (elem.value ->> 'event_position')::bigint,
      v_base + (elem.value ->> 'line_key')::integer
    ),
    coalesce((elem.value ->> 'piece_position')::integer, 0),
    coalesce((elem.value ->> 'engine_valued')::boolean, false)
  from
    pg_catalog.jsonb_array_elements(p_pending) as elem (value);

  insert into
    ledger_scratch.recompute_seq (next_id)
  select
    coalesce(max(q.movement_id), 0)
  from
    ledger_scratch.recompute_row q;

  -- Anchors are replay events too, so they count against the same cap.
  if (
    select
      count(*)
    from
      ledger_scratch.recompute_row
  ) + (
    select
      count(*)
    from
      app.stock_count_anchors anchor
    where
      anchor.item_id = any (p_item_ids)
  ) > 100000 then
    perform app.raise_recompute_failure ('recompute_limit');
  end if;

  insert into
    ledger_scratch.recompute_anchor (
      anchor_ord,
      count_id,
      line_no,
      item_id,
      counted_at,
      actual_qty,
      shift_id
    )
  select
    pg_catalog.row_number() over (
      order by
        anchor.counted_at,
        anchor.count_id,
        anchor.line_no
    ),
    anchor.count_id,
    anchor.line_no,
    anchor.item_id,
    anchor.counted_at,
    anchor.actual_qty,
    anchor.shift_id
  from
    app.stock_count_anchors anchor
  where
    anchor.item_id = any (p_item_ids);

  for r in
    select
      merged.*
    from
      (
        select
          q.movement_id,
          q.is_pending,
          q.batch_id,
          q.item_id,
          q.movement_type,
          q.occurred_at,
          q.quantity,
          q.unit_cost,
          q.total_cost,
          q.is_input_total,
          q.shift_id,
          q.source_type,
          q.source_id,
          q.note,
          q.ord_class,
          q.line_key,
          q.consumed,
          q.event_position,
          q.piece_position,
          q.engine_valued,
          false as is_anchor
        from
          ledger_scratch.recompute_row q
        union all
        select
          anchor.anchor_ord,
          false,
          anchor.count_id,
          anchor.item_id,
          'count_adjustment'::app.movement_type,
          anchor.counted_at,
          anchor.actual_qty,
          0::numeric,
          0::numeric,
          false,
          anchor.shift_id,
          null::text,
          null::text,
          null::text,
          1,
          0,
          false,
          0::bigint,
          0,
          false,
          true
        from
          ledger_scratch.recompute_anchor anchor
      ) as merged
    order by
      merged.occurred_at asc,
      merged.ord_class asc,
      merged.event_position asc,
      merged.piece_position asc,
      merged.movement_id asc
  loop
    if r.is_anchor then
      perform app.replay_apply_anchor (r.movement_id);
      continue;
    end if;

    if r.movement_type in ('sale_reversal', 'waste_reversal') then
      continue;
    end if;

    if r.movement_type in ('sort_out', 'sort_in', 'sort_loss')
    and r.batch_id = any (v_done) then
      continue;
    end if;

    if r.movement_type in ('sort_out', 'sort_in', 'sort_loss') then
      select
        count(*) filter (
          where
            q.movement_type = 'sort_out'
        ),
        count(*) filter (
          where
            q.movement_type = 'sort_loss'
        ),
        count(*) filter (
          where
            q.movement_type = 'sort_in'
        )
      into
        v_out_n,
        v_loss_n,
        v_size_n
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type in ('sort_out', 'sort_in', 'sort_loss');

      if v_out_n <> 1 or v_loss_n > 1 then
        perform app.raise_recompute_failure ('critical');
      end if;

      select
        q.item_id
      into v_raw
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type = 'sort_out';

      select
        coalesce(sum(-q.quantity), 0)
      into v_qty_taken
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type in ('sort_out', 'sort_loss')
        and q.item_id = v_raw;

      select
        b.on_hand_qty,
        b.on_hand_value,
        b.avg_cost,
        b.has_uncovered_deficit
      into
        v_on_qty,
        v_on_value,
        v_avg,
        v_has_def
      from
        ledger_scratch.recompute_bal b
      where
        b.item_id = v_raw;

      if v_has_def
      or v_on_qty <= 0
      or v_qty_taken > v_on_qty then
        raise exception 'not enough stock to sort: on_hand_qty %, requested %',
          v_on_qty,
          v_qty_taken
          using errcode = '22023';
      end if;

      if v_qty_taken = v_on_qty then
        v_value_taken := v_on_value;
      else
        v_value_taken := pg_catalog.round(v_on_value * v_qty_taken / v_on_qty, 2);
      end if;

      v_value_taken := app.assert_recompute_range (v_value_taken, 2, true);
      v_avg := app.assert_recompute_range (v_avg, 6, false);

      select
        coalesce(sum(-q.quantity), 0)
      into v_loss_qty
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type = 'sort_loss';

      v_remaining_value := v_value_taken;
      v_remaining_qty := v_qty_taken;

      if v_loss_qty > 0 then
        v_loss_value := pg_catalog.round(
          v_remaining_value * v_loss_qty / v_remaining_qty,
          2
        );

        if v_loss_value < 0 then
          v_loss_value := 0;
        elsif v_loss_value > v_remaining_value then
          v_loss_value := v_remaining_value;
        end if;

        v_remaining_value := v_remaining_value - v_loss_value;
        v_remaining_qty := v_remaining_qty - v_loss_qty;
      else
        v_loss_value := 0;
      end if;

      insert into
        ledger_scratch.recompute_override (movement_id, unit_cost, total_cost)
      select
        q.movement_id,
        v_avg,
        -v_remaining_value
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type = 'sort_out';

      if v_loss_qty > 0 then
        insert into
          ledger_scratch.recompute_override (movement_id, unit_cost, total_cost)
        select
          q.movement_id,
          v_avg,
          -v_loss_value
        from
          ledger_scratch.recompute_row q
        where
          q.batch_id = r.batch_id
          and q.movement_type = 'sort_loss';
      end if;

      v_size_i := 0;

      for sz in
        select
          q.*
        from
          ledger_scratch.recompute_row q
        where
          q.batch_id = r.batch_id
          and q.movement_type = 'sort_in'
        order by
          q.event_position asc,
          q.piece_position asc,
          q.movement_id asc
      loop
        v_size_i := v_size_i + 1;

        if v_size_i = v_size_n then
          v_size_value := v_remaining_value;
        else
          v_size_value := pg_catalog.round(
            v_remaining_value * sz.quantity / v_remaining_qty,
            2
          );

          if v_size_value < 0 then
            v_size_value := 0;
          elsif v_size_value > v_remaining_value then
            v_size_value := v_remaining_value;
          end if;
        end if;

        v_remaining_value := v_remaining_value - v_size_value;
        v_remaining_qty := v_remaining_qty - sz.quantity;
        v_size_unit := app.assert_recompute_range (
          pg_catalog.round(v_size_value / sz.quantity, 6),
          6,
          false
        );
        v_size_value := app.assert_recompute_range (v_size_value, 2, false);

        insert into
          ledger_scratch.recompute_override (movement_id, unit_cost, total_cost)
        values
          (sz.movement_id, v_size_unit, v_size_value);
      end loop;

      for s in
        select
          q.*
        from
          ledger_scratch.recompute_row q
        where
          q.batch_id = r.batch_id
          and q.movement_type in ('sort_out', 'sort_in', 'sort_loss')
        order by
          q.event_position asc,
          q.piece_position asc,
          q.movement_id asc
      loop
        select
          o.unit_cost,
          o.total_cost
        into
          v_unit,
          v_forced
        from
          ledger_scratch.recompute_override o
        where
          o.movement_id = s.movement_id;

        if s.movement_type = 'sort_in' then
          perform app.replay_inflow (
            s.movement_id,
            s.item_id,
            s.movement_type,
            s.occurred_at,
            s.quantity,
            v_unit,
            v_forced,
            s.is_pending,
            s.line_key,
            s.shift_id,
            s.source_type,
            s.source_id,
            s.note
          );
        else
          perform app.replay_outflow (
            s.movement_id,
            s.item_id,
            s.movement_type,
            s.occurred_at,
            -s.quantity,
            v_forced,
            s.is_pending,
            s.line_key,
            s.shift_id,
            s.source_type,
            s.source_id,
            s.note
          );
        end if;
      end loop;

      v_done := v_done || r.batch_id;
    elsif r.quantity < 0 then
      perform app.replay_outflow (
        r.movement_id,
        r.item_id,
        r.movement_type,
        r.occurred_at,
        -r.quantity,
        null,
        r.is_pending,
        r.line_key,
        r.shift_id,
        r.source_type,
        r.source_id,
        r.note
      );
    elsif r.quantity > 0 then
      perform app.replay_inflow (
        r.movement_id,
        r.item_id,
        r.movement_type,
        r.occurred_at,
        r.quantity,
        r.unit_cost,
        r.total_cost,
        r.is_pending,
        r.line_key,
        r.shift_id,
        r.source_type,
        r.source_id,
        r.note
      );
    else
      perform app.raise_recompute_failure ('critical');
    end if;
  end loop;

  if not p_write then
    return;
  end if;

  for e in
    select
      fx.movement_id,
      fx.item_id,
      fx.movement_type,
      fx.base_total,
      fx.unit_cost as replay_unit,
      fx.cover_total,
      sm.total_cost as stored_total,
      sm.unit_cost as stored_unit,
      sm.occurred_at
    from
      ledger_scratch.recompute_effect fx
      join app.stock_movements sm on sm.id = fx.movement_id
  loop
    select
      coalesce(sum(ca.total_cost), 0)
    into v_old
    from
      app.stock_movements ca
    where
      ca.adjusts_movement_id = e.movement_id
      and ca.movement_type = 'cost_adjustment';

    v_required := e.base_total + e.cover_total;
    v_existing := e.stored_total + v_old;
    v_diff := v_required - v_existing;

    if v_diff <> 0 then
      v_diff := app.assert_recompute_range (v_diff, 2, true);
      v_unit_diff := app.assert_recompute_range (e.replay_unit - e.stored_unit, 6, true);
      v_shift := app.shift_for_target (e.movement_id);

      insert into
        app.stock_movements (
          batch_id,
          item_id,
          movement_type,
          occurred_at,
          quantity,
          unit_cost,
          total_cost,
          is_provisional,
          adjusts_movement_id,
          shift_id,
          source_type,
          source_id
        )
      values
        (
          p_cause,
          e.item_id,
          'cost_adjustment',
          e.occurred_at,
          0,
          v_unit_diff,
          v_diff,
          false,
          e.movement_id,
          v_shift,
          'recompute',
          p_cause::text
        )
      returning
        id into v_new_id;

      perform app.note_period_revision (
        v_new_id,
        v_shift,
        app.profit_bucket (e.movement_type),
        v_diff,
        e.item_id,
        p_cause
      );
    end if;
  end loop;

  perform app.settle_count_anchors (p_cause, p_item_ids);

  delete from app.provisional_deficits pd
  where
    pd.item_id = any (p_item_ids);

  insert into
    app.provisional_deficits (
      movement_id,
      item_id,
      qty_uncovered,
      provisional_unit_cost,
      value_uncovered
    )
  select
    d.movement_id,
    d.item_id,
    d.qty_uncovered,
    d.provisional_unit_cost,
    d.value_uncovered
  from
    ledger_scratch.recompute_def d
  where
    d.item_id = any (p_item_ids);

  update app.item_balances ib
  set
    on_hand_qty = b.on_hand_qty,
    on_hand_value = b.on_hand_value,
    avg_cost = b.avg_cost,
    has_uncovered_deficit = exists (
      select
        1
      from
        app.provisional_deficits pd
      where
        pd.item_id = ib.item_id
        and pd.qty_uncovered > 0
    ),
    last_occurred_at = greatest(
      ib.last_occurred_at,
      (
        select
          max(sm.occurred_at)
        from
          app.stock_movements sm
        where
          sm.item_id = ib.item_id
          and sm.movement_type <> 'cost_adjustment'
      ),
      (
        select
          max(sc.counted_at + interval '1 microsecond')
        from
          app.stock_count_lines scl
          join app.stock_counts sc on sc.id = scl.count_id
        where
          scl.item_id = ib.item_id
      )
    )
  from
    ledger_scratch.recompute_bal b
  where
    ib.item_id = b.item_id
    and ib.item_id = any (p_item_ids);

  if exists (
    select
      1
    from
      app.stock_movements target
      join app.stock_movements rev on rev.reverses_movement_id = target.id
    where
      target.item_id = any (p_item_ids)
      and (
        target.quantity + rev.quantity <> 0
        or target.total_cost + rev.total_cost + coalesce(
          (
            select
              sum(ca.total_cost)
            from
              app.stock_movements ca
            where
              ca.movement_type = 'cost_adjustment'
              and ca.adjusts_movement_id in (target.id, rev.id)
          ),
          0
        ) <> 0
      )
  ) then
    perform app.raise_recompute_failure ('critical');
  end if;

  if exists (
    select
      1
    from
      app.item_balances ib
    where
      ib.item_id = any (p_item_ids)
      and (
        ib.on_hand_qty is distinct from (
          select
            coalesce(sum(sm.quantity), 0)
          from
            app.stock_movements sm
          where
            sm.item_id = ib.item_id
        )
        or ib.on_hand_value is distinct from (
          select
            coalesce(sum(sm.total_cost), 0)
          from
            app.stock_movements sm
          where
            sm.item_id = ib.item_id
        )
      )
  ) then
    perform app.raise_recompute_failure ('critical');
  end if;
exception
  when numeric_value_out_of_range then
    perform app.raise_recompute_failure ('critical');
end;
$$;

comment on function app.replay_execute (uuid[], jsonb, uuid, boolean) is 'Replays one component. Count lines are virtual anchors applied after ordinary events at the same instant. On write, settles count compensation and rebuilds balances. The 100000-row cap counts economic replay rows and anchors together.';

revoke all on function app.replay_execute (uuid[], jsonb, uuid, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 5. The replay seam and the back-dated poster
-- ============================================================================
create or replace function app.replay_component (
  p_item_ids uuid[],
  p_pending jsonb,
  p_cause uuid,
  p_write boolean
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_set uuid[];
begin
  perform app.assert_ledger_lock_held ();

  if p_cause is null then
    raise exception 'cause batch is required'
      using errcode = '22023';
  end if;

  -- Anchor-aware replay. retire_movements and post_engine_outflows call only
  -- this function. replay_execute applies count lines as virtual anchors and,
  -- on write, settles compensators. There is no frontier shortcut.
  lock table app.pos_shifts in share mode;

  v_set := app.recompute_item_set (p_item_ids);

  perform app.prepare_balance_locks (v_set);

  perform app.replay_execute (v_set, coalesce(p_pending, '[]'::jsonb), p_cause, p_write);
end;
$$;

comment on function app.replay_component (uuid[], jsonb, uuid, boolean) is 'Anchor-aware replay seam. Caller holds the ledger lock. Count lines are virtual anchors; compensators are settled by replay_execute.';

revoke all on function app.replay_component (uuid[], jsonb, uuid, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.post_backdated_batch (p_batch_id uuid, p_pending jsonb) returns bigint[] language plpgsql security definer
set
  search_path = '' as $$
declare
  e record;
  r record;
  v_seed uuid[] := '{}'::uuid[];
  v_times timestamptz[] := '{}'::timestamptz[];
  v_types text[] := '{}'::text[];
  v_set uuid[];
  v_ids bigint[] := '{}'::bigint[];
  v_id bigint;
  v_shift text;
  v_bucket text;
  v_at timestamptz;
begin
  perform app.assert_ledger_write_allowed ();

  lock table app.pos_shifts in share mode;

  if p_pending is null
  or pg_catalog.jsonb_typeof(p_pending) <> 'array' then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;

  for e in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_pending) as elem (value)
  loop
    v_at := (e.value ->> 'occurred_at')::timestamptz;

    if v_at is null or not pg_catalog.isfinite(v_at) then
      raise exception 'occurred_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    v_seed := v_seed || (e.value ->> 'item_id')::uuid;
    v_times := v_times || v_at;
    v_types := v_types || (e.value ->> 'movement_type');
  end loop;

  v_set := app.recompute_item_set (v_seed);

  perform app.prepare_balance_locks (v_set);

  perform app.assert_not_before_opening (v_seed, v_times, v_types);

  -- Count lines are anchors inside replay_execute. There is no count barrier.
  perform app.replay_execute (v_set, p_pending, p_batch_id, false);

  for r in
    select
      p.*
    from
      ledger_scratch.recompute_piece p
    order by
      p.line_key asc,
      p.piece_no asc
  loop
    insert into
      app.stock_movements (
        batch_id,
        item_id,
        movement_type,
        occurred_at,
        quantity,
        unit_cost,
        total_cost,
        is_provisional,
        shift_id,
        source_type,
        source_id,
        note
      )
    values
      (
        p_batch_id,
        r.item_id,
        r.movement_type,
        r.occurred_at,
        r.quantity,
        r.unit_cost,
        r.total_cost,
        r.is_provisional,
        r.shift_id,
        r.source_type,
        r.source_id,
        r.note
      )
    returning
      id into v_id;

    if r.movement_type = 'purchase' then
      v_ids := v_ids || v_id;
    end if;

    v_bucket := app.profit_bucket (r.movement_type);

    if v_bucket is not null then
      v_shift := app.shift_for_target (v_id);

      perform app.note_period_revision (
        v_id,
        v_shift,
        v_bucket,
        r.total_cost,
        r.item_id,
        p_batch_id
      );
    end if;
  end loop;

  perform app.rebuild_derived_balances (v_seed, p_batch_id);

  return v_ids;
end;
$$;

comment on function app.post_backdated_batch (uuid, jsonb) is 'Inserts one back-dated batch at replayed cost, then rebuilds the component. Does not call assert_count_barrier. Opening-floor and finite-timestamp checks stay. Count anchors are settled by the rebuild.';

revoke all on function app.post_backdated_batch (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 6. Count history. Original shortage and surplus stay the frozen line
-- totals. Later columns are the latest derivation and the compensator sum.
-- ============================================================================
create or replace view app.stock_count_history
with
  (security_invoker = true) as
select
  counted.id,
  counted.counted_at,
  counted.frequency,
  counted.created_at,
  counted.note,
  count(line.item_id)::integer as item_count,
  coalesce(
    sum(- line.delta_value) filter (
      where
        line.delta_qty < 0
    ),
    0::numeric
  )::numeric(14, 2) as shortage_value,
  coalesce(
    sum(line.delta_value) filter (
      where
        line.delta_qty > 0
    ),
    0::numeric
  )::numeric(14, 2) as surplus_value,
  coalesce(bool_or(line.delta_qty > 0), false) as has_surplus,
  coalesce(
    sum(
      coalesce(latest.required_value, line.delta_value) - line.delta_value
    ),
    0::numeric
  )::numeric(14, 2) as revised_difference,
  coalesce(sum(comp.compensator_value), 0::numeric)::numeric(14, 2) as compensator_sum,
  coalesce(bool_or(comp.compensator_count > 0), false) as has_compensator
from
  app.stock_counts counted
  join app.stock_count_lines line on line.count_id = counted.id
  left join lateral (
    select
      deriv.required_value
    from
      app.stock_count_derivations deriv
    where
      deriv.count_id = line.count_id
      and deriv.line_no = line.line_no
    order by
      deriv.id desc
    limit
      1
  ) latest on true
  left join lateral (
    select
      coalesce(sum(sm.total_cost), 0)::numeric(14, 2) as compensator_value,
      count(sm.id)::integer as compensator_count
    from
      app.stock_count_postings posting
      join app.stock_movements sm on sm.id = posting.movement_id
    where
      posting.count_id = line.count_id
      and posting.line_no = line.line_no
      and sm.movement_type = 'count_compensation'
  ) comp on true
group by
  counted.id;

comment on view app.stock_count_history is 'One row per count. security_invoker so RLS applies. shortage_value and surplus_value stay the frozen original line totals. revised_difference is the latest required value minus that original value. compensator_sum is the signed sum of count_compensation values. has_compensator is true when any compensator exists.';

revoke all on table app.stock_count_history
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_count_history to authenticated,
  service_role;

create view app.stock_count_line_current
with
  (security_invoker = true) as
select
  line.count_id,
  line.line_no,
  line.item_id,
  counted.counted_at,
  line.counted_qty,
  line.expected_qty as original_expected_qty,
  line.delta_qty as original_delta_qty,
  line.delta_value as original_delta_value,
  coalesce(latest.expected_qty, line.expected_qty) as latest_expected_qty,
  coalesce(latest.required_qty, line.delta_qty) as latest_required_qty,
  coalesce(latest.required_value, line.delta_value) as latest_required_value,
  comp.compensator_qty,
  comp.compensator_value,
  (
    coalesce(latest.required_value, line.delta_value) - line.delta_value
  )::numeric(14, 2) as revised_difference,
  (comp.compensator_count > 0) as has_compensator
from
  app.stock_count_lines line
  join app.stock_counts counted on counted.id = line.count_id
  left join lateral (
    select
      deriv.expected_qty,
      deriv.required_qty,
      deriv.required_value
    from
      app.stock_count_derivations deriv
    where
      deriv.count_id = line.count_id
      and deriv.line_no = line.line_no
    order by
      deriv.id desc
    limit
      1
  ) latest on true
  left join lateral (
    select
      coalesce(sum(sm.quantity), 0)::numeric(20, 6) as compensator_qty,
      coalesce(sum(sm.total_cost), 0)::numeric(14, 2) as compensator_value,
      count(sm.id)::integer as compensator_count
    from
      app.stock_count_postings posting
      join app.stock_movements sm on sm.id = posting.movement_id
    where
      posting.count_id = line.count_id
      and posting.line_no = line.line_no
      and sm.movement_type = 'count_compensation'
  ) comp on true;

comment on view app.stock_count_line_current is 'One row per count line. security_invoker. The original expected, delta, and value columns are the frozen observation. The latest columns are the newest derivation, or the original when no derivation exists. compensator_qty and compensator_value sum count_compensation rows only.';

revoke all on table app.stock_count_line_current
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_count_line_current to authenticated,
  service_role;
