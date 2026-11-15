-- Checkpoint resume, the closed-period cause, and the accounting queue.
--
-- The enum value closed_period was committed in
-- 20261108085000_closed_period_kind.sql. This file replaces the latest body
-- of each function it changes. The last statement makes
-- app.accounting_scaling_ready() return true.
--
-- Install lock order, held for this whole transaction: the ledger advisory
-- lock, then an exclusive lock on pos_sync_runs, then a share lock on
-- pos_shifts. The queue-stats lock is taken after that table exists and
-- before the producer functions are replaced.
-- The local migrator applies each statement on its own, so this file opens
-- the transaction that holds the install locks until the last statement.
begin;

select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

lock table app.pos_sync_runs in exclusive mode;

lock table app.pos_shifts in share mode;

-- ============================================================================
-- Closed-period columns. A cover pair is both null or both set. Quantity 0
-- is a value-only row. Other movement kinds keep the old shape.
-- ============================================================================
alter table app.stock_movements
add column closed_bucket text null,
add column closed_cause_id uuid null,
add column closed_economic_kind text null,
add column cover_inflow_movement_id bigint null references app.stock_movements (id) on delete restrict,
add column cover_deficit_movement_id bigint null references app.stock_movements (id) on delete restrict;

alter table app.stock_movements
drop constraint stock_movements_cost_adj_chk;

alter table app.stock_movements
add constraint stock_movements_cost_adj_chk check (
  (
    movement_type = 'cost_adjustment'::app.movement_type
    and quantity = 0
    and adjusts_movement_id is not null
    and closed_bucket is null
    and closed_cause_id is null
    and closed_economic_kind is null
    and cover_inflow_movement_id is null
    and cover_deficit_movement_id is null
  )
  or (
    movement_type = 'closed_period'::app.movement_type
    and adjusts_movement_id is null
    and reverses_movement_id is null
    and closed_bucket in (
      'inventory',
      'cogs',
      'waste',
      'count',
      'sort_transfer'
    )
    and closed_cause_id is not null
    and (
      (
        cover_inflow_movement_id is null
        and cover_deficit_movement_id is null
      )
      or (
        cover_inflow_movement_id is not null
        and cover_deficit_movement_id is not null
      )
    )
  )
  or (
    movement_type <> 'cost_adjustment'::app.movement_type
    and movement_type <> 'closed_period'::app.movement_type
    and quantity <> 0
    and adjusts_movement_id is null
    and closed_bucket is null
    and closed_cause_id is null
    and closed_economic_kind is null
    and cover_inflow_movement_id is null
    and cover_deficit_movement_id is null
  )
);

comment on column app.stock_movements.closed_bucket is 'Profit or transfer bucket of a closed_period row: inventory, cogs, waste, count, or sort_transfer. Null on every other movement kind.';

comment on column app.stock_movements.closed_cause_id is 'The one closed-period cause these rows belong to. Null on every other movement kind.';

comment on column app.stock_movements.closed_economic_kind is 'Economic kind used by the replay average rule for a closed receipt (purchase, opening, sort_in). The stored movement_type stays closed_period.';

comment on column app.stock_movements.cover_inflow_movement_id is 'With cover_deficit_movement_id, this closed_period row is the ledger carrier of one cover. The walker applies that value through the cover loop, not as a fixed closed row.';

create index stock_movements_item_id_idx on app.stock_movements (item_id, id);

create index stock_movements_cover_pair_idx on app.stock_movements (
  cover_inflow_movement_id,
  cover_deficit_movement_id
)
where
  cover_inflow_movement_id is not null;

alter table app.period_revisions
drop constraint period_revisions_bucket_check;

alter table app.period_revisions
add constraint period_revisions_bucket_check check (
  bucket in (
    'cogs',
    'waste',
    'count',
    'sort_transfer',
    'inventory'
  )
);

-- ============================================================================
-- Checkpoints. One usable cut per item. Invalidation is append-only.
-- Anchor identity is the count of anchors at or before the cut, plus the
-- anchors applied on this walk. A new anchor in the prefix changes the count,
-- so the cut is not resumed. Copying every historical anchor key on every
-- publish would walk the prefix the checkpoint exists to avoid.
-- ============================================================================
create table app.replay_checkpoints (
  id bigint generated always as identity primary key,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  cut_occurred_at timestamptz not null,
  max_movement_id bigint not null references app.stock_movements (id) on delete restrict,
  on_hand_qty numeric(20, 6) not null,
  on_hand_value numeric(14, 2) not null,
  avg_cost numeric(20, 6) not null,
  cost_known boolean not null,
  has_uncovered_deficit boolean not null,
  anchor_count bigint not null,
  digest text not null,
  published_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint replay_checkpoints_finite_chk check (
    pg_catalog.isfinite (cut_occurred_at)
    and on_hand_qty <> 'NaN'::numeric
    and on_hand_value <> 'NaN'::numeric
    and avg_cost <> 'NaN'::numeric
    and avg_cost >= 0
  )
);

comment on table app.replay_checkpoints is 'A resume point for one item. The prefix is every live movement at or before cut_occurred_at with id at most max_movement_id, and every anchor counted at or before the cut. Usable only while no invalidation row exists.';

create index replay_checkpoints_item_cut_idx on app.replay_checkpoints (item_id, cut_occurred_at desc, id desc);

create table app.replay_checkpoint_deficits (
  checkpoint_id bigint not null references app.replay_checkpoints (id) on delete restrict,
  movement_id bigint not null references app.stock_movements (id) on delete restrict,
  item_id uuid not null,
  qty_uncovered numeric(20, 6) not null,
  value_uncovered numeric(14, 2) not null,
  provisional_unit_cost numeric(20, 6) not null,
  occurred_at timestamptz not null,
  ord_class integer not null,
  event_position bigint not null,
  piece_position integer not null,
  primary key (checkpoint_id, movement_id)
);

comment on table app.replay_checkpoint_deficits is 'Open deficits at the cut, including a closed deficit that a later inflow has not covered yet. A resume restores these rows before the walk.';

create index replay_checkpoint_deficits_item_idx on app.replay_checkpoint_deficits (item_id, checkpoint_id);

create table app.replay_checkpoint_anchors (
  checkpoint_id bigint not null references app.replay_checkpoints (id) on delete restrict,
  count_id uuid not null,
  line_no integer not null,
  primary key (checkpoint_id, count_id, line_no)
);

comment on table app.replay_checkpoint_anchors is 'Anchors applied on the walk that published the cut. The prefix set is checked by anchor_count, not by copying every older key.';

create table app.replay_checkpoint_invalidations (
  checkpoint_id bigint primary key references app.replay_checkpoints (id) on delete restrict,
  reason text not null,
  invalidated_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.replay_checkpoint_invalidations is 'Append-only. A checkpoint with a row here is not a resume point. Publishing a later cut the same Cairo day supersedes the earlier one. A closed cause invalidates cuts at or after the change. An in-window cost adjustment invalidates cuts at or after the deficit.';

create trigger trg_replay_checkpoint_invalidations_no_update
before update or delete on app.replay_checkpoint_invalidations for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_replay_checkpoint_invalidations_no_truncate
before truncate on app.replay_checkpoint_invalidations for each statement
execute function app.prevent_append_only_mutation ();

-- Written only while app.replay_probe is 1. Production replays do not explain themselves.
create table app.replay_read_probe (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default pg_catalog.clock_timestamp (),
  time_arm_rows bigint not null,
  id_arm_rows bigint not null,
  deficit_rows bigint not null,
  time_arm_plan text not null,
  id_arm_plan text not null,
  deficit_plan text not null,
  time_arm_index boolean not null,
  id_arm_index boolean not null,
  deficit_index boolean not null,
  prefix_rows bigint not null default 0,
  deficit_buffers bigint not null default 0,
  replay_ms numeric(14, 3) not null default 0
);

comment on table app.replay_read_probe is 'One confirming replay. Suffix plans are EXPLAIN text. The deficit plan and buffers are the restore insert that just ran. prefix_rows is the frozen prefix loaded into the walk, which stays zero.';

alter table app.replay_read_probe enable row level security;

revoke all on app.replay_read_probe
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- Closed-period sources and the contribution already posted for a source.
-- ============================================================================
create table app.closed_period_sources (
  movement_id bigint primary key references app.stock_movements (id) on delete restrict,
  closed_cause_id uuid not null,
  source_kind text not null,
  source_id text not null,
  waste_chain_id uuid null,
  reason_code text null,
  report_class text null
);

comment on table app.closed_period_sources is 'Where a closed_period row came from. Waste rows are not inserted into waste_line_movements. waste_chain_id is the predecessor root so two corrections of one document stay together.';

create index closed_period_sources_cause_idx on app.closed_period_sources (closed_cause_id);

create table app.recognized_contribution (
  source_kind text not null,
  source_id text not null,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  bucket text not null,
  quantity numeric(20, 6) not null default 0,
  amount numeric(14, 2) not null,
  primary key (source_kind, source_id, item_id, bucket),
  constraint recognized_contribution_finite_chk check (
    quantity <> 'NaN'::numeric
    and amount <> 'NaN'::numeric
  )
);

comment on table app.recognized_contribution is 'Quantity and value already posted for one source, item, and bucket. The next posting of that source writes required minus this contribution.';

-- ============================================================================
-- Queue. One row per order. eligible_count is maintained per order, not by
-- scanning every open event.
-- ============================================================================
create table app.accounting_queue_stats (
  id smallint primary key default 1 check (id = 1),
  eligible_count bigint not null check (eligible_count >= 0)
);

comment on table app.accounting_queue_stats is 'Singleton. eligible_count is the number of orders the worker may claim. It changes when one order becomes eligible or stops being eligible.';

insert into
  app.accounting_queue_stats (id, eligible_count)
values
  (1, 0);

create table app.accounting_work_queue (
  order_id text primary key,
  occurrence_at timestamptz null,
  has_new boolean not null,
  eff_generation integer not null,
  eligible boolean not null
);

comment on table app.accounting_work_queue is 'One row per order that has unprocessed work. occurrence_at is the least of the latest input time and the owner application time. The worker reads this table, not a scan of every event.';

create index accounting_work_queue_eligible_idx on app.accounting_work_queue (occurrence_at, order_id)
where
  eligible;

-- ============================================================================
-- Activation history. The bound is the set of inputs that existed when
-- activation was inserted. The loaded marker is written once that bound
-- exists and every frozen input has a durable posting proof. An empty bound
-- completes immediately. A bound row that was never inserted does not.
-- ============================================================================
create table app.activation_history_bound (
  id smallint primary key default 1 check (id = 1),
  bound_at timestamptz not null,
  stock_started_at timestamptz not null
);

comment on table app.activation_history_bound is 'The instant activation was inserted and the stock start it fixed. Written by the activation insert trigger.';

create table app.activation_history_input (
  order_id text primary key,
  bound_at timestamptz not null,
  cost_input_id bigint not null references app.pos_cost_inputs (id) on delete restrict,
  ordered_at timestamptz not null
);

comment on table app.activation_history_input is 'The latest cost input of each order whose work event existed at the activation bound. The worker posts that input, not a newer one, until the loaded marker exists.';

create table app.activation_history_loaded (
  id smallint primary key default 1 check (id = 1),
  loaded_at timestamptz not null
);

comment on table app.activation_history_loaded is 'Written once the activation bound exists and every frozen input has a posting proof. An empty bound sets it. After it exists, a newly discovered order before the window is a closed cause.';

create table app.activation_history_posted (
  order_id text primary key,
  cost_input_id bigint not null,
  application_id bigint not null,
  posted_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.activation_history_posted is 'Durable proof that a frozen input was posted. The current owner can move to a later edit; this row stays, and that edit is no longer held back.';

alter table app.activation_history_posted enable row level security;

revoke all on app.activation_history_posted
from
  public,
  anon,
  authenticated,
  service_role;

create table app.closed_span_orders (
  span_id bigint not null references app.accounting_rederive_spans (id) on delete restrict,
  order_id text not null,
  ordered_at timestamptz not null,
  cause_id uuid null,
  primary key (span_id, order_id)
);

comment on table app.closed_span_orders is 'Orders of one configuration span that fall before the restatement window. They share one closed cause, posted when the cursor reaches the window. In-window orders are not stored here.';

create table app.accounting_attempt_progress (
  attempt_id uuid primary key,
  status text not null,
  recorded_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.accounting_attempt_progress is 'A slice of one worker attempt. A failure report treats a row here the same as a completion: the call committed and the reply was lost.';

create table app.accounting_accrual_versions (
  id bigint generated always as identity primary key,
  span_id bigint null,
  change_id bigint null,
  window_start timestamptz not null,
  cost_input_id bigint null,
  disposition_event_id bigint null,
  source_kind text not null,
  source_id text not null,
  item_id uuid not null,
  recognized_qty numeric(20, 6) not null,
  recognized_value numeric(14, 2) not null,
  voided_at timestamptz null
);

comment on table app.accounting_accrual_versions is 'One stored accrual for a closed span. A later publish posts the delta from the recognized contribution. A mismatch voids the row instead of posting a second copy.';

-- ============================================================================
-- Scratch used by one replay. Truncated with the other replay tables.
-- ============================================================================
create table ledger_scratch.replay_resume (
  item_id uuid primary key,
  checkpoint_id bigint null,
  cut_occurred_at timestamptz null,
  max_movement_id bigint null,
  on_hand_qty numeric(20, 6) not null default 0,
  on_hand_value numeric(14, 2) not null default 0,
  avg_cost numeric(20, 6) not null default 0,
  cost_known boolean not null default false,
  has_uncovered_deficit boolean not null default false,
  digest text null
);

create table ledger_scratch.recompute_cover_pair (
  inflow_movement_id bigint not null,
  deficit_movement_id bigint not null,
  covered_qty numeric(20, 6) not null,
  value_adj numeric(14, 2) not null,
  primary key (inflow_movement_id, deficit_movement_id)
);

comment on table ledger_scratch.recompute_cover_pair is 'Cover of a deficit that occurred before the window, recorded by the ordinary cover loop. The write phase posts the delta as one closed_period carrier row.';

-- The restore insert's own plan, kept until the probe row is written.
create table ledger_scratch.replay_restore_plan (
  checkpoint_id bigint primary key,
  plan text not null,
  buffers bigint not null
);

alter table ledger_scratch.replay_resume enable row level security;

alter table ledger_scratch.recompute_cover_pair enable row level security;

alter table ledger_scratch.replay_restore_plan enable row level security;

revoke all on ledger_scratch.replay_resume,
ledger_scratch.recompute_cover_pair,
ledger_scratch.replay_restore_plan
from
  public,
  anon,
  authenticated,
  service_role;

alter table app.replay_checkpoints enable row level security;

alter table app.replay_checkpoint_deficits enable row level security;

alter table app.replay_checkpoint_anchors enable row level security;

alter table app.replay_checkpoint_invalidations enable row level security;

alter table app.closed_period_sources enable row level security;

alter table app.recognized_contribution enable row level security;

alter table app.accounting_queue_stats enable row level security;

alter table app.accounting_work_queue enable row level security;

alter table app.activation_history_bound enable row level security;

alter table app.activation_history_input enable row level security;

alter table app.activation_history_loaded enable row level security;

alter table app.closed_span_orders enable row level security;

alter table app.accounting_attempt_progress enable row level security;

alter table app.accounting_accrual_versions enable row level security;

revoke all on app.replay_checkpoints,
app.replay_checkpoint_deficits,
app.replay_checkpoint_anchors,
app.replay_checkpoint_invalidations,
app.closed_period_sources,
app.recognized_contribution,
app.accounting_queue_stats,
app.accounting_work_queue,
app.activation_history_bound,
app.activation_history_input,
app.activation_history_loaded,
app.closed_span_orders,
app.accounting_attempt_progress,
app.accounting_accrual_versions
from
  public,
  anon,
  authenticated,
  service_role;

lock table app.accounting_queue_stats in exclusive mode;

-- ============================================================================
-- Window, change instant, and the owner lock helper.
-- ============================================================================
-- app.test_clock is a transaction-local pin. A production owner or superuser
-- session can set it: the pin is privileged, not test-only by construction.
-- test_clock_pin returns it only for that session user. No application role
-- (anon, authenticated, service_role) can execute the reader, and a value
-- they set is ignored because their session user is authenticator. No other
-- function reads the pin directly.
create function app.test_clock_pin () returns timestamptz language sql stable security invoker
set
  search_path = '' as $$
  select
    case
      when coalesce(pg_catalog.current_setting('app.test_clock', true), '') = '' then null::timestamptz
      when exists (
        select
          1
        from
          pg_catalog.pg_roles role
          join pg_catalog.pg_database db on db.datdba = role.oid
        where
          db.datname = pg_catalog.current_database ()
          and role.rolname = session_user::text
      )
      or exists (
        select
          1
        from
          pg_catalog.pg_roles role
        where
          role.rolname = session_user::text
          and role.rolsuper
      ) then pg_catalog.current_setting('app.test_clock', true)::timestamptz
      else null::timestamptz
    end;
$$;

comment on function app.test_clock_pin () is 'The app.test_clock pin when the connected session user owns this database or is a superuser. A production owner session can set the pin; it is privileged, not test-only by construction. No application role can execute this reader, and a value they set is ignored.';

revoke all on function app.test_clock_pin ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.restatement_window_start (p_at timestamptz default null) returns timestamptz language sql stable security definer
set
  search_path = '' as $$
  select
    (
      (
        (
          coalesce(
            p_at,
            case
              when coalesce(
                pg_catalog.current_setting('app.t_change_chosen', true),
                ''
              ) = '1'
              and coalesce(
                pg_catalog.current_setting('app.t_change', true),
                ''
              ) <> '' then pg_catalog.current_setting('app.t_change', true)::timestamptz
              else coalesce(
                app.test_clock_pin (),
                pg_catalog.clock_timestamp()
              )
            end
          ) at time zone 'Africa/Cairo'
        )::date - 34
      )::timestamp
    ) at time zone 'Africa/Cairo';
$$;

comment on function app.restatement_window_start (timestamptz) is 'Cairo midnight 34 days before the Cairo date of p_at. The window is that instant through the current Cairo date, inclusive. An effect at this instant is inside the window.';

revoke all on function app.restatement_window_start (timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.note_change_instant () returns timestamptz language plpgsql security definer
set
  search_path = '' as $$
declare
  v_at timestamptz;
begin
  if coalesce(pg_catalog.current_setting('app.t_change_chosen', true), '') = '1'
  and coalesce(pg_catalog.current_setting('app.t_change', true), '') <> '' then
    return pg_catalog.current_setting('app.t_change', true)::timestamptz;
  end if;

  -- A pin set by an API role is not a chosen instant. Only the database
  -- owner (the test session) can move the window, via app.test_clock.
  v_at := coalesce(app.test_clock_pin (), pg_catalog.clock_timestamp());

  perform pg_catalog.set_config('app.t_change', v_at::text, true);

  perform pg_catalog.set_config('app.t_change_chosen', '1', true);

  perform pg_catalog.set_config(
    'app.restatement_window_start',
    app.restatement_window_start (v_at)::text,
    true
  );

  return v_at;
end;
$$;

comment on function app.note_change_instant () is 'The change instant of this transaction, taken once. A later call returns the same value. The window is computed from it.';

revoke all on function app.note_change_instant ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.lock_owner_sync_shares () returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  -- The caller already holds the ledger advisory lock. These two share locks
  -- order the owner write against an in-flight sync. The session lock timeout
  -- is the bound. A timeout is the existing busy error, not a new refusal.
  begin
    lock table app.pos_sync_runs in share mode;

    lock table app.pos_shifts in share mode;
  exception
    when lock_not_available then
      raise exception 'busy'
        using errcode = '55P03';
  end;
end;
$$;

comment on function app.lock_owner_sync_shares () is 'Share-lock pos_sync_runs, then pos_shifts. Caller holds the ledger lock. A lock timeout raises 55P03 busy.';

revoke all on function app.lock_owner_sync_shares ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.closed_containing_shift (p_at timestamptz) returns text language sql stable security definer
set
  search_path = '' as $$
  select
    shift.id
  from
    app.pos_shifts shift
  where
    shift.opened_at <= p_at
    and (
      shift.closed_at is null
      or p_at < shift.closed_at
    )
  order by
    shift.opened_at desc
  limit
    1;
$$;

comment on function app.closed_containing_shift (timestamptz) is 'The shift whose span contains the instant, or null. Does not fall back to the last closed shift.';

revoke all on function app.closed_containing_shift (timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.invalidate_checkpoints_from (p_item_id uuid, p_at timestamptz, p_reason text) returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  insert into
    app.replay_checkpoint_invalidations (checkpoint_id, reason)
  select
    checkpoint.id,
    p_reason
  from
    app.replay_checkpoints checkpoint
  where
    checkpoint.item_id = p_item_id
    and checkpoint.cut_occurred_at >= p_at
    and not exists (
      select
        1
      from
        app.replay_checkpoint_invalidations invalidation
      where
        invalidation.checkpoint_id = checkpoint.id
    );
end;
$$;

comment on function app.invalidate_checkpoints_from (uuid, timestamptz, text) is 'Append an invalidation for every usable checkpoint of the item at or after the instant. A cut strictly before the instant stays valid.';

revoke all on function app.invalidate_checkpoints_from (uuid, timestamptz, text)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- Queue maintenance. The trigger is the safety net. Enqueue is the insert path.
-- ============================================================================
create function app.refresh_accounting_queue (p_order_id text) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_has_new boolean;
  v_eff integer;
  v_failed timestamptz;
  v_occurrence timestamptz;
  v_eligible boolean;
  v_was boolean;
begin
  if p_order_id is null then
    return;
  end if;

  perform 1
  from
    app.accounting_queue_stats stats
  where
    stats.id = 1
  for update;

  select
    pg_catalog.bool_or(event.work_generation is null),
    coalesce(max(state.work_generation), 0) + case
      when pg_catalog.bool_or(event.work_generation is null) then 1
      else 0
    end,
    max(state.failed_at)
  into
    v_has_new,
    v_eff,
    v_failed
  from
    app.accounting_work_events event
    left join app.accounting_work_state state on state.order_id = event.order_id
  where
    event.order_id = p_order_id
    and event.processed_at is null;

  v_eligible := v_has_new is not null
  and (
    v_failed is null
    or v_has_new
  );

  select
    queue.eligible
  into v_was
  from
    app.accounting_work_queue queue
  where
    queue.order_id = p_order_id
  for update;

  if not v_eligible then
    delete from app.accounting_work_queue queue
    where
      queue.order_id = p_order_id;

    if coalesce(v_was, false) then
      update app.accounting_queue_stats stats
      set
        eligible_count = stats.eligible_count - 1
      where
        stats.id = 1;
    end if;

    return;
  end if;

  select
    least(latest.ordered_at, owner_row.occurred_at)
  into v_occurrence
  from
    (
      select
        1
    ) as seed
    left join lateral (
      select
        snap.ordered_at
      from
        app.pos_cost_inputs input
        join app.pos_order_snapshots snap on snap.id = input.snapshot_id
      where
        input.order_id = p_order_id
      order by
        input.input_revision desc
      limit
        1
    ) as latest on true
    left join lateral (
      select
        application.occurred_at
      from
        app.order_cost_state head
        join app.order_cost_applications application on application.id = head.owner_application_id
      where
        head.order_id = p_order_id
    ) as owner_row on true;

  insert into
    app.accounting_work_queue (
      order_id,
      occurrence_at,
      has_new,
      eff_generation,
      eligible
    )
  values
    (
      p_order_id,
      v_occurrence,
      v_has_new,
      coalesce(v_eff, 1),
      true
    )
  on conflict (order_id) do update
  set
    occurrence_at = excluded.occurrence_at,
    has_new = excluded.has_new,
    eff_generation = excluded.eff_generation,
    eligible = true;

  if v_was is null then
    update app.accounting_queue_stats stats
    set
      eligible_count = stats.eligible_count + 1
    where
      stats.id = 1;
  end if;
end;
$$;

comment on function app.refresh_accounting_queue (text) is 'Recompute one order''s queue row and adjust eligible_count by one. Locks the stats row, then the queue row.';

revoke all on function app.refresh_accounting_queue (text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.enqueue_accounting_event (
  p_order_id text,
  p_cause text,
  p_source_key text,
  p_cost_input_id bigint,
  p_span_id bigint
) returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  insert into
    app.accounting_work_events (
      order_id,
      cause,
      source_key,
      cost_input_id,
      span_id
    )
  values
    (
      p_order_id,
      p_cause,
      p_source_key,
      p_cost_input_id,
      p_span_id
    )
  on conflict (source_key) do nothing;
end;
$$;

comment on function app.enqueue_accounting_event (text, text, text, bigint, bigint) is 'The insert path for a work event. A duplicate source_key does nothing. The queue refreshes from the event trigger.';

revoke all on function app.enqueue_accounting_event (text, text, text, bigint, bigint)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.trg_refresh_accounting_queue () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  perform app.refresh_accounting_queue (coalesce(new.order_id, old.order_id));

  return null;
end;
$$;

comment on function app.trg_refresh_accounting_queue () is 'Keeps the queue row aligned with work events and work state. Does not insert events.';

revoke all on function app.trg_refresh_accounting_queue ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_accounting_work_events_queue
after insert or update of processed_at,
work_generation on app.accounting_work_events for each row
execute function app.trg_refresh_accounting_queue ();

create trigger trg_accounting_work_state_queue
after insert or update of failed_at,
work_generation on app.accounting_work_state for each row
execute function app.trg_refresh_accounting_queue ();

create function app.rebuild_accounting_queue () returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_order text;
begin
  perform 1
  from
    app.accounting_queue_stats stats
  where
    stats.id = 1
  for update;

  delete from app.accounting_work_queue;

  update app.accounting_queue_stats stats
  set
    eligible_count = 0
  where
    stats.id = 1;

  for v_order in
    select distinct
      event.order_id
    from
      app.accounting_work_events event
    where
      event.processed_at is null
    order by
      event.order_id
  loop
    perform app.refresh_accounting_queue (v_order);
  end loop;
end;
$$;

comment on function app.rebuild_accounting_queue () is 'Rebuild the queue from unprocessed events. Used once, after the producers are replaced, while the install locks are held.';

revoke all on function app.rebuild_accounting_queue ()
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- Replay resume, publish, and the closed-period walker branch.
-- ============================================================================
create function app.replay_note_window () returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_at timestamptz;
begin
  if coalesce(
    pg_catalog.current_setting('app.restatement_window_start', true),
    ''
  ) <> '' then
    return;
  end if;

  if coalesce(pg_catalog.current_setting('app.t_change_chosen', true), '') = '1'
  and coalesce(pg_catalog.current_setting('app.t_change', true), '') <> '' then
    v_at := pg_catalog.current_setting('app.t_change', true)::timestamptz;
  else
    v_at := coalesce(app.test_clock_pin (), pg_catalog.clock_timestamp());
  end if;

  perform pg_catalog.set_config(
    'app.restatement_window_start',
    app.restatement_window_start (v_at)::text,
    true
  );
end;
$$;

comment on function app.replay_note_window () is 'Makes the window visible to the cover loop for this transaction. Does not move an instant that was already chosen.';

revoke all on function app.replay_note_window ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_cap_waived (p_item_ids uuid[]) returns boolean language plpgsql stable security definer
set
  search_path = '' as $$
begin
  if coalesce(pg_catalog.current_setting('app.replay_frozen', true), '') <> '1' then
    return false;
  end if;

  return not exists (
    select
      1
    from
      ledger_scratch.replay_resume resume
    where
      resume.item_id = any (p_item_ids)
      and resume.checkpoint_id is not null
  );
end;
$$;

comment on function app.replay_cap_waived (uuid[]) is 'True only while a frozen historical input is walked and no usable checkpoint is strictly before that order. A missing checkpoint then does not raise recompute_limit.';

revoke all on function app.replay_cap_waived (uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_bind_resume (p_item_ids uuid[], p_pending jsonb) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_item uuid;
  v_pending_min timestamptz;
  v_order_at timestamptz;
  v_frozen boolean;
  v_checkpoint record;
  v_suffix_min timestamptz;
  v_anchor_count bigint;
  v_use boolean;
  v_plan text;
  v_line text;
begin
  v_frozen := coalesce(pg_catalog.current_setting('app.replay_frozen', true), '') = '1';

  if v_frozen
  and coalesce(pg_catalog.current_setting('app.replay_order_at', true), '') <> '' then
    v_order_at := pg_catalog.current_setting('app.replay_order_at', true)::timestamptz;
  end if;

  select
    min((elem.value ->> 'occurred_at')::timestamptz)
  into v_pending_min
  from
    pg_catalog.jsonb_array_elements(coalesce(p_pending, '[]'::jsonb)) as elem (value);

  for v_item in
    select distinct
      t.item_id
    from
      pg_catalog.unnest(p_item_ids) as t (item_id)
    where
      t.item_id is not null
    order by
      t.item_id
  loop
    v_use := false;
    v_checkpoint := null;

    for v_checkpoint in
      select
        checkpoint.*
      from
        app.replay_checkpoints checkpoint
      where
        checkpoint.item_id = v_item
        and not exists (
          select
            1
          from
            app.replay_checkpoint_invalidations invalidation
          where
            invalidation.checkpoint_id = checkpoint.id
        )
      order by
        checkpoint.cut_occurred_at desc,
        checkpoint.id desc
    loop
      if v_pending_min is not null
      and v_checkpoint.cut_occurred_at >= v_pending_min then
        continue;
      end if;

      if v_frozen
      and v_order_at is not null
      and v_checkpoint.cut_occurred_at >= v_order_at then
        continue;
      end if;

      select
        count(*)
      into v_anchor_count
      from
        app.stock_count_anchors anchor
      where
        anchor.item_id = v_item
        and anchor.counted_at <= v_checkpoint.cut_occurred_at;

      if v_anchor_count is distinct from v_checkpoint.anchor_count then
        continue;
      end if;

      select
        least(move_min.at, id_min.at, anchor_min.at)
      into v_suffix_min
      from
        (
          select
            min(sm.occurred_at) as at
          from
            app.stock_movements sm
          where
            sm.item_id = v_item
            and sm.occurred_at > v_checkpoint.cut_occurred_at
            and sm.movement_type <> 'cost_adjustment'::app.movement_type
        ) as move_min,
        (
          select
            min(sm.occurred_at) as at
          from
            app.stock_movements sm
          where
            sm.item_id = v_item
            and sm.id > v_checkpoint.max_movement_id
            and sm.movement_type <> 'cost_adjustment'::app.movement_type
        ) as id_min,
        (
          select
            min(anchor.counted_at) as at
          from
            app.stock_count_anchors anchor
          where
            anchor.item_id = v_item
            and anchor.counted_at > v_checkpoint.cut_occurred_at
        ) as anchor_min;

      if v_suffix_min is null
      or v_suffix_min > v_checkpoint.cut_occurred_at then
        v_use := true;
        exit;
      end if;
    end loop;

    if v_use then
      insert into
        ledger_scratch.replay_resume (
          item_id,
          checkpoint_id,
          cut_occurred_at,
          max_movement_id,
          on_hand_qty,
          on_hand_value,
          avg_cost,
          cost_known,
          has_uncovered_deficit,
          digest
        )
      values
        (
          v_item,
          v_checkpoint.id,
          v_checkpoint.cut_occurred_at,
          v_checkpoint.max_movement_id,
          v_checkpoint.on_hand_qty,
          v_checkpoint.on_hand_value,
          v_checkpoint.avg_cost,
          v_checkpoint.cost_known,
          v_checkpoint.has_uncovered_deficit,
          v_checkpoint.digest
        );

      -- The probe records this insert, not a later EXPLAIN of a different
      -- query. ANALYZE runs the insert once and returns its plan and buffers.
      if coalesce(pg_catalog.current_setting('app.replay_probe', true), '') = '1' then
        v_plan := '';

        for v_line in execute format(
          $explain$
          explain (analyze, buffers, format text)
          insert into ledger_scratch.recompute_def (
            movement_id,
            item_id,
            qty_uncovered,
            provisional_unit_cost,
            value_uncovered,
            occurred_at,
            ord_class,
            event_position,
            piece_position
          )
          select
            deficit.movement_id,
            deficit.item_id,
            deficit.qty_uncovered,
            deficit.provisional_unit_cost,
            deficit.value_uncovered,
            deficit.occurred_at,
            deficit.ord_class,
            deficit.event_position,
            deficit.piece_position
          from app.replay_checkpoint_deficits deficit
          where deficit.checkpoint_id = %s
          $explain$,
          v_checkpoint.id
        )
        loop
          v_plan := v_plan || v_line || e'\n';
        end loop;

        insert into
          ledger_scratch.replay_restore_plan (checkpoint_id, plan, buffers)
        values
          (
            v_checkpoint.id,
            v_plan,
            app.replay_plan_shared_buffers (v_plan)
          )
        on conflict (checkpoint_id) do update
        set
          plan = excluded.plan,
          buffers = excluded.buffers;
      else
        insert into
          ledger_scratch.recompute_def (
            movement_id,
            item_id,
            qty_uncovered,
            provisional_unit_cost,
            value_uncovered,
            occurred_at,
            ord_class,
            event_position,
            piece_position
          )
        select
          deficit.movement_id,
          deficit.item_id,
          deficit.qty_uncovered,
          deficit.provisional_unit_cost,
          deficit.value_uncovered,
          deficit.occurred_at,
          deficit.ord_class,
          deficit.event_position,
          deficit.piece_position
        from
          app.replay_checkpoint_deficits deficit
        where
          deficit.checkpoint_id = v_checkpoint.id;
      end if;
    else
      insert into
        ledger_scratch.replay_resume (item_id)
      values
        (v_item);
    end if;
  end loop;

  -- A sort output can resume while its input cannot: the new purchase is on
  -- the input, before the sort, so the output's own suffix is empty. Walking
  -- only the input reprices the sort and leaves the output at the old value.
  -- If any item in this call has to walk from the start, they all do.
  if exists (
    select
      1
    from
      ledger_scratch.replay_resume resume
    where
      resume.checkpoint_id is null
  ) then
    delete from ledger_scratch.recompute_def deficit
    where
      deficit.item_id in (
        select
          resume.item_id
        from
          ledger_scratch.replay_resume resume
      );

    delete from ledger_scratch.replay_restore_plan stored
    where
      stored.checkpoint_id in (
        select
          resume.checkpoint_id
        from
          ledger_scratch.replay_resume resume
        where
          resume.checkpoint_id is not null
      );

    update ledger_scratch.replay_resume
    set
      checkpoint_id = null,
      cut_occurred_at = null,
      max_movement_id = null,
      on_hand_qty = 0,
      on_hand_value = 0,
      avg_cost = 0,
      cost_known = false,
      has_uncovered_deficit = false,
      digest = null
    where
      checkpoint_id is not null;
  end if;
end;
$$;

comment on function app.replay_bind_resume (uuid[], jsonb) is 'Choose one usable checkpoint per item whose cut is strictly before the earliest effect, and restore its balance and open deficits. A checkpoint that fails the anchor count or the suffix test is skipped. If one item in the call cannot resume, none of them do, so a sort is repriced on both sides.';

revoke all on function app.replay_bind_resume (uuid[], jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_apply_closed_period (
  p_movement_id bigint,
  p_item_id uuid,
  p_occurred_at timestamptz,
  p_quantity numeric,
  p_unit_cost numeric,
  p_total_cost numeric,
  p_is_pending boolean,
  p_line_key integer,
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_qty numeric(20, 6);
  v_value numeric(14, 2);
  v_avg numeric(20, 6);
  v_out numeric(20, 6);
  v_normal_qty numeric(20, 6);
  v_prov_qty numeric(20, 6);
  v_normal_cost numeric(14, 2);
  v_prov_cost numeric(14, 2);
  v_prov_unit numeric(20, 6);
  v_ord integer;
  v_event bigint;
  v_piece integer;
begin
  if exists (
    select
      1
    from
      app.stock_movements sm
    where
      sm.id = p_movement_id
      and sm.cover_inflow_movement_id is not null
  ) then
    return;
  end if;

  if p_quantity > 0 then
    perform app.replay_inflow (
      p_movement_id,
      p_item_id,
      'closed_period'::app.movement_type,
      p_occurred_at,
      p_quantity,
      p_unit_cost,
      p_total_cost,
      p_is_pending,
      p_line_key,
      p_shift_id,
      p_source_type,
      p_source_id,
      p_note
    );
  elsif p_quantity < 0 then
    -- A stored total has to stay the effect base. The ordinary forced-total
    -- path would consume the whole quantity and skip the deficit.
    if p_is_pending then
      perform app.replay_outflow (
        p_movement_id,
        p_item_id,
        'closed_period'::app.movement_type,
        p_occurred_at,
        -p_quantity,
        null,
        p_is_pending,
        p_line_key,
        p_shift_id,
        p_source_type,
        p_source_id,
        p_note
      );
    else
      select
        b.on_hand_qty
      into v_qty
      from
        ledger_scratch.recompute_bal b
      where
        b.item_id = p_item_id;

      v_qty := coalesce(v_qty, 0);
      v_out := -p_quantity;
      v_normal_qty := least(v_out, greatest(v_qty, 0::numeric));
      v_prov_qty := v_out - v_normal_qty;

      if v_prov_qty > 0
      and v_out > 0 then
        v_prov_cost := pg_catalog.round(p_total_cost * v_prov_qty / v_out, 2);
      else
        v_prov_cost := 0;
      end if;

      v_normal_cost := p_total_cost - v_prov_cost;
      v_prov_cost := app.assert_recompute_range (v_prov_cost, 2, true);
      v_normal_cost := app.assert_recompute_range (v_normal_cost, 2, true);

      select
        coalesce(q.ord_class, 0),
        q.event_position,
        coalesce(q.piece_position, 0)
      into
        v_ord,
        v_event,
        v_piece
      from
        ledger_scratch.recompute_row q
      where
        q.movement_id = p_movement_id;

      v_ord := coalesce(v_ord, 0);
      v_event := coalesce(v_event, p_movement_id);
      v_piece := coalesce(v_piece, 0);

      insert into
        ledger_scratch.recompute_effect (
          movement_id,
          item_id,
          movement_type,
          base_total,
          unit_cost,
          cover_total
        )
      values
        (
          p_movement_id,
          p_item_id,
          'closed_period'::app.movement_type,
          v_normal_cost + v_prov_cost,
          case
            when p_quantity = 0 then 0
            else app.assert_recompute_range (abs(pg_catalog.round(p_total_cost / p_quantity, 6)), 6, false)
          end,
          0
        );

      if v_prov_qty > 0 then
        v_prov_unit := app.assert_recompute_range (abs(v_prov_cost) / v_prov_qty, 6, false);

        insert into
          ledger_scratch.recompute_def (
            movement_id,
            item_id,
            qty_uncovered,
            provisional_unit_cost,
            value_uncovered,
            occurred_at,
            ord_class,
            event_position,
            piece_position
          )
        values
          (
            p_movement_id,
            p_item_id,
            v_prov_qty,
            v_prov_unit,
            abs(v_prov_cost),
            p_occurred_at,
            v_ord,
            v_event,
            v_piece
          );
      end if;

      update ledger_scratch.recompute_bal
      set
        on_hand_qty = on_hand_qty - v_out,
        on_hand_value = app.assert_recompute_range (on_hand_value + p_total_cost, 2, true)
      where
        item_id = p_item_id;

      perform app.replay_touch_deficit_flag (p_item_id);
    end if;
  else
    update ledger_scratch.recompute_bal balance
    set
      on_hand_value = app.assert_recompute_range (balance.on_hand_value + p_total_cost, 2, true),
      avg_cost = case
        when balance.on_hand_qty > 0 then app.assert_recompute_range (
          pg_catalog.round(
            (balance.on_hand_value + p_total_cost) / balance.on_hand_qty,
            6
          ),
          6,
          false
        )
        else balance.avg_cost
      end
    where
      balance.item_id = p_item_id
    returning
      balance.on_hand_qty,
      balance.on_hand_value,
      balance.avg_cost
    into
      v_qty,
      v_value,
      v_avg;

    if v_qty > 0
    and v_value < 0 then
      perform app.raise_recompute_failure ('critical');
    end if;

    if v_avg < 0 then
      perform app.raise_recompute_failure ('critical');
    end if;
  end if;
end;
$$;

comment on function app.replay_apply_closed_period (
  bigint,
  uuid,
  timestamptz,
  numeric,
  numeric,
  numeric,
  boolean,
  integer,
  text,
  text,
  text,
  text
) is 'Apply one closed_period row. A cover-pair carrier is skipped because the cover loop already added its value. A positive quantity uses the economic kind. A negative quantity keeps the stored total as the effect base and still opens a deficit for the uncovered quantity. A zero quantity adds the value only.';

revoke all on function app.replay_apply_closed_period (
  bigint,
  uuid,
  timestamptz,
  numeric,
  numeric,
  numeric,
  boolean,
  integer,
  text,
  text,
  text,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_write_cover_pairs (p_cause uuid) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_pair record;
  v_inflow record;
  v_deficit record;
  v_posted numeric(14, 2);
  v_delta numeric(14, 2);
  v_shift text;
  v_bucket text;
  v_cause uuid;
begin
  v_cause := coalesce(p_cause, pg_catalog.gen_random_uuid ());

  -- A pair this walk no longer requires posts its negation. P0 inserted
  -- before P1 leaves the old P1 cover at zero and posts the new cover at P0.
  insert into
    ledger_scratch.recompute_cover_pair (
      inflow_movement_id,
      deficit_movement_id,
      covered_qty,
      value_adj
    )
  select
    posted.cover_inflow_movement_id,
    posted.cover_deficit_movement_id,
    0,
    0
  from
    (
      select distinct
        sm.cover_inflow_movement_id,
        sm.cover_deficit_movement_id
      from
        app.stock_movements sm
      where
        sm.movement_type = 'closed_period'::app.movement_type
        and sm.cover_inflow_movement_id is not null
        and exists (
          select
            1
          from
            ledger_scratch.recompute_row walked
          where
            walked.movement_id = sm.cover_inflow_movement_id
            and not walked.is_pending
        )
    ) as posted
  on conflict (inflow_movement_id, deficit_movement_id) do nothing;

  for v_pair in
    select
      pair.inflow_movement_id,
      pair.deficit_movement_id,
      pair.value_adj
    from
      ledger_scratch.recompute_cover_pair pair
    order by
      pair.inflow_movement_id,
      pair.deficit_movement_id
  loop
    select
      coalesce(sum(sm.total_cost), 0)
    into v_posted
    from
      app.stock_movements sm
    where
      sm.movement_type = 'closed_period'::app.movement_type
      and sm.cover_inflow_movement_id = v_pair.inflow_movement_id
      and sm.cover_deficit_movement_id = v_pair.deficit_movement_id;

    v_delta := v_pair.value_adj - v_posted;

    if v_delta = 0 then
      continue;
    end if;

    select
      sm.item_id,
      sm.occurred_at,
      sm.event_position,
      sm.piece_position,
      sm.movement_type
    into v_inflow
    from
      app.stock_movements sm
    where
      sm.id = v_pair.inflow_movement_id;

    select
      sm.movement_type,
      sm.item_id
    into v_deficit
    from
      app.stock_movements sm
    where
      sm.id = v_pair.deficit_movement_id;

    v_bucket := case v_deficit.movement_type
      when 'sale'::app.movement_type then 'cogs'
      when 'waste'::app.movement_type then 'waste'
      when 'sort_loss'::app.movement_type then 'waste'
      when 'closed_period'::app.movement_type then coalesce(
        (
          select
            closed.closed_bucket
          from
            app.stock_movements closed
          where
            closed.id = v_pair.deficit_movement_id
            and closed.closed_bucket in ('cogs', 'waste')
        ),
        'cogs'
      )
      else 'cogs'
    end;

    v_shift := app.closed_containing_shift (v_inflow.occurred_at);

    perform app.insert_closed_movement (
      v_cause,
      v_inflow.item_id,
      v_inflow.occurred_at,
      0,
      v_delta,
      v_bucket,
      null,
      v_shift,
      'cover',
      v_pair.inflow_movement_id::text || ':' || v_pair.deficit_movement_id::text,
      null,
      null,
      null,
      v_pair.inflow_movement_id,
      v_pair.deficit_movement_id,
      v_inflow.event_position,
      coalesce(v_inflow.piece_position, 0) + 1
    );

    -- The carrier changes what that deficit's pieces cost. Recognized value
    -- moves with it in this same transaction.
    perform app.note_recognized_cover (v_pair.deficit_movement_id, - v_delta);

    perform app.invalidate_checkpoints_from (
      v_inflow.item_id,
      v_inflow.occurred_at,
      'cover'
    );
  end loop;
end;
$$;

comment on function app.replay_write_cover_pairs (uuid) is 'Post the delta of each closed cover as one carrier row at the inflow. A second walk of the same pair posts nothing when the posted total already equals the required adjustment.';

revoke all on function app.replay_write_cover_pairs (uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_publish_checkpoints (p_item_ids uuid[]) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_item uuid;
  v_balance record;
  v_cut timestamptz;
  v_max bigint;
  v_anchor_count bigint;
  v_old_digest text;
  v_digest text;
  v_id bigint;
  v_cairo date;
begin
  for v_item in
    select distinct
      t.item_id
    from
      pg_catalog.unnest(p_item_ids) as t (item_id)
    where
      t.item_id is not null
    order by
      t.item_id
  loop
    if not exists (
      select
        1
      from
        ledger_scratch.recompute_row row
      where
        row.item_id = v_item
        and not row.is_pending
    )
    and not exists (
      select
        1
      from
        ledger_scratch.recompute_anchor anchor
      where
        anchor.item_id = v_item
    ) then
      continue;
    end if;

    select
      balance.on_hand_qty,
      balance.on_hand_value,
      balance.avg_cost,
      balance.cost_known,
      balance.has_uncovered_deficit
    into v_balance
    from
      ledger_scratch.recompute_bal balance
    where
      balance.item_id = v_item;

    select
      max(sm.id),
      max(sm.occurred_at)
    into
      v_max,
      v_cut
    from
      app.stock_movements sm
    where
      sm.item_id = v_item
      and sm.movement_type <> 'cost_adjustment'::app.movement_type;

    select
      greatest(
        v_cut,
        (
          select
            max(anchor.counted_at)
          from
            app.stock_count_anchors anchor
          where
            anchor.item_id = v_item
        )
      )
    into v_cut;

    if v_cut is null or v_max is null then
      continue;
    end if;

    select
      count(*)
    into v_anchor_count
    from
      app.stock_count_anchors anchor
    where
      anchor.item_id = v_item
      and anchor.counted_at <= v_cut;

    select
      resume.digest
    into v_old_digest
    from
      ledger_scratch.replay_resume resume
    where
      resume.item_id = v_item;

    select
      md5(
        coalesce(v_old_digest, '') || coalesce(
          string_agg(
            effect.movement_id::text || ':' || effect.base_total::text || ':' || effect.cover_total::text,
            ','
            order by
              effect.movement_id
          ),
          ''
        )
      )
    into v_digest
    from
      ledger_scratch.recompute_effect effect
    where
      effect.item_id = v_item;

    v_cairo := (v_cut at time zone 'Africa/Cairo')::date;

    insert into
      app.replay_checkpoint_invalidations (checkpoint_id, reason)
    select
      checkpoint.id,
      'superseded'
    from
      app.replay_checkpoints checkpoint
    where
      checkpoint.item_id = v_item
      and (checkpoint.cut_occurred_at at time zone 'Africa/Cairo')::date = v_cairo
      and not exists (
        select
          1
        from
          app.replay_checkpoint_invalidations invalidation
        where
          invalidation.checkpoint_id = checkpoint.id
      );

    insert into
      app.replay_checkpoints (
        item_id,
        cut_occurred_at,
        max_movement_id,
        on_hand_qty,
        on_hand_value,
        avg_cost,
        cost_known,
        has_uncovered_deficit,
        anchor_count,
        digest
      )
    values
      (
        v_item,
        v_cut,
        v_max,
        v_balance.on_hand_qty,
        v_balance.on_hand_value,
        v_balance.avg_cost,
        coalesce(v_balance.cost_known, false),
        coalesce(v_balance.has_uncovered_deficit, false),
        v_anchor_count,
        coalesce(v_digest, md5(v_item::text))
      )
    returning
      id into v_id;

    insert into
      app.replay_checkpoint_deficits (
        checkpoint_id,
        movement_id,
        item_id,
        qty_uncovered,
        value_uncovered,
        provisional_unit_cost,
        occurred_at,
        ord_class,
        event_position,
        piece_position
      )
    select
      v_id,
      deficit.movement_id,
      deficit.item_id,
      deficit.qty_uncovered,
      deficit.value_uncovered,
      deficit.provisional_unit_cost,
      deficit.occurred_at,
      deficit.ord_class,
      deficit.event_position,
      deficit.piece_position
    from
      ledger_scratch.recompute_def deficit
    where
      deficit.item_id = v_item;

    insert into
      app.replay_checkpoint_anchors (checkpoint_id, count_id, line_no)
    select
      v_id,
      anchor.count_id,
      anchor.line_no
    from
      ledger_scratch.recompute_anchor anchor
    where
      anchor.item_id = v_item;
  end loop;
end;
$$;

comment on function app.replay_publish_checkpoints (uuid[]) is 'Publish one cut per item that the write walk touched. The cut is the latest instant fully included. An earlier cut on the same Cairo day is superseded. A dry walk does not call this.';

revoke all on function app.replay_publish_checkpoints (uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- Closed rows.
-- ============================================================================
create function app.insert_closed_movement (
  p_cause uuid,
  p_item_id uuid,
  p_at timestamptz,
  p_qty numeric,
  p_total numeric,
  p_bucket text,
  p_economic text,
  p_shift text,
  p_source_kind text,
  p_source_id text,
  p_reason_code text,
  p_report_class text,
  p_waste_chain uuid,
  p_cover_inflow bigint,
  p_cover_deficit bigint,
  p_event bigint,
  p_piece integer
) returns bigint language plpgsql security definer
set
  search_path = '' as $$
declare
  v_id bigint;
  v_unit numeric(20, 6);
begin
  if p_qty = 0 then
    v_unit := 0;
  else
    v_unit := abs(pg_catalog.round(p_total / p_qty, 6));
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
      shift_id,
      source_type,
      source_id,
      closed_bucket,
      closed_cause_id,
      closed_economic_kind,
      cover_inflow_movement_id,
      cover_deficit_movement_id,
      event_position,
      piece_position
    )
  values
    (
      p_cause,
      p_item_id,
      'closed_period'::app.movement_type,
      p_at,
      p_qty,
      v_unit,
      p_total,
      false,
      null,
      'closed_period',
      p_source_id,
      p_bucket,
      p_cause,
      p_economic,
      p_cover_inflow,
      p_cover_deficit,
      p_event,
      p_piece
    )
  returning
    id into v_id;

  insert into
    app.closed_period_sources (
      movement_id,
      closed_cause_id,
      source_kind,
      source_id,
      waste_chain_id,
      reason_code,
      report_class
    )
  values
    (
      v_id,
      p_cause,
      p_source_kind,
      p_source_id,
      p_waste_chain,
      p_reason_code,
      p_report_class
    );

  insert into
    app.movement_attributions (movement_id, shift_id)
  values
    (v_id, p_shift);

  perform app.note_period_revision (
    v_id,
    p_shift,
    p_bucket,
    p_total,
    p_item_id,
    p_cause
  );

  return v_id;
end;
$$;

comment on function app.insert_closed_movement (
  uuid,
  uuid,
  timestamptz,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  bigint,
  bigint,
  bigint,
  integer
) is 'Insert one closed_period row, its source, a shift attribution even when the shift is null, and the period revision. The movement shift_id stays null.';

revoke all on function app.insert_closed_movement (
  uuid,
  uuid,
  timestamptz,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  bigint,
  bigint,
  bigint,
  integer
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.split_money (p_total numeric, p_weights numeric[]) returns numeric[] language plpgsql immutable security definer
set
  search_path = '' as $$
declare
  v_n integer := coalesce(pg_catalog.cardinality (p_weights), 0);
  v_sum numeric := 0;
  v_out numeric[] := '{}'::numeric[];
  v_acc numeric := 0;
  v_last integer := 0;
  v_piece numeric;
begin
  if v_n = 0 then
    return v_out;
  end if;

  for v_i in 1..v_n loop
    v_sum := v_sum + coalesce(p_weights[v_i], 0);

    if coalesce(p_weights[v_i], 0) <> 0 then
      v_last := v_i;
    end if;
  end loop;

  if v_sum = 0 then
    return pg_catalog.array_fill(0::numeric, array[v_n]);
  end if;

  for v_i in 1..v_n loop
    if v_i = v_last then
      v_piece := pg_catalog.round(p_total - v_acc, 2);
    elsif coalesce(p_weights[v_i], 0) = 0 then
      v_piece := 0;
    else
      v_piece := pg_catalog.round(p_total * p_weights[v_i] / v_sum, 2);
      v_acc := v_acc + v_piece;
    end if;

    v_out := v_out || v_piece;
  end loop;

  return v_out;
end;
$$;

comment on function app.split_money (numeric, numeric[]) is 'Split an amount by weights. The last non-zero weight takes the piaster remainder. A zero total weight returns zeros and does not divide.';

revoke all on function app.split_money (numeric, numeric[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.closed_layer_known (
  p_item_id uuid,
  p_document_id bigint,
  p_doc_at timestamptz,
  p_change timestamptz
) returns boolean language sql stable security definer
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
          sm.item_id = p_item_id
          and sm.occurred_at < p_doc_at
          and sm.movement_type <> 'cost_adjustment'::app.movement_type
          and sm.reverses_movement_id is null
          and not exists (
            select
              1
            from
              app.stock_movements rev
            where
              rev.reverses_movement_id = sm.id
          )
      ),
      0
    ) = 0
    and not exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = p_item_id
        and sm.id is distinct from p_document_id
        and sm.occurred_at > p_doc_at
        and sm.occurred_at <= p_change
        and sm.quantity > 0
        and (
          sm.movement_type in (
            'purchase'::app.movement_type,
            'opening'::app.movement_type,
            'sort_in'::app.movement_type
          )
          or (
            sm.movement_type = 'count_adjustment'::app.movement_type
          )
          or (
            sm.movement_type = 'closed_period'::app.movement_type
            and sm.closed_bucket = 'inventory'
          )
        )
    )
    and not exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = p_item_id
        and sm.occurred_at > p_doc_at
        and sm.occurred_at <= p_change
        and sm.movement_type in (
          'sort_out'::app.movement_type,
          'sort_in'::app.movement_type,
          'sort_loss'::app.movement_type
        )
    );
$$;

comment on function app.closed_layer_known (uuid, bigint, timestamptz, timestamptz) is 'True when the document was the only positive inflow up to its instant, nothing else came in later, and the item was not sorted. Later outflows do not by themselves make the layer unknown.';

revoke all on function app.closed_layer_known (uuid, bigint, timestamptz, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.closed_net_outflow_qty (
  p_item_id uuid,
  p_doc_at timestamptz,
  p_change timestamptz
) returns numeric language sql stable security definer
set
  search_path = '' as $$
  select
    greatest(
      coalesce(
        sum(
          case
            when sm.quantity < 0 then -sm.quantity
            when sm.quantity > 0
            and (
              sm.movement_type in (
                'sale_reversal'::app.movement_type,
                'waste_reversal'::app.movement_type
              )
              or (
                sm.movement_type = 'closed_period'::app.movement_type
                and sm.closed_bucket in ('cogs', 'waste', 'count')
              )
            ) then -sm.quantity
            else 0
          end
        ),
        0
      ),
      0
    )
  from
    app.stock_movements sm
  where
    sm.item_id = p_item_id
    and sm.occurred_at > p_doc_at
    and sm.occurred_at <= p_change
    and sm.movement_type <> 'cost_adjustment'::app.movement_type;
$$;

comment on function app.closed_net_outflow_qty (uuid, timestamptz, timestamptz) is 'Outflow quantity minus returns in the open interval after the document through the change. Returns are sale_reversal, waste_reversal, and a positive closed_period row in cogs, waste, or count. A positive inventory or sort_transfer row is an inflow, not a return. Quantity 0 adds nothing.';

revoke all on function app.closed_net_outflow_qty (uuid, timestamptz, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.closed_bucket_weights (
  p_item_id uuid,
  p_doc_at timestamptz,
  p_change timestamptz
) returns numeric[] language sql stable security definer
set
  search_path = '' as $$
  select
    array[
      coalesce(
        sum(-sm.quantity) filter (
          where
            sm.quantity < 0
            and (
              sm.movement_type = 'sale'::app.movement_type
              or (
                sm.movement_type = 'closed_period'::app.movement_type
                and sm.closed_bucket = 'cogs'
              )
            )
        ),
        0
      ),
      coalesce(
        sum(-sm.quantity) filter (
          where
            sm.quantity < 0
            and (
              sm.movement_type in (
                'waste'::app.movement_type,
                'sort_loss'::app.movement_type
              )
              or (
                sm.movement_type = 'closed_period'::app.movement_type
                and sm.closed_bucket = 'waste'
              )
            )
        ),
        0
      ),
      coalesce(
        sum(-sm.quantity) filter (
          where
            sm.quantity < 0
            and (
              sm.movement_type = 'count_adjustment'::app.movement_type
              or (
                sm.movement_type = 'closed_period'::app.movement_type
                and sm.closed_bucket = 'count'
              )
            )
        ),
        0
      ),
      coalesce(
        sum(-sm.quantity) filter (
          where
            sm.quantity < 0
            and (
              sm.movement_type = 'sort_out'::app.movement_type
              or (
                sm.movement_type = 'closed_period'::app.movement_type
                and sm.closed_bucket = 'sort_transfer'
              )
            )
        ),
        0
      )
    ]::numeric[]
  from
    app.stock_movements sm
  where
    sm.item_id = p_item_id
    and sm.occurred_at > p_doc_at
    and sm.occurred_at <= p_change
    and sm.movement_type <> 'cost_adjustment'::app.movement_type;
$$;

comment on function app.closed_bucket_weights (uuid, timestamptz, timestamptz) is 'Quantity weights for COGS, waste, count, and sort_transfer since the document. Quantity 0 rows have no weight.';

revoke all on function app.closed_bucket_weights (uuid, timestamptz, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.closed_allocation (
  p_item_id uuid,
  p_document_id bigint,
  p_value_delta numeric,
  p_qty_delta numeric,
  p_affected_qty numeric,
  p_doc_at timestamptz,
  p_change timestamptz
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_on_qty numeric(20, 6);
  v_on_value numeric(14, 2);
  v_on_now numeric(20, 6);
  v_out numeric(20, 6);
  v_den numeric(20, 6);
  v_known boolean;
  v_held_qty numeric(20, 6);
  v_raw numeric(14, 2);
  v_held numeric(14, 2);
  v_consumed numeric(14, 2);
  v_natural numeric(14, 2);
  v_overflow numeric(14, 2);
  v_weights numeric[];
  v_parts numeric[];
  v_natural_parts numeric[];
  v_overflow_parts numeric[];
  v_weight_sum numeric;
  v_consume_sum numeric;
begin
  select
    balance.on_hand_qty,
    balance.on_hand_value
  into
    v_on_qty,
    v_on_value
  from
    app.item_balances balance
  where
    balance.item_id = p_item_id;

  v_on_qty := coalesce(v_on_qty, 0);
  v_on_value := coalesce(v_on_value, 0);
  v_on_now := greatest(v_on_qty, 0);
  v_out := app.closed_net_outflow_qty (p_item_id, p_doc_at, p_change);
  v_den := v_on_now + v_out;
  v_known := p_document_id is not null
  and app.closed_layer_known (p_item_id, p_document_id, p_doc_at, p_change);

  if p_affected_qty = 0 then
    v_held_qty := 0;
    v_raw := p_value_delta;
  elsif v_known then
    v_held_qty := least(v_on_now, p_affected_qty);
    v_raw := pg_catalog.round(p_value_delta * v_held_qty / p_affected_qty, 2);
  elsif v_den = 0 then
    v_held_qty := 0;
    v_raw := 0;
  else
    v_held_qty := p_affected_qty * v_on_now / v_den;
    v_raw := pg_catalog.round(p_value_delta * v_held_qty / p_affected_qty, 2);
  end if;

  if v_on_qty > 0
  and v_raw < -v_on_value then
    v_held := -v_on_value;
    v_overflow := pg_catalog.round(v_raw - v_held, 2);
  else
    v_held := v_raw;
    v_overflow := 0;
  end if;

  -- The cap overflow is not a share of the original layer. It follows only
  -- this item's own consumption, never a sort that moved the layer onward.
  v_natural := pg_catalog.round(p_value_delta - v_raw, 2);
  v_consumed := pg_catalog.round(v_natural + v_overflow, 2);
  v_weights := app.closed_bucket_weights (p_item_id, p_doc_at, p_change);
  v_weight_sum := v_weights[1] + v_weights[2] + v_weights[3] + v_weights[4];
  v_consume_sum := v_weights[1] + v_weights[2] + v_weights[3];

  if v_natural = 0 then
    v_natural_parts := array[0, 0, 0, 0]::numeric[];
  elsif v_weight_sum = 0 then
    v_natural_parts := array[v_natural, 0, 0, 0]::numeric[];
  else
    v_natural_parts := app.split_money (v_natural, v_weights);
  end if;

  if v_overflow = 0 then
    v_overflow_parts := array[0, 0, 0]::numeric[];
  elsif v_consume_sum = 0 then
    v_overflow_parts := array[v_overflow, 0, 0]::numeric[];
  else
    v_overflow_parts := app.split_money (
      v_overflow,
      array[v_weights[1], v_weights[2], v_weights[3]]
    );
  end if;

  v_parts := array[
    v_natural_parts[1] + v_overflow_parts[1],
    v_natural_parts[2] + v_overflow_parts[2],
    v_natural_parts[3] + v_overflow_parts[3],
    v_natural_parts[4]
  ]::numeric[];

  return pg_catalog.jsonb_build_object(
    'known',
    v_known,
    'held_qty',
    v_held_qty,
    'raw_held',
    v_raw,
    'held',
    v_held,
    'consumed',
    v_consumed,
    'cogs',
    v_parts[1],
    'waste',
    v_parts[2],
    'count',
    v_parts[3],
    'sort_transfer',
    v_parts[4],
    'on_hand_qty',
    v_on_qty,
    'on_hand_value',
    v_on_value,
    'qty_delta',
    p_qty_delta
  );
end;
$$;

comment on function app.closed_allocation (
  uuid,
  bigint,
  numeric,
  numeric,
  numeric,
  timestamptz,
  timestamptz
) is 'Held and consumption shares of one closed correction. The cap binds only while on-hand quantity is positive. A zero affected quantity holds the whole value delta.';

revoke all on function app.closed_allocation (
  uuid,
  bigint,
  numeric,
  numeric,
  numeric,
  timestamptz,
  timestamptz
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_closed_item_rows (
  p_cause uuid,
  p_item_id uuid,
  p_at timestamptz,
  p_qty_delta numeric,
  p_value_delta numeric,
  p_allocation jsonb,
  p_economic text,
  p_source_kind text,
  p_source_id text,
  p_reason_code text,
  p_report_class text,
  p_waste_chain uuid,
  p_post_receipt boolean,
  p_depth integer,
  p_visited uuid[]
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_shift text;
  v_cogs numeric(14, 2);
  v_waste numeric(14, 2);
  v_count numeric(14, 2);
  v_sort numeric(14, 2);
  v_batch record;
  v_out record;
  v_group_value numeric(14, 2);
  v_group_qty numeric(20, 6);
  v_weights numeric[];
  v_i integer;
  v_share numeric(14, 2);
  v_child jsonb;
  v_j integer;
  v_piece numeric(14, 2);
  v_batch_shares numeric[];
  v_out_shares numeric[];
  v_doc_at timestamptz;
begin
  if p_depth > 8
  or p_item_id = any (p_visited) then
    return;
  end if;

  v_shift := app.closed_containing_shift (p_at);
  v_cogs := (p_allocation ->> 'cogs')::numeric;
  v_waste := (p_allocation ->> 'waste')::numeric;
  v_count := (p_allocation ->> 'count')::numeric;
  v_sort := (p_allocation ->> 'sort_transfer')::numeric;

  if p_post_receipt
  and (
    p_value_delta <> 0
    or p_qty_delta <> 0
  ) then
    perform app.insert_closed_movement (
      p_cause,
      p_item_id,
      p_at,
      p_qty_delta,
      p_value_delta,
      'inventory',
      p_economic,
      v_shift,
      p_source_kind,
      p_source_id,
      p_reason_code,
      p_report_class,
      p_waste_chain,
      null,
      null,
      0,
      case
        when p_value_delta < 0 then 8
        else 0
      end
    );
  end if;

  if v_cogs <> 0 then
    perform app.insert_closed_movement (
      p_cause,
      p_item_id,
      p_at,
      0,
      -v_cogs,
      'cogs',
      null,
      v_shift,
      p_source_kind,
      p_source_id,
      p_reason_code,
      p_report_class,
      p_waste_chain,
      null,
      null,
      0,
      case
        when -v_cogs < 0 then 9
        else 1
      end
    );
  end if;

  if v_waste <> 0 then
    perform app.insert_closed_movement (
      p_cause,
      p_item_id,
      p_at,
      0,
      -v_waste,
      'waste',
      null,
      v_shift,
      p_source_kind,
      p_source_id,
      p_reason_code,
      p_report_class,
      p_waste_chain,
      null,
      null,
      0,
      case
        when -v_waste < 0 then 10
        else 2
      end
    );
  end if;

  if v_count <> 0 then
    perform app.insert_closed_movement (
      p_cause,
      p_item_id,
      p_at,
      0,
      -v_count,
      'count',
      null,
      v_shift,
      p_source_kind,
      p_source_id,
      p_reason_code,
      p_report_class,
      p_waste_chain,
      null,
      null,
      0,
      case
        when -v_count < 0 then 11
        else 3
      end
    );
  end if;

  if v_sort <> 0 then
    perform app.insert_closed_movement (
      p_cause,
      p_item_id,
      p_at,
      0,
      -v_sort,
      'sort_transfer',
      null,
      v_shift,
      p_source_kind,
      p_source_id,
      p_reason_code,
      p_report_class,
      p_waste_chain,
      null,
      null,
      0,
      case
        when -v_sort < 0 then 12
        else 4
      end
    );
  end if;

  if v_sort = 0 then
    return;
  end if;

  select
    doc.occurred_at
  into v_doc_at
  from
    app.stock_movements doc
  where
    doc.id::text = p_source_id;

  v_doc_at := coalesce(v_doc_at, '-infinity'::timestamptz);
  v_weights := '{}'::numeric[];
  v_group_value := 0;
  v_group_qty := 0;

  for v_batch in
    select
      sm.batch_id,
      coalesce(
        (
          select
            sum(incoming.total_cost)
          from
            app.stock_movements incoming
          where
            incoming.batch_id = sm.batch_id
            and incoming.movement_type = 'sort_in'::app.movement_type
        ),
        0
      ) as transferred,
      coalesce(
        (
          select
            sum(incoming.quantity)
          from
            app.stock_movements incoming
          where
            incoming.batch_id = sm.batch_id
            and incoming.movement_type = 'sort_in'::app.movement_type
        ),
        0
      ) as qty
    from
      app.stock_movements sm
    where
      sm.item_id = p_item_id
      and sm.movement_type = 'sort_out'::app.movement_type
      and sm.occurred_at > v_doc_at
      and sm.occurred_at <= p_at
    group by
      sm.batch_id
    order by
      min(sm.id)
  loop
    v_group_value := v_group_value + v_batch.transferred;
    v_group_qty := v_group_qty + v_batch.qty;

    if v_group_value = 0 then
      v_weights := v_weights || v_batch.qty;
    else
      v_weights := v_weights || v_batch.transferred;
    end if;
  end loop;

  -- The group total is known only after the loop. Split once, by value when
  -- that total is not 0 and by quantity otherwise.
  v_weights := '{}'::numeric[];

  for v_batch in
    select
      sm.batch_id,
      coalesce(
        (
          select
            sum(incoming.total_cost)
          from
            app.stock_movements incoming
          where
            incoming.batch_id = sm.batch_id
            and incoming.movement_type = 'sort_in'::app.movement_type
        ),
        0
      ) as transferred,
      coalesce(
        (
          select
            sum(incoming.quantity)
          from
            app.stock_movements incoming
          where
            incoming.batch_id = sm.batch_id
            and incoming.movement_type = 'sort_in'::app.movement_type
        ),
        0
      ) as qty
    from
      app.stock_movements sm
    where
      sm.item_id = p_item_id
      and sm.movement_type = 'sort_out'::app.movement_type
      and sm.occurred_at > v_doc_at
      and sm.occurred_at <= p_at
    group by
      sm.batch_id
    order by
      min(sm.id)
  loop
    if v_group_value <> 0 then
      v_weights := v_weights || v_batch.transferred;
    else
      v_weights := v_weights || v_batch.qty;
    end if;
  end loop;

  if v_group_value = 0
  and v_group_qty = 0 then
    return;
  end if;

  v_batch_shares := app.split_money (v_sort, v_weights);
  v_i := 0;

  for v_batch in
    select
      sm.batch_id
    from
      app.stock_movements sm
    where
      sm.item_id = p_item_id
      and sm.movement_type = 'sort_out'::app.movement_type
      and sm.occurred_at > v_doc_at
      and sm.occurred_at <= p_at
    group by
      sm.batch_id
    order by
      min(sm.id)
  loop
    v_i := v_i + 1;
    v_share := v_batch_shares[v_i];

    if v_share = 0 then
      continue;
    end if;

    v_weights := '{}'::numeric[];
    v_group_value := 0;
    v_group_qty := 0;

    for v_out in
      select
        incoming.item_id,
        incoming.quantity,
        incoming.total_cost
      from
        app.stock_movements incoming
      where
        incoming.batch_id = v_batch.batch_id
        and incoming.movement_type = 'sort_in'::app.movement_type
      order by
        incoming.event_position,
        incoming.piece_position,
        incoming.id
    loop
      v_group_value := v_group_value + v_out.total_cost;
      v_group_qty := v_group_qty + v_out.quantity;
    end loop;

    for v_out in
      select
        incoming.item_id,
        incoming.quantity,
        incoming.total_cost
      from
        app.stock_movements incoming
      where
        incoming.batch_id = v_batch.batch_id
        and incoming.movement_type = 'sort_in'::app.movement_type
      order by
        incoming.event_position,
        incoming.piece_position,
        incoming.id
    loop
      if v_group_value <> 0 then
        v_weights := v_weights || v_out.total_cost;
      else
        v_weights := v_weights || v_out.quantity;
      end if;
    end loop;

    if v_group_value = 0
    and v_group_qty = 0 then
      continue;
    end if;

    v_out_shares := app.split_money (v_share, v_weights);
    v_j := 0;

    for v_out in
      select
        incoming.id,
        incoming.item_id,
        incoming.quantity,
        incoming.occurred_at
      from
        app.stock_movements incoming
      where
        incoming.batch_id = v_batch.batch_id
        and incoming.movement_type = 'sort_in'::app.movement_type
      order by
        incoming.event_position,
        incoming.piece_position,
        incoming.id
    loop
      v_j := v_j + 1;
      v_piece := v_out_shares[v_j];

      if v_piece = 0 then
        continue;
      end if;

      perform app.insert_closed_movement (
        p_cause,
        v_out.item_id,
        p_at,
        0,
        v_piece,
        'sort_transfer',
        null,
        v_shift,
        p_source_kind,
        p_source_id,
        p_reason_code,
        p_report_class,
        p_waste_chain,
        null,
        null,
        0,
        case
          when v_piece < 0 then 8
          else 0
        end
      );

      v_child := app.closed_allocation (
        v_out.item_id,
        v_out.id,
        v_piece,
        0,
        v_out.quantity,
        v_out.occurred_at,
        p_at
      );

        -- The receiving row is the output's receipt. Do not post an inventory row.
        -- Force the sort weight off the output's own allocation by posting only
        -- its consumption recognitions. A further sort is a nested call.
        perform app.post_closed_item_rows (
          p_cause,
          v_out.item_id,
          p_at,
          0,
          v_piece,
          v_child,
          null,
          p_source_kind,
          p_source_id,
          p_reason_code,
          p_report_class,
          p_waste_chain,
          false,
          p_depth + 1,
          p_visited || p_item_id
        );
    end loop;
  end loop;
end;
$$;

comment on function app.post_closed_item_rows (
  uuid,
  uuid,
  timestamptz,
  numeric,
  numeric,
  jsonb,
  text,
  text,
  text,
  text,
  text,
  uuid,
  boolean,
  integer,
  uuid[]
) is 'Write one item''s closed rows and, when value was sorted onward, one receiving row per output plus that output''s own recognition. sort_transfer is only the matched pair.';

revoke all on function app.post_closed_item_rows (
  uuid,
  uuid,
  timestamptz,
  numeric,
  numeric,
  jsonb,
  text,
  text,
  text,
  text,
  text,
  uuid,
  boolean,
  integer,
  uuid[]
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.wake_closed_cost_basis (p_cause uuid, p_item_id uuid) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_order text;
begin
  for v_order in
    select
      state.order_id
    from
      app.accounting_work_state state
    where
      state.last_outcome = 'blocked'
      and state.last_reason = 'missing_cost_basis'
      and state.blocked_item_ids @> array[p_item_id]
    order by
      state.order_id
  loop
    perform app.enqueue_accounting_event (
      v_order,
      'cost_basis',
      'closed:' || p_cause::text || ':' || v_order,
      null,
      null
    );
  end loop;
end;
$$;

comment on function app.wake_closed_cost_basis (uuid, uuid) is 'After a closed receipt establishes a cost basis, enqueue orders parked on missing_cost_basis for that item. The source key is stable.';

revoke all on function app.wake_closed_cost_basis (uuid, uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.finish_closed_cause (p_cause uuid, p_items uuid[]) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_item uuid;
  v_change timestamptz;
begin
  v_change := app.note_change_instant ();

  foreach v_item in array p_items loop
    perform app.invalidate_checkpoints_from (v_item, v_change, 'closed_cause');
  end loop;

  perform app.prepare_balance_locks (p_items);

  perform app.replay_execute (
    app.recompute_item_set (p_items),
    '[]'::jsonb,
    p_cause,
    true
  );
end;
$$;

comment on function app.finish_closed_cause (uuid, uuid[]) is 'Invalidate checkpoints at or after the change, then replay so balances come from the walk.';

revoke all on function app.finish_closed_cause (uuid, uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_closed_document_correction (
  p_cause uuid,
  p_item_id uuid,
  p_document_id bigint,
  p_value_delta numeric,
  p_qty_delta numeric,
  p_affected_qty numeric,
  p_source_kind text,
  p_source_id text,
  p_economic_kind text,
  p_reason_code text,
  p_report_class text,
  p_waste_chain uuid
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_cause uuid;
  v_change timestamptz;
  v_doc_at timestamptz;
  v_allocation jsonb;
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  v_change := app.note_change_instant ();
  v_cause := coalesce(p_cause, pg_catalog.gen_random_uuid ());

  select
    sm.occurred_at
  into v_doc_at
  from
    app.stock_movements sm
  where
    sm.id = p_document_id;

  if v_doc_at is null then
    v_doc_at := v_change;
  end if;

  if p_qty_delta < 0
  and coalesce(
    (
      select
        balance.avg_cost
      from
        app.item_balances balance
      where
        balance.item_id = p_item_id
    ),
    0
  ) <= 0
  and not exists (
    select
      1
    from
      app.item_provisional_seeds seed
    where
      seed.item_id = p_item_id
  ) then
    perform app.ensure_provisional_seed (p_item_id);
  end if;

  v_allocation := app.closed_allocation (
    p_item_id,
    p_document_id,
    p_value_delta,
    p_qty_delta,
    p_affected_qty,
    v_doc_at,
    v_change
  );

  perform app.post_closed_item_rows (
    v_cause,
    p_item_id,
    v_change,
    p_qty_delta,
    p_value_delta,
    v_allocation,
    p_economic_kind,
    p_source_kind,
    coalesce(p_source_id, p_document_id::text),
    p_reason_code,
    p_report_class,
    p_waste_chain,
    true,
    0,
    '{}'::uuid[]
  );

  if p_economic_kind in ('purchase', 'opening', 'sort_in')
  and p_qty_delta >= 0 then
    perform app.wake_closed_cost_basis (v_cause, p_item_id);
  end if;

  perform app.finish_closed_cause (v_cause, array[p_item_id]);

  return v_cause;
end;
$$;

comment on function app.post_closed_document_correction (
  uuid,
  uuid,
  bigint,
  numeric,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  text,
  uuid
) is 'Post one closed correction of a document and replay the item. A missing cost basis for an added outflow raises P0001 missing_cost_basis before any row is written.';

revoke all on function app.post_closed_document_correction (
  uuid,
  uuid,
  bigint,
  numeric,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  text,
  uuid
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_closed_legs (p_cause uuid, p_legs jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_cause uuid;
  v_change timestamptz;
  v_leg jsonb;
  v_items uuid[] := '{}'::uuid[];
  v_item uuid;
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  v_change := app.note_change_instant ();
  v_cause := coalesce(p_cause, pg_catalog.gen_random_uuid ());

  for v_leg in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_legs) as elem (value)
  loop
    v_item := (v_leg ->> 'item_id')::uuid;
    v_items := v_items || v_item;

    perform app.insert_closed_movement (
      v_cause,
      v_item,
      v_change,
      coalesce((v_leg ->> 'quantity')::numeric, 0),
      (v_leg ->> 'total_cost')::numeric,
      v_leg ->> 'bucket',
      v_leg ->> 'economic_kind',
      app.closed_containing_shift (v_change),
      coalesce(v_leg ->> 'source_kind', 'manual'),
      coalesce(v_leg ->> 'source_id', v_cause::text),
      v_leg ->> 'reason_code',
      v_leg ->> 'report_class',
      (v_leg ->> 'waste_chain_id')::uuid,
      null,
      null,
      null,
      coalesce((v_leg ->> 'piece')::integer, 0)
    );
  end loop;

  perform app.finish_closed_cause (v_cause, v_items);

  return v_cause;
end;
$$;

comment on function app.post_closed_legs (uuid, jsonb) is 'Post an explicit list of closed rows for one cause, then replay. Used when the rows are the correction, including a reason move whose net is zero.';

revoke all on function app.post_closed_legs (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.backdated_batch_is_closed (p_pending jsonb) returns boolean language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_window timestamptz;
begin
  if p_pending is null
  or pg_catalog.jsonb_typeof(p_pending) <> 'array'
  or pg_catalog.jsonb_array_length(p_pending) = 0 then
    return false;
  end if;

  v_window := app.restatement_window_start (app.note_change_instant ());

  return (
    select
      bool_and((elem.value ->> 'occurred_at')::timestamptz < v_window)
    from
      pg_catalog.jsonb_array_elements(p_pending) as elem (value)
  );
end;
$$;

comment on function app.backdated_batch_is_closed (jsonb) is 'True when every row of the batch is strictly before the window. An in-window batch keeps today''s restatement. note_change_instant is read and not taken again when it is already set.';

revoke all on function app.backdated_batch_is_closed (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_closed_backdated_batch (p_batch_id uuid, p_pending jsonb) returns bigint[] language plpgsql security definer
set
  search_path = '' as $$
declare
  v_elem jsonb;
  v_ids bigint[] := '{}'::bigint[];
  v_id bigint;
  v_items uuid[] := '{}'::uuid[];
  v_change timestamptz;
  v_type text;
  v_qty numeric;
  v_total numeric;
  v_unit numeric;
  v_bucket text;
  v_priced jsonb := '[]'::jsonb;
begin
  v_change := app.note_change_instant ();

  -- Price every unpriced outflow before the first insert. A missing basis
  -- leaves the batch unposted.
  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_pending) as elem (value)
  loop
    v_type := v_elem ->> 'movement_type';
    v_qty := (v_elem ->> 'quantity')::numeric;
    v_total := coalesce((v_elem ->> 'total_cost')::numeric, 0);

    if v_qty < 0
    and v_type in ('sale', 'waste', 'count_adjustment')
    and v_total = 0
    and coalesce((v_elem ->> 'is_input_total')::boolean, false) = false then
      v_unit := app.closed_unit_cost ((v_elem ->> 'item_id')::uuid);

      if v_unit is null then
        raise exception 'missing_cost_basis'
          using errcode = 'P0001',
          detail = 'missing_cost_basis';
      end if;

      v_total := -pg_catalog.round(abs(v_qty) * v_unit, 2);
    end if;

    v_bucket := case v_type
      when 'waste' then 'waste'
      when 'sale' then 'cogs'
      when 'count_adjustment' then 'count'
      else 'inventory'
    end;

    v_priced := v_priced || pg_catalog.jsonb_build_array(
      v_elem || pg_catalog.jsonb_build_object('total_cost', v_total, 'closed_bucket', v_bucket)
    );
  end loop;

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(v_priced) as elem (value)
  loop
    v_type := v_elem ->> 'movement_type';
    v_qty := (v_elem ->> 'quantity')::numeric;
    v_total := (v_elem ->> 'total_cost')::numeric;
    v_bucket := v_elem ->> 'closed_bucket';
    v_items := v_items || (v_elem ->> 'item_id')::uuid;

    v_id := app.insert_closed_movement (
      p_batch_id,
      (v_elem ->> 'item_id')::uuid,
      v_change,
      v_qty,
      v_total,
      v_bucket,
      v_type,
      app.closed_containing_shift (v_change),
      v_type,
      coalesce(v_elem ->> 'source_id', p_batch_id::text),
      null,
      null,
      null,
      null,
      null,
      null,
      0
    );

    if v_type = 'purchase' then
      v_ids := v_ids || v_id;
    end if;

    if v_type in ('purchase', 'opening', 'sort_in') then
      perform app.wake_closed_cost_basis (p_batch_id, (v_elem ->> 'item_id')::uuid);
    end if;
  end loop;

  perform app.finish_closed_cause (p_batch_id, v_items);

  return v_ids;
end;
$$;

comment on function app.post_closed_backdated_batch (uuid, jsonb) is 'A back-dated batch whose instants are all before the window. Added outflows are priced from the current basis before anything is inserted. Purchases keep their own totals. One returned id per purchase line.';

revoke all on function app.post_closed_backdated_batch (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- Frozen input and the loaded marker.
-- ============================================================================
create function app.order_processing_input_id (p_order_id text) returns bigint language sql stable security definer
set
  search_path = '' as $$
  select
    case
      when exists (
        select
          1
        from
          app.activation_history_input frozen
        where
          frozen.order_id = p_order_id
          and not exists (
            select
              1
            from
              app.activation_history_posted posted
            where
              posted.order_id = frozen.order_id
              and posted.cost_input_id = frozen.cost_input_id
          )
      ) then (
        select
          frozen.cost_input_id
        from
          app.activation_history_input frozen
        where
          frozen.order_id = p_order_id
      )
      else (
        select
          input.id
        from
          app.pos_cost_inputs input
        where
          input.order_id = p_order_id
        order by
          input.input_revision desc
        limit
          1
      )
    end;
$$;

comment on function app.order_processing_input_id (text) is 'The frozen cost input until that input has a durable posting proof. After the proof, the latest input, including an edit that arrived while the input was frozen.';

revoke all on function app.order_processing_input_id (text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.maybe_mark_activation_loaded () returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  if exists (
    select
      1
    from
      app.activation_history_loaded
  ) then
    return;
  end if;

  if not exists (
    select
      1
    from
      app.activation_history_bound
  ) then
    return;
  end if;

  if exists (
    select
      1
    from
      app.activation_history_input frozen
    where
      not exists (
        select
          1
        from
          app.activation_history_posted posted
        where
          posted.order_id = frozen.order_id
          and posted.cost_input_id = frozen.cost_input_id
      )
  ) then
    return;
  end if;

  insert into
    app.activation_history_loaded (loaded_at)
  values
    (pg_catalog.clock_timestamp ());
end;
$$;

comment on function app.maybe_mark_activation_loaded () is 'Set the loaded marker once an activation bound exists and every frozen input has a posting receipt. A bound with no inputs completes. A bound that was never inserted leaves the marker unset. Blocked and disposition_pending do not count.';

revoke all on function app.maybe_mark_activation_loaded ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.trg_activation_history_bound () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_bound timestamptz := pg_catalog.clock_timestamp();
begin
  insert into
    app.activation_history_bound (bound_at, stock_started_at)
  values
    (v_bound, new.stock_started_at);

  insert into
    app.activation_history_input (order_id, bound_at, cost_input_id, ordered_at)
  select distinct
    on (event.order_id) event.order_id,
    v_bound,
    input.id,
    snap.ordered_at
  from
    app.accounting_work_events event
    join app.pos_cost_inputs input on input.id = event.cost_input_id
    join app.pos_order_snapshots snap on snap.id = input.snapshot_id
  where
    event.created_at <= v_bound
    and event.cause = 'pos_input'
  order by
    event.order_id,
    input.input_revision desc;

  if not exists (
    select
      1
    from
      app.activation_history_input
  ) then
    insert into
      app.activation_history_loaded (loaded_at)
    values
      (pg_catalog.clock_timestamp ());
  end if;

  return null;
end;
$$;

comment on function app.trg_activation_history_bound () is 'On activation insert, freeze the latest cost input of every order whose event already existed. An empty copy completes the bound. Later orders are not part of it.';

revoke all on function app.trg_activation_history_bound ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_inventory_activation_history
after insert on app.inventory_activation for each row
execute function app.trg_activation_history_bound ();

create function app.note_activation_history_posted () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  if new.receipt_kind = 'posting' then
    insert into
      app.activation_history_posted (order_id, cost_input_id, application_id)
    select
      new.order_id,
      new.cost_input_id,
      new.id
    from
      app.activation_history_input frozen
    where
      frozen.order_id = new.order_id
      and frozen.cost_input_id = new.cost_input_id
    on conflict (order_id) do nothing;
  end if;

  return new;
end;
$$;

comment on function app.note_activation_history_posted () is 'Record the frozen input the first time a posting receipt is written for it. A later owner does not erase the proof.';

revoke all on function app.note_activation_history_posted ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_activation_history_posted
after insert on app.order_cost_applications for each row
execute function app.note_activation_history_posted ();

create function app.post_closed_historical_order (
  p_order_id text,
  p_cost_input_id bigint,
  p_attempt_id uuid,
  p_work_generation integer
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_res jsonb;
  v_elem jsonb;
  v_item uuid;
  v_qty numeric(20, 6);
  v_unit numeric(20, 6);
  v_total numeric(14, 2);
  v_cause uuid;
  v_change timestamptz;
  v_shift text;
  v_app bigint;
  v_items uuid[] := '{}'::uuid[];
  v_snap_id bigint;
  v_ordered timestamptz;
  v_requirements jsonb := '[]'::jsonb;
begin
  perform app.assert_ledger_lock_held ();

  v_change := app.note_change_instant ();
  v_res := app.resolve_order_requirements (p_order_id, null);

  if v_res ->> 'status' is distinct from 'ready' then
    return pg_catalog.jsonb_build_object(
      'outcome',
      'incomplete',
      'reason',
      coalesce(v_res ->> 'status', 'incomplete')
    );
  end if;

  select
    order_row.shift_id,
    snap.id,
    snap.ordered_at
  into
    v_shift,
    v_snap_id,
    v_ordered
  from
    app.pos_orders order_row
    join app.pos_cost_inputs input on input.order_id = order_row.id
    join app.pos_order_snapshots snap on snap.id = input.snapshot_id
  where
    order_row.id = p_order_id
    and input.id = p_cost_input_id;

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(coalesce(v_res -> 'requirements', '[]'::jsonb)) as elem (value)
  loop
    v_item := (v_elem ->> 'stock_item_id')::uuid;
    v_qty := (v_elem ->> 'quantity')::numeric;

    if v_qty is null or v_qty = 0 then
      continue;
    end if;

    select
      balance.avg_cost
    into v_unit
    from
      app.item_balances balance
    where
      balance.item_id = v_item
      and balance.avg_cost > 0;

    if v_unit is null then
      select
        seed.unit_cost
      into v_unit
      from
        app.item_provisional_seeds seed
      where
        seed.item_id = v_item;
    end if;

    if v_unit is null then
      select
        price.unit_cost
      into v_unit
      from
        app.item_opening_prices price
      where
        price.item_id = v_item
        and price.superseded_change_id is null;
    end if;

    if v_unit is null then
      return pg_catalog.jsonb_build_object(
        'outcome',
        'blocked',
        'reason',
        'missing_cost_basis',
        'blocked_item_ids',
        pg_catalog.jsonb_build_array(v_item)
      );
    end if;
    v_total := -pg_catalog.round(v_qty * v_unit, 2);
    v_requirements := v_requirements || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'stock_item_id',
        v_item,
        'quantity',
        v_qty,
        'total',
        v_total
      )
    );
  end loop;

  v_cause := pg_catalog.gen_random_uuid ();

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(v_requirements) as elem (value)
  loop
    v_item := (v_elem ->> 'stock_item_id')::uuid;
    v_qty := (v_elem ->> 'quantity')::numeric;
    v_total := (v_elem ->> 'total')::numeric;
    v_items := v_items || v_item;

    perform app.insert_closed_movement (
      v_cause,
      v_item,
      v_change,
      -v_qty,
      v_total,
      'cogs',
      'sale',
      app.closed_containing_shift (v_change),
      'order',
      p_order_id,
      null,
      null,
      null,
      null,
      null,
      null,
      0
    );
  end loop;

  v_app := pg_catalog.nextval(
    pg_catalog.pg_get_serial_sequence('app.order_cost_applications', 'id')
  );

  insert into
    app.order_cost_applications (
      id,
      order_id,
      cost_input_id,
      snapshot_id,
      receipt_kind,
      disposition,
      occurred_at,
      shift_id,
      signature,
      requirements,
      posting_batch,
      movement_owner_id,
      work_generation,
      attempt_id
    )
  values
    (
      v_app,
      p_order_id,
      p_cost_input_id,
      v_snap_id,
      'posting',
      case
        when v_shift is null then 'none'
        else 'sale'
      end,
      v_ordered,
      v_shift,
      md5('closed|' || p_order_id || '|' || p_cost_input_id::text),
      v_requirements,
      v_cause,
      v_app,
      p_work_generation,
      p_attempt_id
    );

  insert into
    app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
  select
    sm.id,
    v_app,
    p_order_id,
    sm.item_id
  from
    app.stock_movements sm
  where
    sm.batch_id = v_cause;

  insert into
    app.order_cost_state (order_id)
  values
    (p_order_id)
  on conflict (order_id) do nothing;

  update app.order_cost_state head
  set
    latest_input_id = p_cost_input_id,
    latest_application_id = v_app,
    owner_application_id = v_app,
    disposition = 'sale',
    signature = md5('closed|' || p_order_id || '|' || p_cost_input_id::text),
    updated_at = pg_catalog.clock_timestamp ()
  where
    head.order_id = p_order_id;

  perform app.finish_closed_cause (v_cause, v_items);

  return pg_catalog.jsonb_build_object(
    'outcome',
    'applied',
    'reason',
    null,
    'application_id',
    v_app,
    'receipt_kind',
    'posting'
  );
end;
$$;

comment on function app.post_closed_historical_order (text, bigint, uuid, integer) is 'First posting of an order discovered after the loaded marker, when the order is after the stock start and before the window. The rows are a closed cause at the change instant.';

revoke all on function app.post_closed_historical_order (text, bigint, uuid, integer)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.record_accrual_version (
  p_span_id bigint,
  p_change_id bigint,
  p_window_start timestamptz,
  p_cost_input_id bigint,
  p_disposition_event_id bigint,
  p_source_kind text,
  p_source_id text,
  p_item_id uuid,
  p_qty numeric,
  p_value numeric
) returns bigint language plpgsql security definer
set
  search_path = '' as $$
declare
  v_id bigint;
begin
  insert into
    app.accounting_accrual_versions (
      span_id,
      change_id,
      window_start,
      cost_input_id,
      disposition_event_id,
      source_kind,
      source_id,
      item_id,
      recognized_qty,
      recognized_value
    )
  values
    (
      p_span_id,
      p_change_id,
      p_window_start,
      p_cost_input_id,
      p_disposition_event_id,
      p_source_kind,
      p_source_id,
      p_item_id,
      p_qty,
      p_value
    )
  returning
    id into v_id;

  return v_id;
end;
$$;

comment on function app.record_accrual_version (
  bigint,
  bigint,
  timestamptz,
  bigint,
  bigint,
  text,
  text,
  uuid,
  numeric,
  numeric
) is 'Store one accrual slice. Publish compares it with the recognized contribution and posts only the delta.';

revoke all on function app.record_accrual_version (
  bigint,
  bigint,
  timestamptz,
  bigint,
  bigint,
  text,
  text,
  uuid,
  numeric,
  numeric
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.publish_accrual_delta (
  p_attempt_id uuid,
  p_source_kind text,
  p_source_id text,
  p_item_id uuid,
  p_bucket text,
  p_required numeric,
  p_cause uuid
) returns numeric language plpgsql security definer
set
  search_path = '' as $$
declare
  v_recognized numeric(14, 2);
  v_delta numeric(14, 2);
  v_change timestamptz;
  v_version record;
begin
  perform app.assert_ledger_lock_held ();

  v_change := app.note_change_instant ();

  select
    contribution.amount
  into v_recognized
  from
    app.recognized_contribution contribution
  where
    contribution.source_kind = p_source_kind
    and contribution.source_id = p_source_id
    and contribution.item_id = p_item_id
    and contribution.bucket = p_bucket
  for update;

  v_recognized := coalesce(v_recognized, 0);
  v_delta := pg_catalog.round(p_required - v_recognized, 2);

  select
    version.*
  into v_version
  from
    app.accounting_accrual_versions version
  where
    version.source_kind = p_source_kind
    and version.source_id = p_source_id
    and version.item_id = p_item_id
    and version.voided_at is null
  order by
    version.id desc
  limit
    1;

  if v_version.id is not null
  and v_version.recognized_value is distinct from v_recognized then
    update app.accounting_accrual_versions version
    set
      voided_at = v_change
    where
      version.id = v_version.id;

    v_version := null;
  end if;

  if v_delta <> 0 then
    perform app.insert_closed_movement (
      coalesce(p_cause, pg_catalog.gen_random_uuid ()),
      p_item_id,
      v_change,
      0,
      -v_delta,
      p_bucket,
      null,
      app.closed_containing_shift (v_change),
      p_source_kind,
      p_source_id,
      null,
      null,
      null,
      null,
      null,
      null,
      0
    );

    insert into
      app.recognized_contribution (source_kind, source_id, item_id, bucket, amount)
    values
      (
        p_source_kind,
        p_source_id,
        p_item_id,
        p_bucket,
        v_recognized + v_delta
      )
    on conflict (source_kind, source_id, item_id, bucket) do update
    set
      amount = excluded.amount;
  end if;

  insert into
    app.accounting_attempt_progress (attempt_id, status)
  values
    (p_attempt_id, 'processed')
  on conflict (attempt_id) do nothing;

  return v_delta;
end;
$$;

comment on function app.publish_accrual_delta (uuid, text, text, uuid, text, numeric, uuid) is 'Post required minus recognized for one source. A stored accrual that no longer matches the recognized value is voided. The attempt progress row marks the slice committed.';

revoke all on function app.publish_accrual_delta (uuid, text, text, uuid, text, numeric, uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.assert_ledger_write_allowed () returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_is_owner boolean;
  v_db_role text;
  v_jwt_role text;
begin
  v_is_owner := coalesce(app.is_owner (), false);
  v_db_role := coalesce(nullif(pg_catalog.current_setting('role', true), ''), '');
  v_jwt_role := coalesce(
    (
      select
        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    ),
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    ''
  );

  if not coalesce(
    v_is_owner is true
    or v_db_role = 'service_role'
    or v_jwt_role = 'service_role',
    false
  ) then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Serialize all ledger writes with a single fixed transaction-level advisory lock key.
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  perform app.note_change_instant ();
end;
$$;

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
  ledger_scratch.recompute_anchor,
  ledger_scratch.replay_resume,
  ledger_scratch.recompute_cover_pair,
  ledger_scratch.replay_restore_plan;
end;
$$;

create function app.replay_plan_uses_movement_index (p_plan text) returns boolean language sql immutable security definer
set
  search_path = '' as $$
  select
    (
      p_plan ~* 'Index (Only )?Scan using \S+ on stock_movements( |$)'
      or p_plan ~* 'Bitmap Index Scan on stock_movements'
    )
    and p_plan !~* 'Seq Scan on stock_movements( |$)';
$$;

comment on function app.replay_plan_uses_movement_index (text) is 'True when the plan reads stock_movements by an index range and does not sequence-scan that table.';

create function app.replay_plan_uses_deficit_index (p_plan text) returns boolean language sql immutable security definer
set
  search_path = '' as $$
  select
    (
      p_plan ~* 'Index (Only )?Scan using \S+ on replay_checkpoint_deficits( |$)'
      or p_plan ~* 'Bitmap Index Scan on replay_checkpoint_deficits'
    )
    and p_plan !~* 'Seq Scan on replay_checkpoint_deficits( |$)';
$$;

comment on function app.replay_plan_uses_deficit_index (text) is 'True when the plan reads replay_checkpoint_deficits by an index and does not sequence-scan that table. A sequence scan of a large share is a legitimate restore and is not required to be an index.';

create function app.replay_plan_shared_buffers (p_plan text) returns bigint language sql immutable security definer
set
  search_path = '' as $$
  select
    coalesce(sum((match[1])::bigint), 0)
  from
    pg_catalog.regexp_matches(
      coalesce(p_plan, ''),
      '(?:hit|read|dirtied|written)=([0-9]+)',
      'g'
    ) as match;
$$;

comment on function app.replay_plan_shared_buffers (text) is 'Shared hit, read, dirtied and written pages reported on an EXPLAIN ANALYZE BUFFERS plan.';

revoke all on function app.replay_plan_shared_buffers (text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.replay_plan_uses_deficit_index (text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.replay_plan_uses_movement_index (text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_capture_read (p_item_ids uuid[]) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_time_rows bigint := 0;
  v_id_rows bigint := 0;
  v_def_rows bigint := 0;
  v_time_plan text := '';
  v_id_plan text := '';
  v_def_plan text := '';
  v_def_buffers bigint := 0;
  v_prefix_rows bigint := 0;
  v_line record;
  v_resume record;
  v_has_checkpoint boolean := false;
begin
  if coalesce(pg_catalog.current_setting('app.replay_probe', true), '') <> '1' then
    return;
  end if;

  select
    exists (
      select
        1
      from
        ledger_scratch.replay_resume resume
      where
        resume.item_id = any (p_item_ids)
        and resume.checkpoint_id is not null
    )
  into v_has_checkpoint;

  select
    count(*)
  into v_time_rows
  from
    ledger_scratch.recompute_row q
    join ledger_scratch.replay_resume resume on resume.item_id = q.item_id
  where
    not q.is_pending
    and q.item_id = any (p_item_ids)
    and resume.checkpoint_id is not null
    and q.occurred_at > resume.cut_occurred_at;

  select
    count(*)
  into v_id_rows
  from
    ledger_scratch.recompute_row q
    join ledger_scratch.replay_resume resume on resume.item_id = q.item_id
  where
    not q.is_pending
    and q.item_id = any (p_item_ids)
    and resume.checkpoint_id is not null
    and q.movement_id > resume.max_movement_id;

  select
    count(*)
  into v_def_rows
  from
    ledger_scratch.recompute_def d
  where
    d.item_id = any (p_item_ids);

  if v_has_checkpoint then
    select
      count(*)
    into v_prefix_rows
    from
      ledger_scratch.recompute_row q
      join ledger_scratch.replay_resume resume on resume.item_id = q.item_id
    where
      not q.is_pending
      and q.item_id = any (p_item_ids)
      and resume.checkpoint_id is not null
      and q.occurred_at <= resume.cut_occurred_at
      and q.movement_id <= resume.max_movement_id;

    select
      coalesce(string_agg(saved.plan, ''), ''),
      coalesce(sum(saved.buffers), 0)
    into
      v_def_plan,
      v_def_buffers
    from
      ledger_scratch.replay_restore_plan saved
      join ledger_scratch.replay_resume resume on resume.checkpoint_id = saved.checkpoint_id
    where
      resume.item_id = any (p_item_ids);

    for v_resume in
      select
        resume.item_id,
        resume.checkpoint_id,
        resume.cut_occurred_at,
        resume.max_movement_id
      from
        ledger_scratch.replay_resume resume
      where
        resume.item_id = any (p_item_ids)
        and resume.checkpoint_id is not null
    loop
      for v_line in execute format(
        $explain$
        explain (format text)
        select sm.id
        from app.stock_movements sm
        where sm.item_id = %1$L
          and sm.occurred_at > %2$L::timestamptz
          and sm.movement_type <> 'cost_adjustment'
          and sm.reverses_movement_id is null
          and sm.movement_type not in ('sale_reversal', 'waste_reversal')
          and not exists (
            select 1 from app.stock_movements rev
            where rev.reverses_movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_lines linked
            where linked.movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_postings posting
            where posting.movement_id = sm.id
          )
        $explain$,
        v_resume.item_id,
        v_resume.cut_occurred_at
      )
      loop
        v_time_plan := v_time_plan || v_line."QUERY PLAN" || e'\n';
      end loop;

      for v_line in execute format(
        $explain$
        explain (format text)
        select sm.id
        from app.stock_movements sm
        where sm.item_id = %1$L
          and sm.id > %2$L::bigint
          and sm.movement_type <> 'cost_adjustment'
          and sm.reverses_movement_id is null
          and sm.movement_type not in ('sale_reversal', 'waste_reversal')
          and not exists (
            select 1 from app.stock_movements rev
            where rev.reverses_movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_lines linked
            where linked.movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_postings posting
            where posting.movement_id = sm.id
          )
        $explain$,
        v_resume.item_id,
        v_resume.max_movement_id
      )
      loop
        v_id_plan := v_id_plan || v_line."QUERY PLAN" || e'\n';
      end loop;
    end loop;
  end if;

  insert into
    app.replay_read_probe (
      time_arm_rows,
      id_arm_rows,
      deficit_rows,
      time_arm_plan,
      id_arm_plan,
      deficit_plan,
      time_arm_index,
      id_arm_index,
      deficit_index,
      prefix_rows,
      deficit_buffers
    )
  values
    (
      v_time_rows,
      v_id_rows,
      v_def_rows,
      v_time_plan,
      v_id_plan,
      v_def_plan,
      app.replay_plan_uses_movement_index (v_time_plan),
      app.replay_plan_uses_movement_index (v_id_plan),
      app.replay_plan_uses_deficit_index (v_def_plan),
      v_prefix_rows,
      v_def_buffers
    );
end;
$$;

comment on function app.replay_capture_read (uuid[]) is 'While app.replay_probe is 1, record the suffix rows just loaded, the deficits restored before the walk, the suffix plans, and the plan and buffers of the restore insert that already ran. prefix_rows counts frozen prefix rows loaded into the walk.';

revoke all on function app.replay_capture_read (uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_note_probe_ms () returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  if coalesce(pg_catalog.current_setting('app.replay_probe', true), '') <> '1' then
    return;
  end if;

  if coalesce(pg_catalog.current_setting('app.replay_probe_t0', true), '') = '' then
    return;
  end if;

  update app.replay_read_probe probe
  set
    replay_ms = pg_catalog.round(
      extract(
        epoch
        from
          pg_catalog.clock_timestamp() - pg_catalog.current_setting('app.replay_probe_t0', true)::timestamptz
      ) * 1000,
      3
    )
  where
    probe.id = (
      select
        max(latest.id)
      from
        app.replay_read_probe latest
    );
end;
$$;

comment on function app.replay_note_probe_ms () is 'Stamp the latest probe row with the confirming replay''s elapsed milliseconds.';

revoke all on function app.replay_note_probe_ms ()
from
  public,
  anon,
  authenticated,
  service_role;

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

  if coalesce(pg_catalog.current_setting('app.replay_probe', true), '') = '1' then
    perform pg_catalog.set_config('app.replay_probe_t0', pg_catalog.clock_timestamp()::text, true);
  end if;

  perform app.replay_prepare_tables ();

  perform app.replay_note_window ();

  perform app.replay_bind_resume (p_item_ids, p_pending);

  insert into
    ledger_scratch.recompute_bal (
      item_id,
      on_hand_qty,
      on_hand_value,
      avg_cost,
      has_uncovered_deficit,
      cost_known
    )
  select distinct
    t.item_id,
    coalesce(resume.on_hand_qty, 0),
    coalesce(resume.on_hand_value, 0),
    coalesce(resume.avg_cost, 0),
    coalesce(resume.has_uncovered_deficit, false),
    coalesce(resume.cost_known, false)
  from
    pg_catalog.unnest(p_item_ids) as t (item_id)
    left join ledger_scratch.replay_resume resume on resume.item_id = t.item_id
  where
    t.item_id is not null;

  -- The join below cannot see that a checkpoint already covers the item, so
  -- it would hash the whole ledger and throw the rows away. Skip it then.
  if exists (
    select
      1
    from
      ledger_scratch.replay_resume resume
    where
      resume.checkpoint_id is null
      and resume.item_id = any (p_item_ids)
  ) then
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
    (
      select
        sm.*
      from
        app.stock_movements sm
        join ledger_scratch.replay_resume resume on resume.item_id = sm.item_id
      where
        resume.checkpoint_id is null
        and sm.item_id = any (p_item_ids)
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
        )
    ) sm;
  end if;

  -- A joined cut is a runtime column, so the planner hashes the whole ledger.
  -- Literals let each arm range-scan stock_movements. UNION keeps a row that
  -- is past the cut by time or by id exactly once.
  for r in
    select
      resume.item_id,
      resume.cut_occurred_at,
      resume.max_movement_id
    from
      ledger_scratch.replay_resume resume
    where
      resume.checkpoint_id is not null
      and resume.item_id = any (p_item_ids)
  loop
    execute format(
      $load$
      insert into ledger_scratch.recompute_row (
        movement_id, is_pending, batch_id, item_id, movement_type, occurred_at,
        quantity, unit_cost, total_cost, is_input_total, shift_id, source_type,
        source_id, note, ord_class, line_key, consumed, event_position,
        piece_position, engine_valued
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
            select 1 from app.stock_count_lines scl where scl.movement_id = sm.id
          ) then 1
          else 0
        end,
        0,
        false,
        coalesce(sm.event_position, sm.id),
        coalesce(sm.piece_position, 0),
        coalesce(sm.engine_valued, false)
      from (
        select sm.*
        from app.stock_movements sm
        where sm.item_id = %1$L
          and sm.occurred_at > %2$L::timestamptz
          and sm.movement_type <> 'cost_adjustment'
          and sm.reverses_movement_id is null
          and sm.movement_type not in ('sale_reversal', 'waste_reversal')
          and not exists (
            select 1 from app.stock_movements rev
            where rev.reverses_movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_lines linked
            where linked.movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_postings posting
            where posting.movement_id = sm.id
          )
        union
        select sm.*
        from app.stock_movements sm
        where sm.item_id = %1$L
          and sm.id > %3$L::bigint
          and sm.movement_type <> 'cost_adjustment'
          and sm.reverses_movement_id is null
          and sm.movement_type not in ('sale_reversal', 'waste_reversal')
          and not exists (
            select 1 from app.stock_movements rev
            where rev.reverses_movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_lines linked
            where linked.movement_id = sm.id
          )
          and not exists (
            select 1 from app.stock_count_postings posting
            where posting.movement_id = sm.id
          )
      ) sm
      $load$,
      r.item_id,
      r.cut_occurred_at,
      r.max_movement_id
    );
  end loop;

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

  -- The cap is the suffix this call loads. Anchors already inside the
  -- checkpoint are not read and do not count.
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
      join ledger_scratch.replay_resume resume on resume.item_id = anchor.item_id
    where
      anchor.item_id = any (p_item_ids)
      and (
        resume.checkpoint_id is null
        or anchor.counted_at > resume.cut_occurred_at
      )
  ) > 100000
  and not app.replay_cap_waived (p_item_ids) then
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
    join ledger_scratch.replay_resume resume on resume.item_id = anchor.item_id
  where
    anchor.item_id = any (p_item_ids)
    and (
      resume.checkpoint_id is null
      or anchor.counted_at > resume.cut_occurred_at
    );

  perform app.replay_capture_read (p_item_ids);

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

    if r.movement_type = 'closed_period'::app.movement_type then
      perform app.replay_apply_closed_period (
        r.movement_id,
        r.item_id,
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

      perform app.note_recognized_cover (e.movement_id, - v_diff);

      perform app.invalidate_checkpoints_from (e.item_id, e.occurred_at, 'cost_adjustment');
    end if;
  end loop;

  perform app.settle_count_anchors (p_cause, p_item_ids);

  -- A deficit from before the window is carried by a closed_period row at the
  -- inflow. The walk already added that adjustment once. Post the delta here,
  -- before the ledger-sum check, so the carrier is part of the same cut.
  perform app.replay_write_cover_pairs (p_cause);

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

  perform app.replay_write_cover_pairs (p_cause);

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

  perform app.replay_publish_checkpoints (p_item_ids);

  perform app.replay_note_probe_ms ();
exception
  when numeric_value_out_of_range then
    perform app.raise_recompute_failure ('critical');
end;
$$;

create or replace function app.replay_inflow (
  p_movement_id bigint,
  p_item_id uuid,
  p_type app.movement_type,
  p_occurred_at timestamptz,
  p_in_qty numeric,
  p_unit_cost numeric,
  p_total_cost numeric,
  p_is_pending boolean,
  p_line_key integer,
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_pre_qty numeric(20, 6);
  v_pre_value numeric(14, 2);
  v_pre_avg numeric(20, 6);
  v_known boolean;
  v_unit numeric(20, 6);
  v_total numeric(14, 2);
  v_delta numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_remaining_value numeric(14, 2);
  v_covered_qty numeric(20, 6);
  v_covered_inflow numeric(14, 2);
  v_covered_prov numeric(14, 2);
  v_adj numeric(14, 2);
  v_prior_pos numeric(20, 6);
  v_value_after numeric(14, 2);
  v_new_avg numeric(20, 6);
  r_def record;
  v_own bigint;
begin
  if p_type = 'closed_period'::app.movement_type then
    declare
      v_kind app.movement_type;
    begin
      select
        coalesce(sm.closed_economic_kind, 'purchase')::app.movement_type
      into v_kind
      from
        app.stock_movements sm
      where
        sm.id = p_movement_id;

      if found
      and v_kind is not null then
        p_type := v_kind;
      end if;
    end;
  end if;

  select
    b.on_hand_qty,
    b.on_hand_value,
    b.avg_cost,
    b.cost_known
  into
    v_pre_qty,
    v_pre_value,
    v_pre_avg,
    v_known
  from
    ledger_scratch.recompute_bal b
  where
    b.item_id = p_item_id;

  v_known := coalesce(v_known, false);

  if p_type = 'count_adjustment' then
    v_unit := app.assert_recompute_range (v_pre_avg, 6, false);
    v_total := app.assert_recompute_range (pg_catalog.round(p_in_qty * v_unit, 2), 2, false);
  else
    v_unit := app.assert_recompute_range (p_unit_cost, 6, false);
    v_total := app.assert_recompute_range (p_total_cost, 2, false);
  end if;

  v_delta := v_total;
  v_remaining_qty := p_in_qty;
  v_remaining_value := v_total;

  -- Q6. A return cancels every outstanding deficit of the returned source
  -- before FIFO. The named movement may be an earlier covered row of the
  -- same order; the deficits opened by a later increase of that source
  -- still belong to it. The agreed value is already this row's total, so
  -- that slice does not post another adjustment. Only the quantity still
  -- remaining enters the ordinary cover loop.
  select
    src.source_id::bigint
  into v_own
  from
    app.closed_period_sources src
  where
    src.movement_id = p_movement_id
    and src.source_kind = 'return'
    and src.source_id ~ '^[0-9]+$';

  if v_own is not null
  and v_remaining_qty > 0 then
    for r_def in
      select
        d.movement_id,
        d.qty_uncovered,
        d.value_uncovered,
        d.provisional_unit_cost,
        d.occurred_at
      from
        ledger_scratch.recompute_def d
      where
        d.item_id = p_item_id
        and d.qty_uncovered > 0
        and (
          d.movement_id = v_own
          or exists (
            select
              1
            from
              app.order_cost_movement_links mine
              join app.order_cost_movement_links sibling on sibling.order_id = mine.order_id
              and sibling.item_id = mine.item_id
            where
              mine.movement_id = v_own
              and sibling.movement_id = d.movement_id
          )
          or exists (
            select
              1
            from
              app.closed_period_sources mine
              join app.closed_period_sources sibling on sibling.source_kind = mine.source_kind
              and sibling.source_id = mine.source_id
              and sibling.source_kind in ('order', 'waste')
            where
              mine.movement_id = v_own
              and sibling.movement_id = d.movement_id
          )
          or exists (
            select
              1
            from
              app.waste_line_movements mine
              join app.waste_line_movements sibling on sibling.document_id = mine.document_id
            where
              mine.movement_id = v_own
              and sibling.movement_id = d.movement_id
          )
        )
      order by
        d.occurred_at asc,
        d.ord_class asc,
        d.event_position asc,
        d.piece_position asc,
        d.movement_id asc
    loop
      exit when v_remaining_qty <= 0;

      v_covered_qty := least(v_remaining_qty, r_def.qty_uncovered);

      if v_covered_qty = v_remaining_qty then
        v_covered_inflow := v_remaining_value;
      else
        v_covered_inflow := pg_catalog.round(
          v_remaining_value * v_covered_qty / v_remaining_qty,
          2
        );
      end if;

      if v_covered_qty = r_def.qty_uncovered then
        v_covered_prov := r_def.value_uncovered;
      else
        v_covered_prov := pg_catalog.round(
          r_def.value_uncovered * v_covered_qty / r_def.qty_uncovered,
          2
        );
      end if;

      v_covered_inflow := app.assert_recompute_range (v_covered_inflow, 2, true);
      v_covered_prov := app.assert_recompute_range (v_covered_prov, 2, true);

      update ledger_scratch.recompute_def
      set
        qty_uncovered = qty_uncovered - v_covered_qty,
        value_uncovered = value_uncovered - v_covered_prov
      where
        movement_id = r_def.movement_id;

      v_remaining_qty := v_remaining_qty - v_covered_qty;
      v_remaining_value := v_remaining_value - v_covered_inflow;
    end loop;
  end if;

  for r_def in
    select
      d.movement_id,
      d.qty_uncovered,
      d.value_uncovered,
      d.provisional_unit_cost,
      d.occurred_at
    from
      ledger_scratch.recompute_def d
    where
      d.item_id = p_item_id
      and d.qty_uncovered > 0
    order by
      d.occurred_at asc,
      d.ord_class asc,
      d.event_position asc,
      d.piece_position asc,
      d.movement_id asc
  loop
    exit when v_remaining_qty <= 0;

    v_covered_qty := least(v_remaining_qty, r_def.qty_uncovered);

    if v_covered_qty = v_remaining_qty then
      v_covered_inflow := v_remaining_value;
    else
      v_covered_inflow := pg_catalog.round(
        v_remaining_value * v_covered_qty / v_remaining_qty,
        2
      );
    end if;

    if v_covered_qty = r_def.qty_uncovered then
      v_covered_prov := r_def.value_uncovered;
    else
      v_covered_prov := pg_catalog.round(
        r_def.value_uncovered * v_covered_qty / r_def.qty_uncovered,
        2
      );
    end if;

    v_covered_inflow := app.assert_recompute_range (v_covered_inflow, 2, true);
    v_covered_prov := app.assert_recompute_range (v_covered_prov, 2, true);
    v_adj := app.assert_recompute_range (-(v_covered_inflow - v_covered_prov), 2, true);

    update ledger_scratch.recompute_def
    set
      qty_uncovered = qty_uncovered - v_covered_qty,
      value_uncovered = value_uncovered - v_covered_prov
    where
      movement_id = r_def.movement_id;

    if coalesce(pg_catalog.current_setting('app.restatement_window_start', true), '') <> ''
    and r_def.occurred_at < pg_catalog.current_setting('app.restatement_window_start', true)::timestamptz then
      insert into
        ledger_scratch.recompute_cover_pair (
          inflow_movement_id,
          deficit_movement_id,
          covered_qty,
          value_adj
        )
      values
        (
          p_movement_id,
          r_def.movement_id,
          v_covered_qty,
          v_adj
        )
      on conflict (inflow_movement_id, deficit_movement_id) do update
      set
        covered_qty = ledger_scratch.recompute_cover_pair.covered_qty + excluded.covered_qty,
        value_adj = ledger_scratch.recompute_cover_pair.value_adj + excluded.value_adj;

      -- The carrier holds the new cover. Covers already in the frozen prefix
      -- stay on the deficit, the same way an in-window resume seeds them, so
      -- this write does not reverse a legitimate earlier adjustment.
      insert into
        ledger_scratch.recompute_effect (
          movement_id,
          item_id,
          movement_type,
          base_total,
          unit_cost,
          cover_total
        )
      select
        sm.id,
        sm.item_id,
        sm.movement_type,
        sm.total_cost,
        coalesce(sm.unit_cost, 0),
        coalesce(
          (
            select
              sum(adjustment.total_cost)
            from
              app.stock_movements adjustment
            where
              adjustment.adjusts_movement_id = sm.id
              and adjustment.movement_type = 'cost_adjustment'::app.movement_type
          ),
          0
        )
      from
        app.stock_movements sm
      where
        sm.id = r_def.movement_id
        and not exists (
          select
            1
          from
            ledger_scratch.recompute_effect existing
          where
            existing.movement_id = sm.id
        );
    else
      -- A resume does not re-walk the deficit, so its effect row is absent.
      -- The stored total omits covers already posted. Start from those
      -- adjustments so this walk adds only the new cover.
      insert into
        ledger_scratch.recompute_effect (
          movement_id,
          item_id,
          movement_type,
          base_total,
          unit_cost,
          cover_total
        )
      select
        sm.id,
        sm.item_id,
        sm.movement_type,
        sm.total_cost,
        coalesce(sm.unit_cost, 0),
        coalesce(
          (
            select
              sum(adjustment.total_cost)
            from
              app.stock_movements adjustment
            where
              adjustment.adjusts_movement_id = sm.id
              and adjustment.movement_type = 'cost_adjustment'::app.movement_type
          ),
          0
        )
      from
        app.stock_movements sm
      where
        sm.id = r_def.movement_id
        and not exists (
          select
            1
          from
            ledger_scratch.recompute_effect existing
          where
            existing.movement_id = sm.id
        );

      update ledger_scratch.recompute_effect
      set
        cover_total = app.assert_recompute_range (cover_total + v_adj, 2, true)
      where
        movement_id = r_def.movement_id;
    end if;

    v_remaining_qty := v_remaining_qty - v_covered_qty;
    v_remaining_value := v_remaining_value - v_covered_inflow;
    v_delta := app.assert_recompute_range (v_delta + v_adj, 2, true);
  end loop;

  v_prior_pos := greatest(v_pre_qty, 0::numeric);
  v_value_after := case
    when v_pre_qty > 0 then greatest(v_pre_value, 0::numeric)
    else 0::numeric
  end;

  if v_prior_pos + v_remaining_qty > 0 then
    v_new_avg := pg_catalog.round(
      (v_value_after + v_remaining_value) / (v_prior_pos + v_remaining_qty),
      6
    );
  elsif p_type in ('purchase', 'sort_in')
  or (
    p_type = 'opening'
    and v_unit > 0
  ) then
    v_new_avg := v_unit;
  else
    v_new_avg := v_pre_avg;
  end if;

  v_new_avg := app.assert_recompute_range (v_new_avg, 6, false);

  if p_type in ('purchase', 'sort_in', 'opening') then
    v_known := true;
  end if;

  if p_is_pending then
    insert into
      ledger_scratch.recompute_piece (
        line_key,
        piece_no,
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
        p_line_key,
        1,
        p_item_id,
        p_type,
        p_occurred_at,
        p_in_qty,
        v_unit,
        v_total,
        false,
        p_shift_id,
        p_source_type,
        p_source_id,
        p_note
      );
  else
    insert into
      ledger_scratch.recompute_effect (
        movement_id,
        item_id,
        movement_type,
        base_total,
        unit_cost,
        cover_total
      )
    values
      (
        p_movement_id,
        p_item_id,
        p_type,
        v_total,
        v_unit,
        0
      );
  end if;

  update ledger_scratch.recompute_bal
  set
    on_hand_qty = on_hand_qty + p_in_qty,
    on_hand_value = app.assert_recompute_range (v_pre_value + v_delta, 2, true),
    avg_cost = v_new_avg,
    cost_known = v_known
  where
    item_id = p_item_id;

  perform app.replay_touch_deficit_flag (p_item_id);
end;
$$;

create function app.closed_unit_cost (p_item_id uuid) returns numeric language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      (
        select
          balance.avg_cost
        from
          app.item_balances balance
        where
          balance.item_id = p_item_id
          and balance.avg_cost > 0
      ),
      (
        select
          seed.unit_cost
        from
          app.item_provisional_seeds seed
        where
          seed.item_id = p_item_id
      ),
      (
        select
          price.unit_cost
        from
          app.item_opening_prices price
        where
          price.item_id = p_item_id
          and price.superseded_change_id is null
      )
    );
$$;

comment on function app.closed_unit_cost (uuid) is 'Average when it is positive, otherwise the provisional seed, otherwise the opening price. Null when this item has no cost basis.';

-- Kept here so the three closed posters share one rule. Retained quantity
-- keeps the value already recognized. Only added quantity uses today's unit.
-- A reduction returns its share of the posted value, not today's price.
create function app.closed_required_value (
  p_recognized_qty numeric,
  p_recognized_amount numeric,
  p_required_qty numeric,
  p_unit numeric
) returns numeric language plpgsql immutable
set
  search_path = '' as $$
declare
  v_recognized_qty numeric := coalesce(p_recognized_qty, 0);
  v_recognized_amount numeric := coalesce(p_recognized_amount, 0);
  v_required_qty numeric := coalesce(p_required_qty, 0);
  v_removed numeric;
begin
  if v_required_qty >= v_recognized_qty then
    if v_required_qty = v_recognized_qty then
      return pg_catalog.round(v_recognized_amount, 2);
    end if;

    if p_unit is null then
      return null;
    end if;

    return pg_catalog.round(
      v_recognized_amount + pg_catalog.round((v_required_qty - v_recognized_qty) * p_unit, 2),
      2
    );
  end if;

  if v_recognized_qty = 0 then
    return 0;
  end if;

  v_removed := v_recognized_qty - v_required_qty;

  return pg_catalog.round(
    v_recognized_amount - pg_catalog.round(v_recognized_amount * v_removed / v_recognized_qty, 2),
    2
  );
end;
$$;

comment on function app.closed_required_value (numeric, numeric, numeric, numeric) is 'Required value of a closed contribution. Retained quantity keeps its posted value. Additions use today''s unit. Reductions return the posted share. Null when an addition has no unit.';

revoke all on function app.closed_required_value (numeric, numeric, numeric, numeric)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.closed_unit_cost (uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_recognized_delta (
  p_cause uuid,
  p_source_kind text,
  p_source_id text,
  p_item_id uuid,
  p_bucket text,
  p_economic text,
  p_required_qty numeric,
  p_required_value numeric,
  p_reason text,
  p_report text,
  p_waste_chain uuid,
  p_return_movement bigint,
  p_span_id bigint,
  p_piece integer
) returns bigint language plpgsql security definer
set
  search_path = '' as $$
declare
  v_qty numeric(20, 6);
  v_amount numeric(14, 2);
  v_delta_qty numeric(20, 6);
  v_delta_value numeric(14, 2);
  v_change timestamptz;
  v_kind text;
  v_source text;
  v_id bigint;
begin
  v_change := app.note_change_instant ();

  select
    contribution.quantity,
    contribution.amount
  into
    v_qty,
    v_amount
  from
    app.recognized_contribution contribution
  where
    contribution.source_kind = p_source_kind
    and contribution.source_id = p_source_id
    and contribution.item_id = p_item_id
    and contribution.bucket = p_bucket
  for update;

  v_qty := coalesce(v_qty, 0);
  v_amount := coalesce(v_amount, 0);
  v_delta_qty := p_required_qty - v_qty;
  v_delta_value := pg_catalog.round(p_required_value - v_amount, 2);

  if v_delta_qty <> 0
  or v_delta_value <> 0 then
    if v_delta_qty < 0
    and p_return_movement is not null then
      v_kind := 'return';
      v_source := p_return_movement::text;
    else
      v_kind := p_source_kind;
      v_source := p_source_id;
    end if;

    v_id := app.insert_closed_movement (
      p_cause,
      p_item_id,
      v_change,
      -v_delta_qty,
      -v_delta_value,
      p_bucket,
      p_economic,
      app.closed_containing_shift (v_change),
      v_kind,
      v_source,
      p_reason,
      p_report,
      p_waste_chain,
      null,
      null,
      0,
      coalesce(p_piece, 0)
    );
  end if;

  insert into
    app.recognized_contribution (source_kind, source_id, item_id, bucket, quantity, amount)
  values
    (
      p_source_kind,
      p_source_id,
      p_item_id,
      p_bucket,
      p_required_qty,
      pg_catalog.round(p_required_value, 2)
    )
  on conflict (source_kind, source_id, item_id, bucket) do update
  set
    quantity = excluded.quantity,
    amount = excluded.amount;

  perform app.record_accrual_version (
    p_span_id,
    null,
    app.restatement_window_start (),
    null,
    null,
    p_source_kind,
    p_source_id,
    p_item_id,
    p_required_qty,
    pg_catalog.round(p_required_value, 2)
  );

  return v_id;
end;
$$;

comment on function app.post_recognized_delta (
  uuid,
  text,
  text,
  uuid,
  text,
  text,
  numeric,
  numeric,
  text,
  text,
  uuid,
  bigint,
  bigint,
  integer
) is 'Post required minus the recognized quantity and value, then store both. A reduction is a return so that source''s own deficits are cancelled before FIFO. The shift is the one that contains t_change, or null.';

revoke all on function app.post_recognized_delta (
  uuid,
  text,
  text,
  uuid,
  text,
  text,
  numeric,
  numeric,
  text,
  text,
  uuid,
  bigint,
  bigint,
  integer
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.note_recognized_cover (p_movement_id bigint, p_consumption_delta numeric) returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  if coalesce(p_consumption_delta, 0) = 0 then
    return;
  end if;

  update app.recognized_contribution contribution
  set
    amount = pg_catalog.round(contribution.amount + p_consumption_delta, 2)
  from
    app.stock_movements sm
  where
    sm.id = p_movement_id
    and contribution.item_id = sm.item_id
    and contribution.bucket = case
      when sm.movement_type = 'waste'::app.movement_type
      or sm.closed_bucket = 'waste' then 'waste'
      else 'cogs'
    end
    and (
      (
        contribution.source_kind = 'order'
        and exists (
          select
            1
          from
            app.order_cost_movement_links link
          where
            link.movement_id = sm.id
            and link.order_id = contribution.source_id
        )
      )
      or (
        contribution.source_kind = 'waste'
        and exists (
          select
            1
          from
            app.closed_period_sources src
          where
            src.movement_id = sm.id
            and src.source_kind = 'waste'
            and src.source_id = contribution.source_id
        )
      )
    );
end;
$$;

comment on function app.note_recognized_cover (bigint, numeric) is 'Add a cover or restatement adjustment to the recognized value of the pieces it changes, in the same transaction. Quantity stays. A later return then restores the covered value.';

revoke all on function app.note_recognized_cover (bigint, numeric)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.seed_order_recognized (p_order_id text) returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  insert into
    app.recognized_contribution (source_kind, source_id, item_id, bucket, quantity, amount)
  select
    'order',
    p_order_id,
    priced.item_id,
    priced.bucket,
    priced.quantity,
    priced.amount
  from
    (
      select
        priced.item_id,
        priced.bucket,
        coalesce(sum(-priced.quantity), 0) as quantity,
        coalesce(sum(-priced.total_cost), 0) as amount
      from
        (
          select
            sm.item_id,
            case
              when sm.movement_type = 'waste'::app.movement_type
              or sm.closed_bucket = 'waste' then 'waste'
              else 'cogs'
            end as bucket,
            sm.quantity,
            sm.total_cost
          from
            app.order_cost_movement_links link
            join app.order_cost_state head on head.order_id = link.order_id
            and head.owner_application_id = link.application_id
            join app.stock_movements sm on sm.id = link.movement_id
          where
            link.order_id = p_order_id
            and sm.movement_type <> 'cost_adjustment'::app.movement_type
          union all
          select
            sm.item_id,
            case
              when sm.movement_type = 'waste'::app.movement_type
              or sm.closed_bucket = 'waste' then 'waste'
              else 'cogs'
            end as bucket,
            0,
            adjustment.total_cost
          from
            app.order_cost_movement_links link
            join app.order_cost_state head on head.order_id = link.order_id
            and head.owner_application_id = link.application_id
            join app.stock_movements sm on sm.id = link.movement_id
            join app.stock_movements adjustment on adjustment.adjusts_movement_id = sm.id
            and adjustment.movement_type = 'cost_adjustment'::app.movement_type
          where
            link.order_id = p_order_id
            and sm.movement_type <> 'cost_adjustment'::app.movement_type
        ) priced
      group by
        priced.item_id,
        priced.bucket
    ) priced
  on conflict (source_kind, source_id, item_id, bucket) do nothing;
end;
$$;

comment on function app.seed_order_recognized (text) is 'The live owner posting, including cost adjustments already attached to those pieces, is the recognized contribution when this order has no row yet. A later edit posts only the difference.';

revoke all on function app.seed_order_recognized (text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_closed_order_difference (
  p_order_id text,
  p_requirements jsonb,
  p_bucket text,
  p_economic text,
  p_cause uuid default null
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_cause uuid;
  v_elem jsonb;
  v_item uuid;
  v_qty numeric(20, 6);
  v_unit numeric(20, 6);
  v_rec_qty numeric(20, 6);
  v_rec_amt numeric(14, 2);
  v_value numeric(14, 2);
  v_needs jsonb := '[]'::jsonb;
  v_missing boolean := false;
  v_piece integer := 0;
  v_posted boolean := false;
  v_move bigint;
  v_prior bigint;
  v_row record;
  v_items uuid[] := '{}'::uuid[];
  v_other text;
begin
  perform app.assert_ledger_lock_held ();

  perform app.seed_order_recognized (p_order_id);

  v_cause := coalesce(p_cause, pg_catalog.gen_random_uuid ());

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(coalesce(p_requirements, '[]'::jsonb)) as elem (value)
  loop
    v_item := (v_elem ->> 'stock_item_id')::uuid;
    v_qty := (v_elem ->> 'quantity')::numeric;

    if v_item is null
    or v_qty is null
    or v_qty = 0 then
      continue;
    end if;

    -- Both buckets. A reclassification transfers the retained quantity at
    -- its posted value; only a true addition is priced at today's unit.
    select
      coalesce(sum(contribution.quantity), 0),
      coalesce(sum(contribution.amount), 0)
    into
      v_rec_qty,
      v_rec_amt
    from
      app.recognized_contribution contribution
    where
      contribution.source_kind = 'order'
      and contribution.source_id = p_order_id
      and contribution.item_id = v_item;

    v_rec_qty := coalesce(v_rec_qty, 0);
    v_rec_amt := coalesce(v_rec_amt, 0);
    v_unit := case
      when v_qty > v_rec_qty then app.closed_unit_cost (v_item)
      else null
    end;
    v_value := app.closed_required_value (v_rec_qty, v_rec_amt, v_qty, v_unit);

    if v_value is null then
      v_missing := true;
      exit;
    end if;

    v_needs := v_needs || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'item_id',
        v_item,
        'qty',
        v_qty,
        'value',
        v_value
      )
    );
  end loop;

  if v_missing then
    raise exception 'missing_cost_basis'
      using errcode = 'P0001',
      detail = 'missing_cost_basis';
  end if;

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(v_needs) as elem (value)
  loop
    v_item := (v_elem ->> 'item_id')::uuid;

    -- Prefer an outstanding deficit of this order. The earliest negative row
    -- may have been covered stock, and a return aimed at it would fall
    -- through to someone else's deficit.
    select
      sm.id
    into v_prior
    from
      app.order_cost_movement_links link
      join app.stock_movements sm on sm.id = link.movement_id
      left join app.provisional_deficits deficit on deficit.movement_id = sm.id
      and deficit.qty_uncovered > 0
    where
      link.order_id = p_order_id
      and sm.item_id = v_item
      and sm.quantity < 0
    order by
      deficit.movement_id is null,
      sm.id
    limit
      1;

    v_piece := v_piece + 1;
    v_move := app.post_recognized_delta (
      v_cause,
      'order',
      p_order_id,
      v_item,
      p_bucket,
      p_economic,
      (v_elem ->> 'qty')::numeric,
      (v_elem ->> 'value')::numeric,
      null,
      null,
      null,
      v_prior,
      null,
      v_piece
    );

    if v_move is not null then
      v_posted := true;
      v_items := v_items || v_item;
    end if;
  end loop;

  v_other := case
    when p_bucket = 'waste' then 'cogs'
    else 'waste'
  end;

  for v_row in
    select
      contribution.item_id,
      contribution.bucket
    from
      app.recognized_contribution contribution
    where
      contribution.source_kind = 'order'
      and contribution.source_id = p_order_id
      and (
        contribution.quantity <> 0
        or contribution.amount <> 0
      )
      and (
        contribution.bucket = v_other
        or (
          contribution.bucket = p_bucket
          and not exists (
            select
              1
            from
              pg_catalog.jsonb_array_elements(v_needs) as need (value)
            where
              (need.value ->> 'item_id')::uuid = contribution.item_id
          )
        )
      )
  loop
    select
      sm.id
    into v_prior
    from
      app.order_cost_movement_links link
      join app.stock_movements sm on sm.id = link.movement_id
      left join app.provisional_deficits deficit on deficit.movement_id = sm.id
      and deficit.qty_uncovered > 0
    where
      link.order_id = p_order_id
      and sm.item_id = v_row.item_id
      and sm.quantity < 0
    order by
      deficit.movement_id is null,
      sm.id
    limit
      1;

    v_piece := v_piece + 1;
    v_move := app.post_recognized_delta (
      v_cause,
      'order',
      p_order_id,
      v_row.item_id,
      v_row.bucket,
      case
        when v_row.bucket = 'waste' then 'waste'
        else 'sale'
      end,
      0,
      0,
      null,
      null,
      null,
      v_prior,
      null,
      v_piece
    );

    if v_move is not null then
      v_posted := true;
      v_items := v_items || v_row.item_id;
    end if;
  end loop;

  if v_posted and p_cause is null then
    perform app.finish_closed_cause (
      v_cause,
      (
        select
          coalesce(pg_catalog.array_agg(distinct item_id), '{}'::uuid[])
        from
          pg_catalog.unnest(v_items) as item (item_id)
      )
    );
  end if;

  if v_posted then
    return v_cause;
  end if;

  return null;
end;
$$;

comment on function app.post_closed_order_difference (text, jsonb, text, text, uuid) is 'Post the difference between an order''s required contribution and the contribution already recognized. The original rows stay. A full return uses an empty requirement list. A span passes one cause and finishes that cause once after every order has posted.';

revoke all on function app.post_closed_order_difference (text, jsonb, text, text, uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.apply_closed_waste_delta (
  p_predecessor bigint,
  p_lines jsonb,
  p_void boolean,
  p_reason text
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_root bigint;
  v_next bigint;
  v_cause uuid;
  v_elem jsonb;
  v_item uuid;
  v_qty numeric(20, 6);
  v_unit numeric(20, 6);
  v_rec_qty numeric(20, 6);
  v_rec_amt numeric(14, 2);
  v_value numeric(14, 2);
  v_retained numeric(14, 2);
  v_needs jsonb := '[]'::jsonb;
  v_piece integer := 0;
  v_posted boolean := false;
  v_move bigint;
  v_prior bigint;
  v_row record;
  v_items uuid[] := '{}'::uuid[];
  v_change timestamptz;
  v_shift text;
  v_old_reason text;
  v_chain uuid;
begin
  perform app.assert_ledger_write_allowed ();

  v_root := p_predecessor;

  loop
    select
      document.predecessor_id
    into v_next
    from
      app.waste_documents document
    where
      document.id = v_root;

    exit when v_next is null;

    v_root := v_next;
  end loop;

  insert into
    app.recognized_contribution (source_kind, source_id, item_id, bucket, quantity, amount)
  with recursive
    chain as (
      select
        document.id
      from
        app.waste_documents document
      where
        document.id = v_root
      union all
      select
        document.id
      from
        app.waste_documents document
        join chain on document.predecessor_id = chain.id
    ),
    base as (
      select
        sm.id,
        sm.item_id,
        sm.quantity,
        sm.total_cost
      from
        chain
        join app.waste_line_movements link on link.document_id = chain.id
        join app.stock_movements sm on sm.id = link.movement_id
      where
        sm.movement_type <> 'cost_adjustment'::app.movement_type
      union all
      select
        sm.id,
        sm.item_id,
        sm.quantity,
        sm.total_cost
      from
        app.closed_period_sources src
        join app.stock_movements sm on sm.id = src.movement_id
      where
        src.source_kind = 'waste'
        and src.source_id = v_root::text
        and sm.movement_type <> 'cost_adjustment'::app.movement_type
    ),
    reversal as (
      select
        rev.id,
        base.item_id,
        rev.quantity,
        rev.total_cost
      from
        base
        join app.stock_movements rev on rev.reverses_movement_id = base.id
    ),
    adjustment as (
      select
        piece.item_id,
        0::numeric as quantity,
        ca.total_cost
      from
        (
          select
            base.id,
            base.item_id
          from
            base
          union all
          select
            reversal.id,
            reversal.item_id
          from
            reversal
        ) piece
        join app.stock_movements ca on ca.adjusts_movement_id = piece.id
        and ca.movement_type = 'cost_adjustment'::app.movement_type
    )
  select
    'waste',
    v_root::text,
    net.item_id,
    'waste',
    coalesce(sum(-net.quantity), 0),
    coalesce(sum(-net.total_cost), 0)
  from
    (
      select
        base.item_id,
        base.quantity,
        base.total_cost
      from
        base
      union all
      select
        reversal.item_id,
        reversal.quantity,
        reversal.total_cost
      from
        reversal
      union all
      select
        adjustment.item_id,
        adjustment.quantity,
        adjustment.total_cost
      from
        adjustment
    ) net
  group by
    net.item_id
  on conflict (source_kind, source_id, item_id, bucket) do nothing;

  if not p_void then
    for v_elem in
      select
        elem.value
      from
        pg_catalog.jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as elem (value)
    loop
      v_item := (v_elem ->> 'item_id')::uuid;
      v_qty := (v_elem ->> 'base_quantity')::numeric;

      if v_item is null
      or v_qty is null
      or v_qty = 0 then
        continue;
      end if;

      select
        contribution.quantity,
        contribution.amount
      into
        v_rec_qty,
        v_rec_amt
      from
        app.recognized_contribution contribution
      where
        contribution.source_kind = 'waste'
        and contribution.source_id = v_root::text
        and contribution.item_id = v_item
        and contribution.bucket = 'waste';

      v_rec_qty := coalesce(v_rec_qty, 0);
      v_rec_amt := coalesce(v_rec_amt, 0);
      v_unit := case
        when v_qty > v_rec_qty then app.closed_unit_cost (v_item)
        else null
      end;
      v_value := app.closed_required_value (v_rec_qty, v_rec_amt, v_qty, v_unit);

      if v_value is null then
        raise exception 'missing_cost_basis'
          using errcode = 'P0001',
          detail = 'missing_cost_basis';
      end if;

      v_needs := v_needs || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id',
          v_item,
          'qty',
          v_qty,
          'value',
          v_value,
          'recognized_qty',
          v_rec_qty,
          'recognized_amount',
          v_rec_amt
        )
      );
    end loop;
  end if;

  v_cause := pg_catalog.gen_random_uuid ();
  v_change := app.note_change_instant ();
  v_shift := app.closed_containing_shift (v_change);

  select
    document.reason_code,
    root.request_id
  into
    v_old_reason,
    v_chain
  from
    app.waste_documents document
    join app.waste_documents root on root.id = v_root
  where
    document.id = p_predecessor;

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(v_needs) as elem (value)
  loop
    v_item := (v_elem ->> 'item_id')::uuid;

    select
      sm.id
    into v_prior
    from
      app.stock_movements sm
    where
      sm.item_id = v_item
      and sm.quantity < 0
      and (
        exists (
          select
            1
          from
            app.waste_line_movements link
          where
            link.movement_id = sm.id
            and link.document_id = v_root
        )
        or exists (
          select
            1
          from
            app.closed_period_sources src
          where
            src.movement_id = sm.id
            and src.source_kind = 'waste'
            and src.source_id = v_root::text
        )
      )
    order by
      sm.id
    limit
      1;

    v_piece := v_piece + 1;

    -- A reason change rebooks the line. The whole posted value comes back on
    -- the old reason; the new quantity, including an addition, goes out on
    -- the new reason. A quantity-only edit keeps one delta.
    if not p_void
    and p_reason is distinct from v_old_reason
    and (
      (v_elem ->> 'qty')::numeric is distinct from coalesce((v_elem ->> 'recognized_qty')::numeric, 0)
      or (v_elem ->> 'value')::numeric is distinct from coalesce((v_elem ->> 'recognized_amount')::numeric, 0)
    ) then
      v_move := app.post_recognized_delta (
        v_cause,
        'waste',
        v_root::text,
        v_item,
        'waste',
        'waste',
        0,
        0,
        v_old_reason,
        'manual',
        v_chain,
        v_prior,
        null,
        v_piece
      );

      if v_move is not null then
        v_posted := true;
        v_items := v_items || v_item;
      end if;

      v_piece := v_piece + 1;
      v_move := app.post_recognized_delta (
        v_cause,
        'waste',
        v_root::text,
        v_item,
        'waste',
        'waste',
        (v_elem ->> 'qty')::numeric,
        (v_elem ->> 'value')::numeric,
        p_reason,
        'manual',
        v_chain,
        null,
        null,
        v_piece
      );
    else
      v_move := app.post_recognized_delta (
        v_cause,
        'waste',
        v_root::text,
        v_item,
        'waste',
        'waste',
        (v_elem ->> 'qty')::numeric,
        (v_elem ->> 'value')::numeric,
        p_reason,
        'manual',
        v_chain,
        v_prior,
        null,
        v_piece
      );
    end if;

    if v_move is not null then
      v_posted := true;
      v_items := v_items || v_item;
    end if;
  end loop;

  for v_row in
    select
      contribution.item_id
    from
      app.recognized_contribution contribution
    where
      contribution.source_kind = 'waste'
      and contribution.source_id = v_root::text
      and contribution.bucket = 'waste'
      and (
        contribution.quantity <> 0
        or contribution.amount <> 0
      )
      and not exists (
        select
          1
        from
          pg_catalog.jsonb_array_elements(v_needs) as need (value)
        where
          (need.value ->> 'item_id')::uuid = contribution.item_id
      )
  loop
    select
      sm.id
    into v_prior
    from
      app.stock_movements sm
    where
      sm.item_id = v_row.item_id
      and sm.quantity < 0
      and (
        exists (
          select
            1
          from
            app.waste_line_movements link
          where
            link.movement_id = sm.id
            and link.document_id = v_root
        )
        or exists (
          select
            1
          from
            app.closed_period_sources src
          where
            src.movement_id = sm.id
            and src.source_kind = 'waste'
            and src.source_id = v_root::text
        )
      )
    order by
      sm.id
    limit
      1;

    v_piece := v_piece + 1;
    v_move := app.post_recognized_delta (
      v_cause,
      'waste',
      v_root::text,
      v_row.item_id,
      'waste',
      'waste',
      0,
      0,
      v_old_reason,
      'manual',
      v_chain,
      v_prior,
      null,
      v_piece
    );

    if v_move is not null then
      v_posted := true;
      v_items := v_items || v_row.item_id;
    end if;
  end loop;

  -- A reason change at a retained quantity is two value rows, net zero:
  -- the old reason comes back and the new reason takes it. Quantity and
  -- value deltas stay on the recognized path above.
  if not p_void
  and p_reason is distinct from v_old_reason then
    for v_row in
      select
        (need.value ->> 'item_id')::uuid as item_id,
        (need.value ->> 'qty')::numeric as quantity,
        (need.value ->> 'recognized_qty')::numeric as recognized_qty,
        (need.value ->> 'recognized_amount')::numeric as recognized_amount
      from
        pg_catalog.jsonb_array_elements(v_needs) as need (value)
      where
        coalesce((need.value ->> 'recognized_qty')::numeric, 0) > 0
        and coalesce((need.value ->> 'recognized_amount')::numeric, 0) <> 0
        and coalesce((need.value ->> 'qty')::numeric, 0) > 0
        and coalesce((need.value ->> 'qty')::numeric, 0) = coalesce((need.value ->> 'recognized_qty')::numeric, 0)
        and coalesce((need.value ->> 'value')::numeric, 0) = coalesce((need.value ->> 'recognized_amount')::numeric, 0)
    loop
      v_retained := app.closed_required_value (
        v_row.recognized_qty,
        v_row.recognized_amount,
        least(v_row.quantity, v_row.recognized_qty),
        null
      );

      if coalesce(v_retained, 0) = 0 then
        continue;
      end if;

      v_piece := v_piece + 1;

      perform app.insert_closed_movement (
        v_cause,
        v_row.item_id,
        v_change,
        0,
        v_retained,
        'waste',
        'waste',
        v_shift,
        'waste',
        v_root::text,
        v_old_reason,
        'manual',
        v_chain,
        null,
        null,
        null,
        v_piece
      );

      v_piece := v_piece + 1;

      perform app.insert_closed_movement (
        v_cause,
        v_row.item_id,
        v_change,
        0,
        -v_retained,
        'waste',
        'waste',
        v_shift,
        'waste',
        v_root::text,
        p_reason,
        'manual',
        v_chain,
        null,
        null,
        null,
        v_piece
      );

      v_posted := true;
      v_items := v_items || v_row.item_id;
    end loop;
  end if;

  if v_posted then
    perform app.finish_closed_cause (
      v_cause,
      (
        select
          coalesce(pg_catalog.array_agg(distinct item_id), '{}'::uuid[])
        from
          pg_catalog.unnest(v_items) as item (item_id)
      )
    );

    return v_cause;
  end if;

  -- An explanation-only correction and a zero-cost reason change post no
  -- movement. The document still needs a batch id.
  return v_cause;
end;
$$;

comment on function app.apply_closed_waste_delta (bigint, jsonb, boolean, text) is 'Correction or cancellation of a waste document dated before the window. The original waste rows stay. The difference is a closed contribution of the root document. A no-value correction still returns a batch id.';

revoke all on function app.apply_closed_waste_delta (bigint, jsonb, boolean, text)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_accumulated_closed_span (p_span_id bigint) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_order record;
  v_res jsonb;
  v_batch uuid;
  v_detail text;
  v_cause uuid := pg_catalog.gen_random_uuid ();
begin
  perform app.assert_ledger_lock_held ();

  if exists (
    select
      1
    from
      app.closed_span_orders accumulated
    where
      accumulated.span_id = p_span_id
      and accumulated.cause_id is not null
  )
  or not exists (
    select
      1
    from
      app.closed_span_orders accumulated
    where
      accumulated.span_id = p_span_id
      and accumulated.cause_id is null
  ) then
    return;
  end if;

  for v_order in
    select
      accumulated.order_id
    from
      app.closed_span_orders accumulated
    where
      accumulated.span_id = p_span_id
      and accumulated.cause_id is null
    order by
      accumulated.ordered_at,
      accumulated.order_id
  loop
    -- The order poster already nets confirmed returns, picks the bucket,
    -- and returns a removed item. A missing basis rolls that order back.
    begin
      perform pg_catalog.set_config('app.span_cause', v_cause::text, true);

      v_res := app.process_order_accounting (
        v_order.order_id,
        pg_catalog.gen_random_uuid (),
        1
      );
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_detail = pg_exception_detail;

        if v_detail is distinct from 'missing_cost_basis' then
          raise;
        end if;

        v_res := pg_catalog.jsonb_build_object(
          'outcome',
          'blocked',
          'reason',
          'missing_cost_basis'
        );
    end;

    if v_res ->> 'outcome' in ('applied', 'unchanged', 'none')
    and v_res ->> 'reason' is distinct from 'no_input' then
      v_batch := null;

      if v_res ? 'application_id' then
        select
          posted.posting_batch
        into v_batch
        from
          app.order_cost_applications posted
        where
          posted.id = (v_res ->> 'application_id')::bigint;
      end if;

      update app.closed_span_orders accumulated
      set
        cause_id = coalesce(v_batch, pg_catalog.gen_random_uuid ())
      where
        accumulated.span_id = p_span_id
        and accumulated.order_id = v_order.order_id;
    else
      perform app.enqueue_accounting_event (
        v_order.order_id,
        'config_span',
        'span:' || p_span_id::text || ':' || v_order.order_id,
        null,
        p_span_id
      );
    end if;
  end loop;

  -- One finish for the shared cause. Settling the same cause twice is a
  -- critical recompute, so the orders post first and the walk runs once.
  if exists (
    select
      1
    from
      app.stock_movements posted
    where
      posted.closed_cause_id = v_cause
  ) then
    perform app.finish_closed_cause (
      v_cause,
      (
        select
          coalesce(pg_catalog.array_agg(distinct posted.item_id), '{}'::uuid[])
        from
          app.stock_movements posted
        where
          posted.closed_cause_id = v_cause
      )
    );
  end if;

  perform pg_catalog.set_config('app.span_cause', '', true);
end;
$$;

comment on function app.post_accumulated_closed_span (bigint) is 'Post every pre-window order of one configuration span through the order poster, so a removed item is returned and a confirmed return is not deducted again. The orders share one cause. An order that is not ready stays on the ordinary queue and is not marked done.';

revoke all on function app.post_accumulated_closed_span (bigint)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.run_accounting_work (
  p_attempt_id uuid,
  p_limit integer,
  p_order_id text default null,
  p_work_generation integer default null
) returns jsonb language plpgsql volatile security definer
set
  search_path = ''
set
  statement_timeout = '6s'
set
  lock_timeout = '250ms' as $$
declare
  v_order text;
  v_h0 record;
  v_cur_new boolean;
  v_inserted integer;
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

  if (p_order_id is null) is distinct from (p_work_generation is null)
  or (
    p_order_id is not null
    and (
      pg_catalog.btrim (p_order_id) = ''
      or p_work_generation < 1
    )
  ) then
    raise exception 'order id and work generation are given together'
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

  if not pg_catalog.pg_try_advisory_xact_lock (7342750000000000001::bigint) then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;

  perform app.note_change_instant ();

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

  -- The one order this call may process is named before anything else runs.
  -- Work the slice below enqueues is left for the next call, so a failure of
  -- this call can only belong to the order the caller was told about.
  select
    p.order_id,
    p.eff_generation
  into v_h0
  from
    app.accounting_pending_orders (1) p;

  if p_order_id is not null
  and (
    v_h0.order_id is distinct from p_order_id
    or v_h0.eff_generation is distinct from p_work_generation
  ) then
    return pg_catalog.jsonb_build_object(
      'status',
      'stale',
      'head',
      case
        when v_h0.order_id is null then null
        else pg_catalog.jsonb_build_object(
          'order_id',
          v_h0.order_id,
          'work_generation',
          v_h0.eff_generation
        )
      end
    );
  end if;

  -- Only a call that names its order processes one. A call that names none is
  -- maintenance: it expands a span slice and returns the head, so every order
  -- that is processed has a caller who can report its failure.
  v_order := p_order_id;

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
      app.closed_span_orders (span_id, order_id, ordered_at)
    select
      v_span.id,
      v_span_orders[slice.idx],
      v_span_times[slice.idx]
    from
      pg_catalog.generate_subscripts(v_span_orders, 1) as slice (idx)
    where
      v_span_times[slice.idx] < app.restatement_window_start ()
    on conflict (span_id, order_id) do nothing;

    perform app.enqueue_accounting_event (
      v_span_orders[slice.idx],
      'config_span',
      'span:' || v_span.id::text || ':' || v_span_orders[slice.idx],
      null,
      v_span.id
    )
    from
      pg_catalog.generate_subscripts(v_span_orders, 1) as slice (idx)
    where
      v_span_times[slice.idx] >= app.restatement_window_start ()
    order by
      v_span_orders[slice.idx];

    if v_n < 100
    or exists (
      select
        1
      from
        pg_catalog.unnest(v_span_times) as reached (ordered_at)
      where
        reached.ordered_at >= app.restatement_window_start ()
    ) then
      perform app.post_accumulated_closed_span (v_span.id);
    end if;

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

  if v_order is not null then
    insert into
      app.accounting_work_state (order_id)
    values
      (v_order)
    on conflict (order_id) do nothing;

    insert into
      app.order_cost_state (order_id)
    values
      (v_order)
    on conflict (order_id) do nothing;

    perform 1
    from
      app.accounting_work_state ws
    where
      ws.order_id = v_order
    for update;

    perform 1
    from
      app.order_cost_state h
    where
      h.order_id = v_order
    for update;

    -- The slice may have added an event to this order: take the generation
    -- as it is now.
    select
      pe.has_new,
      pe.eff_generation
    into
      v_cur_new,
      v_gen
    from
      app.accounting_order_pending (v_order) pe;
  end if;

  if v_gen is not null then
    if v_cur_new then
      update app.accounting_work_events e
      set
        work_generation = v_gen
      where
        e.order_id = v_order
        and e.work_generation is null
        and (
          exists (
            select
              1
            from
              app.activation_history_loaded
          )
          or exists (
            select
              1
            from
              app.activation_history_posted posted
            where
              posted.order_id = v_order
          )
          or not exists (
            select
              1
            from
              app.activation_history_input frozen
            where
              frozen.order_id = v_order
          )
          or e.cost_input_id = (
            select
              frozen.cost_input_id
            from
              app.activation_history_input frozen
            where
              frozen.order_id = v_order
          )
          or e.cost_input_id is null
        );

      update app.accounting_work_state ws
      set
        work_generation = v_gen,
        attempts = 0,
        failed_at = null,
        updated_at = pg_catalog.clock_timestamp ()
      where
        ws.order_id = v_order;
    end if;

    begin
      v_result := app.process_order_accounting (v_order, p_attempt_id, v_gen);

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
        ws.order_id = v_order;

      update app.accounting_work_events e
      set
        processed_at = pg_catalog.clock_timestamp ()
      where
        e.order_id = v_order
        and e.work_generation is not null
        and e.work_generation <= v_gen
        and e.processed_at is null;

      -- Evidence that this call committed, for every outcome (blocked and
      -- disposition_pending leave no receipt).
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
          p_attempt_id,
          v_order,
          v_gen,
          v_result ->> 'outcome',
          (v_result ->> 'application_id')::bigint
        )
      on conflict (attempt_id) do nothing;

      if v_result ->> 'outcome' = 'applied'
      and v_result ->> 'receipt_kind' = 'posting' then
        perform app.maybe_mark_activation_loaded ();
      end if;

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
            v_order,
            v_gen,
            p_attempt_id,
            'caught',
            v_sqlstate,
            v_reason
          )
        on conflict do nothing;

        get diagnostics v_inserted = row_count;

        -- A repeated attempt id is charged once.
        if v_inserted = 1 then
          update app.accounting_work_state ws
          set
            attempts = ws.attempts + 1,
            failed_at = case
              when v_reason = 'recompute_limit' then pg_catalog.clock_timestamp ()
              when ws.attempts + 1 >= 5 then pg_catalog.clock_timestamp ()
              else ws.failed_at
            end,
            last_reason = v_reason,
            last_error_code = v_sqlstate,
            updated_at = pg_catalog.clock_timestamp ()
          where
            ws.order_id = v_order;
        end if;

        v_failed := v_failed + 1;

        if v_reason = 'critical' then
          v_critical := pg_catalog.jsonb_build_object(
            'order_id',
            v_order,
            'work_generation',
            v_gen
          );
        end if;
    end;
  end if;

  select
    p.order_id,
    p.eff_generation
  into v_head
  from
    app.accounting_pending_orders (1) p;

  select
    stats.eligible_count
  into v_remaining
  from
    app.accounting_queue_stats stats
  where
    stats.id = 1;

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

create or replace function app.record_accounting_call_failure (
  p_attempt_id uuid,
  p_order_id text,
  p_work_generation integer
) returns jsonb language plpgsql volatile security definer
set
  search_path = ''
set
  lock_timeout = '250ms' as $$
declare
  v_pending record;
  v_inserted integer;
begin
  perform app.assert_pos_write_allowed ();

  if p_attempt_id is null
  or p_order_id is null
  or pg_catalog.btrim (p_order_id) = ''
  or p_work_generation is null
  or p_work_generation < 1 then
    raise exception 'attempt id, order id and work generation are required'
      using errcode = '22023';
  end if;

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

  -- The call committed and only its reply was lost.
  if exists (
    select
      1
    from
      app.accounting_work_completions c
    where
      c.attempt_id = p_attempt_id
  )
  or exists (
    select
      1
    from
      app.accounting_attempt_progress progress
    where
      progress.attempt_id = p_attempt_id
  ) then
    return pg_catalog.jsonb_build_object('status', 'committed');
  end if;

  select
    pe.has_new,
    pe.eff_generation
  into v_pending
  from
    app.accounting_order_pending (p_order_id) pe;

  if v_pending.eff_generation is null then
    return pg_catalog.jsonb_build_object('status', 'no_work');
  end if;

  if v_pending.eff_generation is distinct from p_work_generation then
    return pg_catalog.jsonb_build_object('status', 'stale');
  end if;

  insert into
    app.accounting_work_state (order_id)
  values
    (p_order_id)
  on conflict (order_id) do nothing;

  perform 1
  from
    app.accounting_work_state ws
  where
    ws.order_id = p_order_id
  for update;

  if v_pending.has_new then
    update app.accounting_work_events e
    set
      work_generation = v_pending.eff_generation
    where
      e.order_id = p_order_id
      and e.work_generation is null;

    update app.accounting_work_state ws
    set
      work_generation = v_pending.eff_generation,
      attempts = 0,
      failed_at = null
    where
      ws.order_id = p_order_id;
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
      p_order_id,
      v_pending.eff_generation,
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
      updated_at = pg_catalog.clock_timestamp ()
    where
      ws.order_id = p_order_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    case
      when v_inserted = 1 then 'recorded'
      else 'duplicate'
    end,
    'order_id',
    p_order_id,
    'work_generation',
    v_pending.eff_generation
  );
end;
$$;

create or replace function app.record_accounting_recompute_timeout (
  p_attempt_id uuid,
  p_order_id text,
  p_work_generation integer
) returns jsonb language plpgsql volatile security definer
set
  search_path = ''
set
  lock_timeout = '250ms' as $$
declare
  v_pending record;
  v_inserted integer;
begin
  perform app.assert_pos_write_allowed ();

  if p_attempt_id is null
  or p_order_id is null
  or pg_catalog.btrim (p_order_id) = ''
  or p_work_generation is null
  or p_work_generation < 1 then
    raise exception 'attempt id, order id and work generation are required'
      using errcode = '22023';
  end if;

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

  -- The call committed and only its reply was lost.
  if exists (
    select
      1
    from
      app.accounting_work_completions c
    where
      c.attempt_id = p_attempt_id
  )
  or exists (
    select
      1
    from
      app.accounting_attempt_progress progress
    where
      progress.attempt_id = p_attempt_id
  ) then
    return pg_catalog.jsonb_build_object('status', 'committed');
  end if;

  select
    pe.has_new,
    pe.eff_generation
  into v_pending
  from
    app.accounting_order_pending (p_order_id) pe;

  if v_pending.eff_generation is null then
    return pg_catalog.jsonb_build_object('status', 'no_work');
  end if;

  if v_pending.eff_generation is distinct from p_work_generation then
    return pg_catalog.jsonb_build_object('status', 'stale');
  end if;

  insert into
    app.accounting_work_state (order_id)
  values
    (p_order_id)
  on conflict (order_id) do nothing;

  perform 1
  from
    app.accounting_work_state ws
  where
    ws.order_id = p_order_id
  for update;

  if v_pending.has_new then
    update app.accounting_work_events e
    set
      work_generation = v_pending.eff_generation
    where
      e.order_id = p_order_id
      and e.work_generation is null;

    update app.accounting_work_state ws
    set
      work_generation = v_pending.eff_generation,
      attempts = 0,
      failed_at = null
    where
      ws.order_id = p_order_id;
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
      p_order_id,
      v_pending.eff_generation,
      p_attempt_id,
      'escaped',
      '57014',
      'recompute_limit'
    )
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    update app.accounting_work_state ws
    set
      attempts = ws.attempts + 1,
      failed_at = pg_catalog.clock_timestamp (),
      last_reason = 'recompute_limit',
      last_error_code = '57014',
      updated_at = pg_catalog.clock_timestamp ()
    where
      ws.order_id = p_order_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    case
      when v_inserted = 1 then 'recorded'
      else 'duplicate'
    end,
    'order_id',
    p_order_id,
    'work_generation',
    v_pending.eff_generation
  );
end;
$$;

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
  v_confirmed boolean := false;
  v_basis_review text;
  v_prep_review text;
  v_hold text;
  v_closing boolean := false;
  v_review text;
  v_kept jsonb;
  v_over boolean;
  v_episode integer;
  v_eff record;
  v_move text;
  v_closed_post boolean := false;
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
    i.id = app.order_processing_input_id (p_order_id);

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

  if exists (
    select
      1
    from
      app.activation_history_input frozen
    where
      frozen.order_id = p_order_id
      and frozen.cost_input_id = v_input.id
      and not exists (
        select
          1
        from
          app.activation_history_posted posted
        where
          posted.order_id = frozen.order_id
          and posted.cost_input_id = frozen.cost_input_id
      )
  ) then
    perform pg_catalog.set_config('app.replay_frozen', '1', true);
    perform pg_catalog.set_config('app.replay_order_at', v_snap.ordered_at::text, true);
  else
    perform pg_catalog.set_config('app.replay_frozen', '', true);
  end if;

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
      -- A confirmed set of returned quantities (zeros included) is any
      -- non-empty list on the current event. Whatever the decision, a change of
      -- its basis is reviewed, because the owner confirmed it against that basis.
      v_confirmed := coalesce(pg_catalog.jsonb_array_length(v_ev.returned) > 0, false);

      if v_confirmed then
        if v_ctx ->> 'q_status' is distinct from 'ready' then
          v_basis_review := 'items_changed';
        elsif v_ctx ->> 'q_signature' is distinct from v_ev.q_signature then
          v_basis_review := case
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
      elsif v_ev.owner_reviewed
      and app.disposition_family (v_ev.class) = 'terminal'
      and v_ctx ->> 'prep_hash' is distinct from v_ev.prep_hash then
        -- A reviewed canceled, missing or fully refunded decision without a
        -- confirmed allocation was made on another preparation basis.
        v_prep_review := case
          when v_ctx ->> 'q_status' is distinct from 'ready'
          or (
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

      -- It makes the posting the preparation quantities less the returned ones
      -- only where it applies: for a not-made partial refund the sale, for a
      -- made terminal order the waste.
      v_alloc := coalesce(
        v_confirmed
        and (
          (
            v_ev.decision = 'not_made'
            and app.disposition_family (v_ctx ->> 'class') = 'partial'
          )
          or (
            v_ev.decision = 'made'
            and app.disposition_family (v_ctx ->> 'class') = 'terminal'
          )
        ),
        false
      );

      -- A changed refund set is reviewed before anything else, so an order
      -- that looks ordinary again cannot replace a decision at once.
      if v_ctx ->> 'refund_signature' is distinct from v_ev.refund_signature then
        v_review := 'refund_changed';
      elsif v_basis_review is not null
      and (
        (
          v_ctx ->> 'class' is null
          and v_ev.class in ('canceled', 'missing', 'none')
        )
        or app.disposition_family (v_ctx ->> 'class') is not distinct from app.disposition_family (v_ev.class)
      ) then
        -- A confirmed allocation was made on another basis; this also holds
        -- back the automatic closure of an order that is ordinary again.
        v_review := v_basis_review;
      elsif v_ctx ->> 'class' is null
      and v_ev.class in ('canceled', 'missing', 'none') then
        -- The order is an ordinary sale again; the history stays. The episode
        -- closes only once its application is recorded (end of this function),
        -- so a blocked posting is retried with the same decision.
        v_closing := true;
        v_alloc := false;
      elsif app.disposition_family (v_ctx ->> 'class') is distinct from app.disposition_family (v_ev.class) then
        v_review := 'class_changed';
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

      if not v_closing then
        if v_prep_review is not null then
          -- The preparation basis changed under a reviewed terminal decision:
          -- the owner reviews again and the conservative made default applies
          -- meanwhile. A not-made decision gets a new unreviewed default event
          -- (the owner's event stays in the history); a made one already is it.
          v_hold := v_prep_review;

          if v_ev.decision = 'not_made' then
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
                'made',
                v_ctx ->> 'class',
                'system_default',
                false,
                null,
                null,
                v_ev.id,
                v_input.id,
                (v_ctx ->> 'prep_snapshot_id')::bigint,
                v_ctx ->> 'prep_hash',
                v_ctx -> 'q_items',
                v_ctx ->> 'q_signature',
                v_input.refund_revision_ids,
                v_ctx ->> 'refund_signature',
                v_ev.order_total,
                (v_ctx ->> 'refund_total')::numeric,
                '[]'::jsonb
              )
            returning
              * into v_ev;

            update app.order_disposition_state ds
            set
              event_id = v_ev.id,
              class = v_ctx ->> 'class',
              review_reason = v_hold,
              cost_input_id = v_input.id,
              context = v_ctx - 'exact' - 'res',
              token = app.disposition_token (v_ctx, v_ev.id),
              updated_at = v_now
            where
              ds.order_id = p_order_id;
          end if;
        elsif not v_ev.owner_reviewed
        and v_ev.prior_event_id is not null
        and v_ds.review_reason in ('items_changed', 'quantities_changed') then
          -- The default that replaced a reviewed decision keeps the reason the
          -- owner is asked about until the owner decides.
          v_hold := v_ds.review_reason;
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

      v_ctx := v_ctx || pg_catalog.jsonb_build_object('sig_same', true);

      -- The row is readable and decidable from the start, even when the
      -- posting below is blocked and returns early.
      update app.order_disposition_state ds
      set
        episode = v_episode,
        is_open = true,
        event_id = v_ev.id,
        class = v_ctx ->> 'class',
        review_reason = null,
        cost_input_id = v_input.id,
        context = v_ctx - 'exact' - 'res',
        token = app.disposition_token (v_ctx, v_ev.id),
        updated_at = v_now
      where
        ds.order_id = p_order_id;

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
  elsif v_alloc then
    -- The returned quantities are relative to the retained preparation basis,
    -- not to whatever the current snapshot holds.
    v_exact := v_ctx -> 'exact';
    v_res := v_ctx -> 'res';
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

  -- Returned quantities confirmed: the posted quantities are the preparation
  -- quantities less the returned ones, per stock item (the sale of a not-made
  -- partial refund, the prepared waste of a made full refund). Never a money
  -- ratio.
  if v_disposition in ('sale', 'prepared_waste')
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
      v_closed_post := not exists (
        select
          1
        from
          app.activation_history_input frozen
        where
          frozen.order_id = p_order_id
          and not exists (
            select
              1
            from
              app.activation_history_posted posted
            where
              posted.order_id = frozen.order_id
              and posted.cost_input_id = frozen.cost_input_id
          )
      )
      and (
        (
          v_snap.ordered_at >= v_start
          and v_snap.ordered_at < app.restatement_window_start ()
        )
        or exists (
          select
            1
          from
            app.order_cost_movement_links link
            join app.stock_movements posted_move on posted_move.id = link.movement_id
          where
            link.application_id = v_owner_id
            and posted_move.movement_type = 'closed_period'::app.movement_type
        )
      );

      -- A configuration span passes one cause into the closed poster below.
      -- An unposted frozen activation input keeps the original-instant
      -- exception: v_closed_post stays false and the order posts on its own day.
      if v_closed_post then
        v_batch := app.post_closed_order_difference (
          p_order_id,
          case
            when v_disposition in ('sale', 'prepared_waste') then coalesce(v_reqs, '[]'::jsonb)
            else '[]'::jsonb
          end,
          case
            when v_disposition = 'prepared_waste' then 'waste'
            else 'cogs'
          end,
          case
            when v_disposition = 'prepared_waste' then 'waste'
            else 'sale'
          end,
          nullif(pg_catalog.current_setting('app.span_cause', true), '')::uuid
        );

        -- The original rows stay. The receipt still names the posting it
        -- replaced so the old shift can see the supersession.
        if v_owner_id is not null
        and v_batch is not null then
          v_retire_batch := v_batch;
        end if;
      end if;

      if not v_closed_post
      and v_owner_id is not null then
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

      if not v_closed_post
      and v_disposition in ('sale', 'prepared_waste') then
        if v_event is null then
          v_event := pg_catalog.nextval(
            pg_catalog.pg_get_serial_sequence('app.stock_movements', 'id')
          );
        end if;

        v_move := case v_disposition
          when 'sale' then 'sale'
          else 'waste'
        end;

        -- Inside a decision episode, and when it closes, a repost of the same
        -- quantity keeps the previous movement pieces, one line per piece in the
        -- same order, so a reclassification never changes the per-piece rounding.
        v_lines := app.engine_outflow_lines (
          case
            when (
              v_open
              or v_closing
            )
            and v_retire_ids is not null then v_owner_id
          end,
          v_reqs,
          v_move,
          v_snap.ordered_at,
          v_snap.shift_id,
          v_id::text,
          v_event
        );

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

        -- An open or closing episode keeps its current context and token, so
        -- the owner can read and decide the row while the posting is blocked.
        if v_open
        or v_closing then
          update app.order_disposition_state ds
          set
            class = v_ctx ->> 'class',
            review_reason = coalesce(
              v_hold,
              case
                when v_ctx ->> 'class' = 'unresolved_refund' then 'unresolved_refund'
              end
            ),
            cost_input_id = v_input.id,
            context = v_ctx - 'exact' - 'res',
            token = app.disposition_token (v_ctx, v_ev.id),
            updated_at = v_now
          where
            ds.order_id = p_order_id;
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
      and (
        (
          v_closed_post
          and sm.movement_type = 'closed_period'
          and (
            sm.source_id = p_order_id
            or exists (
              select
                1
              from
                app.closed_period_sources src
                join app.stock_movements original on original.id::text = src.source_id
              where
                src.movement_id = sm.id
                and src.source_kind = 'return'
                and (
                  original.source_id = p_order_id
                  or exists (
                    select
                      1
                    from
                      app.order_cost_movement_links prior
                    where
                      prior.order_id = p_order_id
                      and prior.movement_id = original.id
                  )
                )
            )
          )
        )
        or (
          not v_closed_post
          and sm.source_type = 'engine'
          and sm.source_id = v_id::text
          and sm.movement_type in ('sale', 'waste')
        )
      );

    get diagnostics v_linked = row_count;

    select
      pg_catalog.jsonb_array_length(v_lines)
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

  -- The owner's closing decision (class none) is applied by closing the
  -- episode here, so its effect is still recorded against that decision.
  if v_open
  or (
    v_closing
    and v_ev.class = 'none'
  ) then
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

    if v_open then
      update app.order_disposition_state ds
      set
        class = v_ctx ->> 'class',
        review_reason = coalesce(
          v_hold,
          case
            when v_ctx ->> 'class' = 'unresolved_refund' then 'unresolved_refund'
          end
        ),
        cost_input_id = v_input.id,
        context = v_ctx - 'exact' - 'res',
        token = app.disposition_token (v_ctx, v_ev.id),
        updated_at = v_now
      where
        ds.order_id = p_order_id;
    end if;
  end if;

  -- The episode of an order that is ordinary again closes only now that its
  -- application is recorded, with the closing decision's effect already linked.
  if v_closing then
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

  lock table app.pos_sync_runs in row exclusive mode;

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
  v_has_cover boolean := false;
  v_window timestamptz;
  v_closed_pending jsonb := '[]'::jsonb;
  v_open_pending jsonb := '[]'::jsonb;
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  if p_pending is null
  or pg_catalog.jsonb_typeof(p_pending) <> 'array' then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;

  v_window := app.restatement_window_start (app.note_change_instant ());

  select
    coalesce(
      pg_catalog.jsonb_agg(elem.value) filter (
        where
          (elem.value ->> 'occurred_at')::timestamptz < v_window
      ),
      '[]'::jsonb
    ),
    coalesce(
      pg_catalog.jsonb_agg(elem.value) filter (
        where
          (elem.value ->> 'occurred_at')::timestamptz >= v_window
      ),
      '[]'::jsonb
    )
  into
    v_closed_pending,
    v_open_pending
  from
    pg_catalog.jsonb_array_elements(p_pending) as elem (value);

  if pg_catalog.jsonb_array_length(v_closed_pending) > 0 then
    v_ids := app.post_closed_backdated_batch (p_batch_id, v_closed_pending);
  end if;

  if pg_catalog.jsonb_array_length(v_open_pending) = 0 then
    return v_ids;
  end if;

  p_pending := v_open_pending;

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

  select
    exists (
      select
        1
      from
        ledger_scratch.recompute_cover_pair
    )
  into v_has_cover;

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

  if v_has_cover then
    -- The dry walk valued the cover against synthetic ids. Replay the posted
    -- rows so the carrier and any later in-window sale land on the ledger.
    perform app.replay_execute (v_set, '[]'::jsonb, p_batch_id, true);
  else
    perform app.rebuild_derived_balances (v_seed, p_batch_id);
  end if;

  return v_ids;
end;
$$;

create or replace function app.record_purchase (p_purchase jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_purchase_id uuid;
  v_batch_id uuid;
  v_purchased_at timestamptz;
  v_at_text text;
  v_supplier text;
  v_invoice_no text;
  v_note text;
  v_elem jsonb;
  v_item_text text;
  v_item_id uuid;
  v_name text;
  v_base_unit text;
  v_qty_text text;
  v_qty numeric;
  v_unit text;
  v_factor numeric;
  v_resolved_unit text;
  v_base_qty numeric;
  v_amount_text text;
  v_amount numeric;
  v_unit_cost numeric;
  v_total numeric := 0;
  v_n integer := 0;
  v_prev bigint;
  v_movement_id bigint;
  v_item_ids uuid[] := '{}'::uuid[];
  v_names text[] := '{}'::text[];
  v_qtys numeric[] := '{}'::numeric[];
  v_units text[] := '{}'::text[];
  v_base_qtys numeric[] := '{}'::numeric[];
  v_amounts numeric[] := '{}'::numeric[];
  v_unit_costs numeric[] := '{}'::numeric[];
  v_movement_ids bigint[] := '{}'::bigint[];
  v_factors numeric[] := '{}'::numeric[];
  v_base_units text[] := '{}'::text[];
  v_expected_bases text[] := '{}'::text[];
  v_expected_factors numeric[] := '{}'::numeric[];
  v_expected_base text;
  v_expected_factor_text text;
  v_expected_factor numeric;
  v_request_text text;
  v_request_id uuid;
  v_existing_id uuid;
  v_existing_at timestamptz;
  v_existing_supplier text;
  v_existing_invoice text;
  v_existing_note text;
  v_detail text;
  v_pending jsonb;
  v_times timestamptz[];
  v_type_fill text[];
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  if p_purchase is null or pg_catalog.jsonb_typeof(p_purchase) <> 'object' then
    raise exception 'p_purchase must be a jsonb object'
      using errcode = '22023';
  end if;

  if p_purchase ? 'supplier'
  and pg_catalog.jsonb_typeof(p_purchase -> 'supplier') not in ('string', 'null') then
    raise exception 'supplier must be text'
      using errcode = '22023';
  end if;

  if p_purchase ? 'invoice_no'
  and pg_catalog.jsonb_typeof(p_purchase -> 'invoice_no') not in ('string', 'null') then
    raise exception 'invoice_no must be text'
      using errcode = '22023';
  end if;

  if p_purchase ? 'note'
  and pg_catalog.jsonb_typeof(p_purchase -> 'note') not in ('string', 'null') then
    raise exception 'note must be text'
      using errcode = '22023';
  end if;

  v_at_text := nullif(pg_catalog.btrim(p_purchase ->> 'purchased_at'), '');

  if v_at_text is null then
    raise exception 'purchased_at is required'
      using errcode = '22023';
  end if;

  begin
    v_purchased_at := v_at_text::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception 'purchased_at must be a finite timestamp'
        using errcode = '22023';
  end;

  if v_purchased_at is null or not pg_catalog.isfinite(v_purchased_at) then
    raise exception 'purchased_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  v_supplier := nullif(pg_catalog.btrim(p_purchase ->> 'supplier'), '');

  if v_supplier is not null and pg_catalog.char_length(v_supplier) > 120 then
    raise exception 'supplier must be at most 120 characters'
      using errcode = '22023';
  end if;

  v_invoice_no := nullif(pg_catalog.btrim(p_purchase ->> 'invoice_no'), '');

  if v_invoice_no is not null and pg_catalog.char_length(v_invoice_no) > 60 then
    raise exception 'invoice_no must be at most 60 characters'
      using errcode = '22023';
  end if;

  v_note := nullif(pg_catalog.btrim(p_purchase ->> 'note'), '');

  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    raise exception 'note must be at most 500 characters'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_purchase -> 'lines') is distinct from 'array'
  or pg_catalog.jsonb_array_length(p_purchase -> 'lines') < 1
  or pg_catalog.jsonb_array_length(p_purchase -> 'lines') > 100 then
    raise exception 'lines must be a jsonb array of 1 to 100 purchase lines'
      using errcode = '22023';
  end if;

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_purchase -> 'lines') as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each purchase line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_text := nullif(pg_catalog.btrim(v_elem ->> 'item_id'), '');
    v_qty_text := nullif(pg_catalog.btrim(v_elem ->> 'quantity'), '');
    v_unit := nullif(pg_catalog.btrim(v_elem ->> 'unit'), '');
    v_amount_text := nullif(pg_catalog.btrim(v_elem ->> 'amount_paid'), '');

    if v_item_text is null
    or v_qty_text is null
    or v_unit is null
    or v_amount_text is null then
      raise exception 'item_id, quantity, unit, and amount_paid are required'
        using errcode = '22023';
    end if;

    if v_item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'item_id must be a uuid'
        using errcode = '22023';
    end if;

    v_item_id := v_item_text::uuid;

    if v_qty_text !~ '^\d+(\.\d+)?$' then
      raise exception 'quantity must be a finite number > 0'
        using errcode = '22023';
    end if;

    v_qty := v_qty_text::numeric;

    if v_qty <> pg_catalog.round(v_qty, 6) then
      raise exception 'quantity must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    if v_qty <= 0 or v_qty >= 100000000000000 then
      raise exception 'quantity must be a finite number > 0'
        using errcode = '22023';
    end if;

    if v_amount_text !~ '^\d+(\.\d+)?$' then
      raise exception 'amount_paid must be a finite number >= 0'
        using errcode = '22023';
    end if;

    v_amount := v_amount_text::numeric;

    if v_amount <> pg_catalog.round(v_amount, 2) then
      raise exception 'amount_paid must be in piasters'
        using errcode = '22023';
    end if;

    if v_amount < 0 or v_amount >= 1000000000000 then
      raise exception 'amount_paid must be a finite number >= 0'
        using errcode = '22023';
    end if;

    -- Expected fields are syntax-checked here and compared with the catalog
    -- only after a replay miss. A missing value stays null so a saved draft
    -- can return before that check. array_append keeps a null element.
    v_expected_base := nullif(
      pg_catalog.btrim(v_elem ->> 'expected_base_unit'),
      ''
    );
    v_expected_factor_text := nullif(
      pg_catalog.btrim(v_elem ->> 'expected_factor'),
      ''
    );
    if v_expected_factor_text is null then
      v_expected_factor := null;
    elsif v_expected_factor_text !~ '^\d+(\.\d+)?$' then
      raise exception 'expected_factor is required'
        using errcode = '22023';
    else
      v_expected_factor := v_expected_factor_text::numeric;
    end if;

    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_units := v_units || v_unit;
    v_amounts := v_amounts || v_amount;
    v_expected_bases := pg_catalog.array_append(v_expected_bases, v_expected_base);
    v_expected_factors := pg_catalog.array_append(
      v_expected_factors,
      v_expected_factor
    );
    v_n := v_n + 1;
  end loop;

  -- Replay uses the normalized payload only: trimmed text, timestamptz, uuid,
  -- and numerics already rejected when they would not fit the columns
  -- (quantity scale 6, amount_paid in piasters). No stock_items or conversion
  -- read has happened, so a deleted unit still returns the saved purchase.
  -- The advisory lock serializes this lookup with every other ledger write.
  -- purchases.request_id is unique as the final guard: a second insert that
  -- still raced fails and rolls its inflows back with this transaction.
  v_request_text := nullif(pg_catalog.btrim(p_purchase ->> 'request_id'), '');
  if v_request_text is not null then
    if v_request_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'request_id is required'
        using errcode = '22023';
    end if;
    v_request_id := v_request_text::uuid;
    select
      p.id,
      p.purchased_at,
      p.supplier,
      p.invoice_no,
      p.note
    into
      v_existing_id,
      v_existing_at,
      v_existing_supplier,
      v_existing_invoice,
      v_existing_note
    from
      app.purchases p
    where
      p.request_id = v_request_id;
    if found then
      if v_existing_at is distinct from v_purchased_at
      or v_existing_supplier is distinct from v_supplier
      or v_existing_invoice is distinct from v_invoice_no
      or v_existing_note is distinct from v_note
      or (
        select
          count(*)
        from
          app.purchase_lines pl
        where
          pl.purchase_id = v_existing_id
      ) is distinct from v_n
      or exists (
        select
          1
        from
          app.purchase_lines pl
          join rows from (pg_catalog.unnest(v_item_ids), pg_catalog.unnest(v_qtys), pg_catalog.unnest(v_units), pg_catalog.unnest(v_amounts)) with ordinality as u (item_id, quantity, unit, amount_paid, line_no) on u.line_no = pl.line_no
        where
          pl.purchase_id = v_existing_id
          and (
            pl.item_id is distinct from u.item_id
            or pl.quantity is distinct from u.quantity
            or pl.unit is distinct from u.unit
            or pl.amount_paid is distinct from u.amount_paid
          )
      ) then
        raise exception 'request_id already used for a different purchase'
          using errcode = '22023';
      end if;
      return v_existing_id;
    end if;
  end if;

  if v_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  -- First post for this request. Catalog reads stay under the posting lock.
  for v_i in 1..v_n loop
    v_item_id := v_item_ids[v_i];
    v_qty := v_qtys[v_i];
    v_unit := v_units[v_i];
    v_amount := v_amounts[v_i];

    select
      si.name,
      si.base_unit
    into
      v_name,
      v_base_unit
    from
      app.stock_items si
    where
      si.id = v_item_id;

    if not found then
      raise exception 'unknown stock_item id: %', v_item_id
        using errcode = '22023';
    end if;

    -- A reviewed base unit that no longer matches is refused before the unit
    -- name is resolved, so a stale unit name is not reported as unknown.
    if v_expected_bases[v_i] is not null
    and v_expected_bases[v_i] is distinct from v_base_unit then
      raise exception 'conversion changed'
        using errcode = '40001';
    end if;

    if v_unit = v_base_unit then
      v_factor := 1;
    else
      v_resolved_unit := app.resolve_unit_code(v_unit);

      if v_resolved_unit is null then
        raise exception 'unknown unit "%" for item %', v_unit, v_name
          using errcode = '22023';
      end if;

      v_factor := app.item_factor_at(v_item_id, v_resolved_unit, v_purchased_at);
    end if;

    v_base_qty := pg_catalog.round(v_qty * v_factor, 6);

    if v_base_qty <= 0 or v_base_qty >= 100000000000000 then
      raise exception 'purchase base quantity must be > 0'
        using errcode = '22023';
    end if;

    if v_amount = 0 then
      v_unit_cost := 0;
    else
      v_unit_cost := pg_catalog.round(v_amount / v_base_qty, 6);
    end if;

    if v_amount > 0 and v_unit_cost <= 0 then
      raise exception 'converted purchase unit_cost must be > 0'
        using errcode = '22023';
    end if;

    if v_unit_cost >= 100000000000000 then
      raise exception 'purchase unit_cost is out of range'
        using errcode = '22023';
    end if;

    v_total := v_total + v_amount;

    if v_total >= 1000000000000 then
      raise exception 'purchase total_paid is out of range'
        using errcode = '22023';
    end if;

    v_names := v_names || v_name;
    v_base_qtys := v_base_qtys || v_base_qty;
    v_unit_costs := v_unit_costs || v_unit_cost;
    v_factors := v_factors || v_factor;
    v_base_units := v_base_units || v_base_unit;
  end loop;

  for v_i in 1..v_n loop
    if v_expected_bases[v_i] is null or v_expected_factors[v_i] is null then
      raise exception 'expected_base_unit is required'
        using errcode = '22023';
    end if;

    if v_expected_bases[v_i] is distinct from v_base_units[v_i]
    or v_expected_factors[v_i] is distinct from v_factors[v_i] then
      raise exception 'conversion changed'
        using errcode = '40001';
    end if;
  end loop;

  v_purchase_id := pg_catalog.gen_random_uuid();
  v_batch_id := pg_catalog.gen_random_uuid();
  v_times := pg_catalog.array_fill(v_purchased_at, array[v_n]);
  v_type_fill := pg_catalog.array_fill('purchase'::text, array[v_n]);

  perform app.assert_not_before_opening (v_item_ids, v_times, v_type_fill);

  -- A newest purchase that covers an open deficit still replays. The forward
  -- applicator would hide the checkpoint restore the cover has to walk.
  if not app.batch_is_forward (v_item_ids, v_times)
  or exists (
    select
      1
    from
      app.provisional_deficits open_deficit
    where
      open_deficit.item_id = any (v_item_ids)
      and open_deficit.qty_uncovered > 0
  ) then
    v_pending := '[]'::jsonb;

    for v_i in 1..v_n loop
      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_i,
          'batch_id',
          v_batch_id,
          'item_id',
          v_item_ids[v_i],
          'movement_type',
          'purchase',
          'occurred_at',
          v_purchased_at,
          'quantity',
          v_base_qtys[v_i],
          'unit_cost',
          v_unit_costs[v_i],
          'total_cost',
          v_amounts[v_i],
          'is_input_total',
          true,
          'shift_id',
          null,
          'source_type',
          'purchase',
          'source_id',
          v_purchase_id::text,
          'note',
          null
        )
      );
    end loop;

    begin
      v_movement_ids := app.post_backdated_batch (v_batch_id, v_pending);
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_detail = pg_exception_detail;

        if sqlerrm in (
          'back-dated movement not supported yet',
          'movement is before opening stock'
        ) then
          raise exception using
            message = sqlerrm,
            errcode = 'P0001',
            detail = coalesce(nullif(v_detail, ''), v_names[1]);
        end if;

        raise;
    end;

    if coalesce(pg_catalog.cardinality(v_movement_ids), 0) <> v_n then
      raise exception 'purchase movement was not posted'
        using errcode = 'P0001';
    end if;
  else
  for v_i in 1..v_n loop
    v_name := v_names[v_i];
    v_prev := coalesce(
      (
        select
          max(sm.id)
        from
          app.stock_movements sm
        where
          sm.batch_id = v_batch_id
          and sm.item_id = v_item_ids[v_i]
          and sm.movement_type = 'purchase'
      ),
      0
    );

    begin
      perform app.apply_inflow_movement (
        v_batch_id,
        v_item_ids[v_i],
        'purchase'::app.movement_type,
        v_purchased_at,
        v_base_qtys[v_i],
        v_unit_costs[v_i],
        null,
        'purchase',
        v_purchase_id::text,
        null,
        v_amounts[v_i]
      );
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_detail = pg_exception_detail;

        if sqlerrm in (
          'back-dated movement not supported yet',
          'movement is before opening stock'
        ) then
          raise exception using
            message = sqlerrm,
            errcode = 'P0001',
            detail = coalesce(nullif(v_detail, ''), v_name);
        end if;

        raise;
    end;

    select
      sm.id
    into v_movement_id
    from
      app.stock_movements sm
    where
      sm.batch_id = v_batch_id
      and sm.item_id = v_item_ids[v_i]
      and sm.movement_type = 'purchase'
      and sm.id > v_prev
    order by
      sm.id
    limit
      1;

    if v_movement_id is null then
      raise exception 'purchase movement was not posted'
        using errcode = 'P0001';
    end if;

    v_movement_ids := v_movement_ids || v_movement_id;
  end loop;

  end if;

  insert into
    app.purchases (
      id,
      request_id,
      purchased_at,
      supplier,
      invoice_no,
      note,
      total_paid,
      batch_id,
      created_by
    )
  values
    (
      v_purchase_id,
      v_request_id,
      v_purchased_at,
      v_supplier,
      v_invoice_no,
      v_note,
      v_total,
      v_batch_id,
      auth.uid ()
    );

  for v_i in 1..v_n loop
    insert into
      app.purchase_lines (
        purchase_id,
        line_no,
        item_id,
        quantity,
        unit,
        base_quantity,
        amount_paid,
        movement_id
      )
    values
      (
        v_purchase_id,
        v_i,
        v_item_ids[v_i],
        v_qtys[v_i],
        v_units[v_i],
        v_base_qtys[v_i],
        v_amounts[v_i],
        v_movement_ids[v_i]
      );
  end loop;

  return v_purchase_id;
end;
$$;

create or replace function app.post_movements (p_movements jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_type text;
begin
  -- The ledger lock is taken before the activation read. A sale that
  -- waits while activation commits then sees the row and is refused.
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  if pg_catalog.jsonb_typeof (p_movements) = 'array'
  and exists (
    select
      1
    from
      app.inventory_activation
  )
  and exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements (p_movements) elem (value)
    where
      elem.value ->> 'movement_type' in ('sale', 'waste', 'count_adjustment')
  ) then
    select
      elem.value ->> 'movement_type'
    into v_type
    from
      pg_catalog.jsonb_array_elements (p_movements) elem (value)
    where
      elem.value ->> 'movement_type' in ('sale', 'waste', 'count_adjustment')
    limit
      1;

    raise exception 'disallowed movement_type in post_movements: %', v_type
      using errcode = '22023';
  end if;

  return app.post_movements_internal (p_movements);
end;
$$;

create or replace function app.post_movements_internal (p_movements jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_batch_id uuid;
  v_elem jsonb;
  v_item_id uuid;
  v_type_text text;
  v_movement_type app.movement_type;
  v_occurred_at timestamptz;
  v_raw_qty numeric;
  v_unit text;
  v_raw_unit_cost numeric;
  v_shift_id text;
  v_source_type text;
  v_source_id text;
  v_note text;
  v_base_unit text;
  v_factor numeric(18, 9);
  v_resolved_unit text;
  v_qty numeric(20, 6);
  v_total_cost numeric(14, 2);
  v_unit_cost numeric(20, 6);
  v_item_ids uuid[] := '{}'::uuid[];
  v_types text[] := '{}'::text[];
  v_times timestamptz[] := '{}'::timestamptz[];
  v_qtys numeric[] := '{}'::numeric[];
  v_unit_costs numeric[] := '{}'::numeric[];
  v_totals numeric[] := '{}'::numeric[];
  v_shifts text[] := '{}'::text[];
  v_source_types text[] := '{}'::text[];
  v_source_ids text[] := '{}'::text[];
  v_notes text[] := '{}'::text[];
  v_n integer := 0;
  v_pending jsonb;
  v_signed numeric;
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  if p_movements is null
  or pg_catalog.jsonb_typeof(p_movements) <> 'array'
  or pg_catalog.jsonb_array_length(p_movements) = 0 then
    raise exception 'p_movements must be a non-empty jsonb array'
      using errcode = '22023';
  end if;

  v_batch_id := pg_catalog.gen_random_uuid();

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_movements) as elem (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each movement element must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_id := (v_elem ->> 'item_id')::uuid;
    v_type_text := v_elem ->> 'movement_type';
    v_occurred_at := (v_elem ->> 'occurred_at')::timestamptz;
    v_raw_qty := (v_elem ->> 'quantity')::numeric;
    v_unit := nullif(pg_catalog.btrim(v_elem ->> 'unit'), '');
    v_raw_unit_cost := (v_elem ->> 'unit_cost')::numeric;
    v_shift_id := v_elem ->> 'shift_id';
    v_source_type := v_elem ->> 'source_type';
    v_source_id := v_elem ->> 'source_id';
    v_note := v_elem ->> 'note';
    v_unit_cost := null;
    v_total_cost := null;

    if v_item_id is null or v_type_text is null or v_occurred_at is null or v_raw_qty is null then
      raise exception 'item_id, movement_type, occurred_at, and quantity are required'
        using errcode = '22023';
    end if;

    if v_raw_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'movement quantity must be a finite number'
        using errcode = '22023';
    end if;

    if v_raw_unit_cost is not null
    and v_raw_unit_cost in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'movement unit_cost must be a finite number'
        using errcode = '22023';
    end if;

    if v_type_text in (
      'sale_reversal',
      'waste_reversal',
      'count_compensation'
    ) then
      raise exception 'disallowed movement_type in post_movements: %',
      v_type_text
        using errcode = '22023';
    end if;

    if v_type_text not in (
      'opening',
      'purchase',
      'sale',
      'waste',
      'count_adjustment'
    ) then
      raise exception 'disallowed movement_type in post_movements: %', v_type_text
        using errcode = '22023';
    end if;

    v_movement_type := v_type_text::app.movement_type;

    select
      si.base_unit
    into v_base_unit
    from
      app.stock_items si
    where
      si.id = v_item_id;

    if not found then
      raise exception 'unknown stock_item id: %', v_item_id
        using errcode = '22023';
    end if;

    if v_unit is null or v_unit = v_base_unit then
      v_factor := 1;
    else
      v_resolved_unit := app.resolve_unit_code(v_unit);

      if v_resolved_unit is null then
        raise exception 'unknown unit "%" for item %', v_unit, v_item_id
          using errcode = '22023';
      end if;

      v_factor := app.item_factor_at(v_item_id, v_resolved_unit, v_occurred_at);
    end if;

    v_qty := pg_catalog.round(v_raw_qty * v_factor, 6);

    if v_qty = 0 then
      raise exception 'movement quantity must not be zero'
        using errcode = '22023';
    end if;

    if v_movement_type = 'purchase' then
      if v_qty <= 0 then
        raise exception 'purchase quantity must be > 0'
          using errcode = '22023';
      end if;

      if v_raw_unit_cost is null or v_raw_unit_cost <= 0 then
        raise exception 'purchase unit_cost must be > 0'
          using errcode = '22023';
      end if;

      v_total_cost := pg_catalog.round(v_raw_qty * v_raw_unit_cost, 2);

      if v_total_cost <= 0 then
        raise exception 'purchase total_cost must be > 0'
          using errcode = '22023';
      end if;

      v_unit_cost := pg_catalog.round(v_total_cost / v_qty, 6);

      if v_unit_cost <= 0 then
        raise exception 'converted purchase unit_cost must be > 0'
          using errcode = '22023';
      end if;
    elsif v_movement_type = 'opening' then
      if v_qty <= 0 then
        raise exception 'opening quantity must be > 0'
          using errcode = '22023';
      end if;

      if v_raw_unit_cost is null or v_raw_unit_cost < 0 then
        raise exception 'opening unit_cost must be >= 0'
          using errcode = '22023';
      end if;

      v_total_cost := pg_catalog.round(v_raw_qty * v_raw_unit_cost, 2);
      v_unit_cost := pg_catalog.round(v_total_cost / v_qty, 6);
    elsif v_movement_type in ('sale', 'waste') then
      if v_qty <= 0 then
        raise exception '% quantity must be > 0', v_movement_type
          using errcode = '22023';
      end if;
    end if;

    v_n := v_n + 1;
    v_item_ids := v_item_ids || v_item_id;
    v_types := v_types || v_type_text;
    v_times := v_times || v_occurred_at;
    v_qtys := v_qtys || v_qty;
    v_unit_costs := pg_catalog.array_append(v_unit_costs, v_unit_cost);
    v_totals := pg_catalog.array_append(v_totals, v_total_cost);
    v_shifts := pg_catalog.array_append(v_shifts, v_shift_id);
    v_source_types := pg_catalog.array_append(v_source_types, v_source_type);
    v_source_ids := pg_catalog.array_append(v_source_ids, v_source_id);
    v_notes := pg_catalog.array_append(v_notes, v_note);
  end loop;

  for v_i in 1..v_n loop
    if not pg_catalog.isfinite(v_times[v_i]) then
      raise exception 'occurred_at must be a finite timestamp'
        using errcode = '22023';
    end if;
  end loop;

  perform app.assert_not_before_opening (v_item_ids, v_times, v_types);

  -- A newest purchase that covers an open deficit still replays. The forward
  -- applicator would hide the checkpoint restore the cover has to walk.
  if app.batch_is_forward (v_item_ids, v_times)
  and not exists (
    select
      1
    from
      app.provisional_deficits open_deficit
    where
      open_deficit.item_id = any (v_item_ids)
      and open_deficit.qty_uncovered > 0
  ) then
    for v_i in 1..v_n loop
      if v_types[v_i] = 'purchase' then
        perform app.apply_inflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'purchase',
          v_times[v_i],
          v_qtys[v_i],
          v_unit_costs[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i],
          v_totals[v_i]
        );
      elsif v_types[v_i] = 'opening' then
        perform app.apply_inflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'opening',
          v_times[v_i],
          v_qtys[v_i],
          v_unit_costs[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i],
          v_totals[v_i]
        );
      elsif v_types[v_i] in ('sale', 'waste') then
        perform app.apply_outflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          v_types[v_i]::app.movement_type,
          v_times[v_i],
          v_qtys[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i]
        );
      elsif v_qtys[v_i] > 0 then
        perform app.apply_inflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'count_adjustment',
          v_times[v_i],
          v_qtys[v_i],
          null,
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i]
        );
      else
        perform app.apply_outflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'count_adjustment',
          v_times[v_i],
          -v_qtys[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i]
        );
      end if;
    end loop;
  else
    v_pending := '[]'::jsonb;

    for v_i in 1..v_n loop
      if v_types[v_i] in ('sale', 'waste') then
        v_signed := -v_qtys[v_i];
      else
        v_signed := v_qtys[v_i];
      end if;

      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_i,
          'batch_id',
          v_batch_id,
          'item_id',
          v_item_ids[v_i],
          'movement_type',
          v_types[v_i],
          'occurred_at',
          v_times[v_i],
          'quantity',
          v_signed,
          'unit_cost',
          coalesce(v_unit_costs[v_i], 0),
          'total_cost',
          coalesce(v_totals[v_i], 0),
          'is_input_total',
          v_types[v_i] in ('purchase', 'opening'),
          'shift_id',
          v_shifts[v_i],
          'source_type',
          v_source_types[v_i],
          'source_id',
          v_source_ids[v_i],
          'note',
          v_notes[v_i]
        )
      );
    end loop;

    perform app.post_backdated_batch (v_batch_id, v_pending);
  end if;

  return v_batch_id;
end;
$$;

create or replace function app.record_opening_stock (
  p_occurred_at timestamptz,
  p_lines jsonb,
  p_request_id uuid
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_batch_id uuid;
  v_movements jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_seen uuid[] := '{}'::uuid[];
  v_item_ids uuid[] := '{}'::uuid[];
  v_names text[] := '{}'::text[];
  v_qtys numeric[] := '{}'::numeric[];
  v_units text[] := '{}'::text[];
  v_costs numeric[] := '{}'::numeric[];
  v_factors numeric[] := '{}'::numeric[];
  v_base_units text[] := '{}'::text[];
  v_expected_bases text[] := '{}'::text[];
  v_expected_factors numeric[] := '{}'::numeric[];
  v_item_text text;
  v_item_id uuid;
  v_name text;
  v_base_unit text;
  v_qty_text text;
  v_qty numeric;
  v_cost_text text;
  v_unit_cost numeric;
  v_unit text;
  v_factor numeric;
  v_resolved_unit text;
  v_base_qty numeric;
  v_line_total numeric;
  v_count integer := 0;
  v_expected_base text;
  v_expected_factor_text text;
  v_expected_factor numeric;
  v_existing_id uuid;
  v_existing_at timestamptz;
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  if p_occurred_at is null then
    raise exception 'occurred_at is required'
      using errcode = '22023';
  end if;

  if not pg_catalog.isfinite(p_occurred_at) then
    raise exception 'occurred_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) <> 'array' then
    raise exception 'p_lines must be a jsonb array'
      using errcode = '22023';
  end if;

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_lines) as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each opening line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_text := nullif(pg_catalog.btrim(v_elem ->> 'item_id'), '');
    v_qty_text := nullif(pg_catalog.btrim(v_elem ->> 'quantity'), '');

    if v_item_text is null or v_qty_text is null then
      raise exception 'item_id and quantity are required'
        using errcode = '22023';
    end if;

    if v_item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'item_id must be a uuid'
        using errcode = '22023';
    end if;

    v_item_id := v_item_text::uuid;

    if v_qty_text !~ '^\d+(\.\d+)?$' then
      raise exception 'quantity must be a finite number >= 0'
        using errcode = '22023';
    end if;

    v_qty := v_qty_text::numeric;

    if v_qty <> pg_catalog.round(v_qty, 6) then
      raise exception 'quantity must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    if v_qty < 0 or v_qty >= 100000000000000 then
      raise exception 'quantity must be a finite number >= 0'
        using errcode = '22023';
    end if;

    v_cost_text := nullif(pg_catalog.btrim(v_elem ->> 'unit_cost'), '');

    if v_qty = 0 and v_cost_text is null then
      continue;
    end if;

    if v_cost_text is null then
      raise exception 'unit_cost is required'
        using errcode = '22023';
    end if;

    if v_cost_text !~ '^\d+(\.\d+)?$' then
      raise exception 'opening unit_cost must be >= 0'
        using errcode = '22023';
    end if;

    v_unit_cost := v_cost_text::numeric;

    if v_unit_cost < 0 then
      raise exception 'opening unit_cost must be >= 0'
        using errcode = '22023';
    end if;

    -- numeric(20,6) would round a longer cost, and the retry would then look
    -- like a different payload. Refuse it before the line is stored.
    if v_unit_cost <> pg_catalog.round(v_unit_cost, 6) then
      raise exception 'unit_cost must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    if v_qty = 0 then
      continue;
    end if;

    v_unit := nullif(pg_catalog.btrim(v_elem ->> 'unit'), '');

    if v_unit is null then
      raise exception 'unit is required'
        using errcode = '22023';
    end if;

    v_expected_base := nullif(
      pg_catalog.btrim(v_elem ->> 'expected_base_unit'),
      ''
    );
    v_expected_factor_text := nullif(
      pg_catalog.btrim(v_elem ->> 'expected_factor'),
      ''
    );
    if v_expected_factor_text is null then
      v_expected_factor := null;
    elsif v_expected_factor_text !~ '^\d+(\.\d+)?$' then
      raise exception 'expected_factor is required'
        using errcode = '22023';
    else
      v_expected_factor := v_expected_factor_text::numeric;
    end if;

    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_units := v_units || v_unit;
    v_costs := v_costs || v_unit_cost;
    v_expected_bases := pg_catalog.array_append(v_expected_bases, v_expected_base);
    v_expected_factors := pg_catalog.array_append(
      v_expected_factors,
      v_expected_factor
    );
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'at least one opening line is required'
      using errcode = '22023';
  end if;

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  -- Replay uses the normalized payload only: timestamptz, trimmed unit, uuid,
  -- and numerics that already fit the columns (quantity and unit_cost scale 6).
  -- No stock_items, conversion, or stock_movements read has happened, so a
  -- deleted unit still returns the saved batch. The advisory lock serializes
  -- this lookup. opening_stocks.request_id is unique as the final guard: a
  -- second insert fails and rolls this transaction back, so it cannot
  -- double-post. Quantity 0 lines were skipped above and are not compared.
  select
    o.id,
    o.occurred_at
  into
    v_existing_id,
    v_existing_at
  from
    app.opening_stocks o
  where
    o.request_id = p_request_id;

  if found then
    if v_existing_at is distinct from p_occurred_at
    or (
      select
        count(*)
      from
        app.opening_stock_lines ol
      where
        ol.opening_id = v_existing_id
    ) is distinct from v_count
    or exists (
      select
        1
      from
        app.opening_stock_lines ol
        join rows from (pg_catalog.unnest(v_item_ids), pg_catalog.unnest(v_qtys), pg_catalog.unnest(v_units), pg_catalog.unnest(v_costs)) with ordinality as u (item_id, quantity, unit, unit_cost, line_no) on u.line_no = ol.line_no
      where
        ol.opening_id = v_existing_id
        and (
          ol.item_id is distinct from u.item_id
          or ol.quantity is distinct from u.quantity
          or ol.unit is distinct from u.unit
          or ol.unit_cost is distinct from u.unit_cost
        )
    ) then
      raise exception 'request_id already used for a different opening'
        using errcode = '22023';
    end if;
    return v_existing_id;
  end if;

  for v_i in 1..v_count loop
    v_item_id := v_item_ids[v_i];
    v_qty := v_qtys[v_i];
    v_unit := v_units[v_i];
    v_unit_cost := v_costs[v_i];

    select
      si.name,
      si.base_unit
    into
      v_name,
      v_base_unit
    from
      app.stock_items si
    where
      si.id = v_item_id;

    if not found then
      raise exception 'unknown stock_item id: %', v_item_id
        using errcode = '22023';
    end if;

    if v_item_id = any (v_seen) then
      raise exception 'duplicate opening item: %', v_name
        using errcode = '22023';
    end if;

    v_seen := v_seen || v_item_id;
    v_names := v_names || v_name;

    -- A reviewed base unit that no longer matches is refused before the unit
    -- name is resolved, so a stale unit name is not reported as unknown.
    if v_expected_bases[v_i] is not null
    and v_expected_bases[v_i] is distinct from v_base_unit then
      raise exception 'conversion changed'
        using errcode = '40001';
    end if;

    if v_unit = v_base_unit then
      v_factor := 1;
    else
      v_resolved_unit := app.resolve_unit_code(v_unit);

      if v_resolved_unit is null then
        raise exception 'unknown unit "%" for item %', v_unit, v_name
          using errcode = '22023';
      end if;

      v_factor := app.item_factor_at(v_item_id, v_resolved_unit, p_occurred_at);
    end if;

    v_base_qty := pg_catalog.round(v_qty * v_factor, 6);

    if v_base_qty <= 0 or v_base_qty >= 100000000000000 then
      raise exception 'opening base quantity must be > 0'
        using errcode = '22023';
    end if;

    begin
      v_line_total := pg_catalog.round(v_qty * v_unit_cost, 2);
    exception
      when numeric_value_out_of_range then
        raise exception 'opening total_cost is out of range'
          using errcode = '22023';
    end;

    if v_line_total >= 1000000000000 then
      raise exception 'opening total_cost is out of range'
        using errcode = '22023';
    end if;

    v_factors := v_factors || v_factor;
    v_base_units := v_base_units || v_base_unit;
  end loop;

  for v_i in 1..v_count loop
    -- Still holding the posting advisory lock, so no concurrent post can
    -- insert a movement for this item until we commit or roll back.
    if exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = v_item_ids[v_i]
    ) then
      raise exception 'item already has movements: %', v_names[v_i]
        using errcode = '22023';
    end if;

    if v_expected_bases[v_i] is null or v_expected_factors[v_i] is null then
      raise exception 'expected_base_unit is required'
        using errcode = '22023';
    end if;

    if v_expected_bases[v_i] is distinct from v_base_units[v_i]
    or v_expected_factors[v_i] is distinct from v_factors[v_i] then
      raise exception 'conversion changed'
        using errcode = '40001';
    end if;

    v_movements := v_movements || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'item_id',
        v_item_ids[v_i],
        'movement_type',
        'opening',
        'occurred_at',
        p_occurred_at,
        'quantity',
        v_qtys[v_i],
        'unit',
        v_units[v_i],
        'unit_cost',
        v_costs[v_i],
        'source_type',
        'opening'
      )
    );
  end loop;

  v_batch_id := app.post_movements_internal (v_movements);

  insert into
    app.opening_stocks (id, request_id, occurred_at, created_by)
  values
    (v_batch_id, p_request_id, p_occurred_at, auth.uid ());

  for v_i in 1..v_count loop
    insert into
      app.opening_stock_lines (opening_id, line_no, item_id, quantity, unit, unit_cost)
    values
      (
        v_batch_id,
        v_i,
        v_item_ids[v_i],
        v_qtys[v_i],
        v_units[v_i],
        v_costs[v_i]
      );
  end loop;

  return v_batch_id;
end;
$$;

create or replace function app.post_sort (
  p_mixed_item uuid,
  p_occurred_at timestamptz,
  p_qty_taken numeric,
  p_sizes jsonb,
  p_shift_id text default null
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_batch_id uuid;
  v_mixed_kind text;
  v_mixed_unit text;
  v_mixed_bal app.item_balances;
  v_qty_taken numeric(20, 6);
  v_sum_sizes numeric(20, 6) := 0;
  v_loss_qty numeric(20, 6);
  v_value_taken numeric(14, 2);
  v_loss_value numeric(14, 2);
  v_sort_out_value numeric(14, 2);
  v_remaining_value numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_size_value numeric(14, 2);
  v_size_unit_cost numeric(20, 6);
  v_num_sizes int;
  v_elem jsonb;
  v_ord bigint;
  v_size_id uuid;
  v_raw_size_qty numeric;
  v_size_qty numeric(20, 6);
  v_size_kind text;
  v_size_parent uuid;
  v_size_unit text;
  v_check_items uuid[] := '{}'::uuid[];
  v_check_times timestamptz[] := '{}'::timestamptz[];
  v_check_types text[] := '{}'::text[];
  v_pending jsonb := '[]'::jsonb;
  v_key integer := 0;
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  if p_mixed_item is null or p_occurred_at is null or p_qty_taken is null then
    raise exception 'p_mixed_item, p_occurred_at, and p_qty_taken are required'
      using errcode = '22023';
  end if;

  if p_qty_taken in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'p_qty_taken must be a finite number'
      using errcode = '22023';
  end if;

  v_qty_taken := pg_catalog.round(p_qty_taken, 6);

  if v_qty_taken <= 0 then
    raise exception 'p_qty_taken must be > 0'
      using errcode = '22023';
  end if;

  select
    si.kind,
    si.base_unit
  into
    v_mixed_kind,
    v_mixed_unit
  from
    app.stock_items si
  where
    si.id = p_mixed_item;

  if not found or v_mixed_kind <> 'fish_mixed' or v_mixed_unit <> 'kg' then
    raise exception 'p_mixed_item must be a fish_mixed item in kg'
      using errcode = '22023';
  end if;

  if p_sizes is null
  or pg_catalog.jsonb_typeof(p_sizes) <> 'array'
  or pg_catalog.jsonb_array_length(p_sizes) = 0 then
    raise exception 'p_sizes must be a non-empty jsonb array'
      using errcode = '22023';
  end if;

  v_num_sizes := pg_catalog.jsonb_array_length(p_sizes);
  v_check_items := array[p_mixed_item];
  v_check_times := array[p_occurred_at];
  v_check_types := array['sort_out'::text];

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_sizes) as elem (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each size element must be a jsonb object'
        using errcode = '22023';
    end if;

    v_size_id := (v_elem ->> 'item_id')::uuid;
    v_raw_size_qty := (v_elem ->> 'quantity')::numeric;

    if v_size_id is null or v_raw_size_qty is null then
      raise exception 'each size entry requires item_id and quantity > 0'
        using errcode = '22023';
    end if;

    if v_raw_size_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'size quantity must be a finite number'
        using errcode = '22023';
    end if;

    v_size_qty := pg_catalog.round(v_raw_size_qty, 6);

    if v_size_qty <= 0 then
      raise exception 'each size entry requires item_id and quantity > 0'
        using errcode = '22023';
    end if;

    select
      si.kind,
      si.parent_item_id,
      si.base_unit
    into
      v_size_kind,
      v_size_parent,
      v_size_unit
    from
      app.stock_items si
    where
      si.id = v_size_id;

    if not found
    or v_size_kind <> 'fish_size'
    or v_size_parent is distinct from p_mixed_item
    or v_size_unit <> 'kg' then
      raise exception 'size item % is not a valid fish_size child of mixed item %',
        v_size_id,
        p_mixed_item
        using errcode = '22023';
    end if;

    v_sum_sizes := v_sum_sizes + v_size_qty;
    v_check_items := v_check_items || v_size_id;
    v_check_times := v_check_times || p_occurred_at;
    -- text[] || unknown prefers the array||array cast and rejects a bare literal.
    v_check_types := pg_catalog.array_append(v_check_types, 'sort_in');
  end loop;

  if v_sum_sizes > v_qty_taken then
    raise exception 'sum of sorted sizes (%) exceeds p_qty_taken (%)',
      v_sum_sizes,
      v_qty_taken
      using errcode = '22023';
  end if;

  v_loss_qty := v_qty_taken - v_sum_sizes;

  if not pg_catalog.isfinite(p_occurred_at) then
    raise exception 'occurred_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  perform app.assert_not_before_opening (v_check_items, v_check_times, v_check_types);

  v_batch_id := pg_catalog.gen_random_uuid();

  if app.batch_is_forward (v_check_items, v_check_times) then
    v_mixed_bal := app.lock_and_validate_item_balance (p_mixed_item, p_occurred_at);

    if v_mixed_bal.has_uncovered_deficit
    or v_mixed_bal.on_hand_qty <= 0
    or v_qty_taken > v_mixed_bal.on_hand_qty then
      raise exception 'not enough stock to sort: on_hand_qty %, requested %',
        v_mixed_bal.on_hand_qty,
        v_qty_taken
        using errcode = '22023';
    end if;

    if v_qty_taken = v_mixed_bal.on_hand_qty then
      v_value_taken := v_mixed_bal.on_hand_value;
    else
      v_value_taken := pg_catalog.round(
        v_mixed_bal.on_hand_value * v_qty_taken / v_mixed_bal.on_hand_qty,
        2
      );
    end if;

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

    v_sort_out_value := v_remaining_value;

    perform app.apply_outflow_movement (
      v_batch_id,
      p_mixed_item,
      'sort_out',
      p_occurred_at,
      v_sum_sizes,
      p_shift_id,
      'sort',
      v_batch_id::text,
      null,
      -v_sort_out_value
    );

    if v_loss_qty > 0 then
      perform app.apply_outflow_movement (
        v_batch_id,
        p_mixed_item,
        'sort_loss',
        p_occurred_at,
        v_loss_qty,
        p_shift_id,
        'sort',
        v_batch_id::text,
        null,
        -v_loss_value
      );
    end if;

    for v_elem, v_ord in
      select
        elem.value,
        elem.ord
      from
        pg_catalog.jsonb_array_elements(p_sizes) with ordinality as elem (value, ord)
    loop
      v_size_id := (v_elem ->> 'item_id')::uuid;
      v_size_qty := pg_catalog.round((v_elem ->> 'quantity')::numeric, 6);

      if v_ord = v_num_sizes then
        v_size_value := v_remaining_value;
      else
        v_size_value := pg_catalog.round(
          v_remaining_value * v_size_qty / v_remaining_qty,
          2
        );

        if v_size_value < 0 then
          v_size_value := 0;
        elsif v_size_value > v_remaining_value then
          v_size_value := v_remaining_value;
        end if;
      end if;

      v_remaining_value := v_remaining_value - v_size_value;
      v_remaining_qty := v_remaining_qty - v_size_qty;
      v_size_unit_cost := pg_catalog.round(v_size_value / v_size_qty, 6);

      perform app.apply_inflow_movement (
        v_batch_id,
        v_size_id,
        'sort_in',
        p_occurred_at,
        v_size_qty,
        v_size_unit_cost,
        p_shift_id,
        'sort',
        v_batch_id::text,
        null,
        v_size_value
      );
    end loop;
  else
    v_key := v_key + 1;
    v_pending := v_pending || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_key',
        v_key,
        'batch_id',
        v_batch_id,
        'item_id',
        p_mixed_item,
        'movement_type',
        'sort_out',
        'occurred_at',
        p_occurred_at,
        'quantity',
        -v_sum_sizes,
        'unit_cost',
        0,
        'total_cost',
        0,
        'is_input_total',
        false,
        'shift_id',
        p_shift_id,
        'source_type',
        'sort',
        'source_id',
        v_batch_id::text,
        'note',
        null
      )
    );

    if v_loss_qty > 0 then
      v_key := v_key + 1;
      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_key,
          'batch_id',
          v_batch_id,
          'item_id',
          p_mixed_item,
          'movement_type',
          'sort_loss',
          'occurred_at',
          p_occurred_at,
          'quantity',
          -v_loss_qty,
          'unit_cost',
          0,
          'total_cost',
          0,
          'is_input_total',
          false,
          'shift_id',
          p_shift_id,
          'source_type',
          'sort',
          'source_id',
          v_batch_id::text,
          'note',
          null
        )
      );
    end if;

    for v_elem in
      select
        elem.value
      from
        pg_catalog.jsonb_array_elements(p_sizes) as elem (value)
    loop
      v_key := v_key + 1;
      v_size_id := (v_elem ->> 'item_id')::uuid;
      v_size_qty := pg_catalog.round((v_elem ->> 'quantity')::numeric, 6);
      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_key,
          'batch_id',
          v_batch_id,
          'item_id',
          v_size_id,
          'movement_type',
          'sort_in',
          'occurred_at',
          p_occurred_at,
          'quantity',
          v_size_qty,
          'unit_cost',
          0,
          'total_cost',
          0,
          'is_input_total',
          false,
          'shift_id',
          p_shift_id,
          'source_type',
          'sort',
          'source_id',
          v_batch_id::text,
          'note',
          null
        )
      );
    end loop;

    perform app.post_backdated_batch (v_batch_id, v_pending);
  end if;

  return v_batch_id;
end;
$$;

create or replace function app.record_sort (p_sort jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_request_text text;
  v_request_id uuid;
  v_mixed_text text;
  v_mixed_id uuid;
  v_at_text text;
  v_occurred_at timestamptz;
  v_qty_text text;
  v_raw numeric;
  v_whole text;
  v_qty_taken numeric(20, 6);
  v_note text;
  v_elem jsonb;
  v_item_text text;
  v_size_id uuid;
  v_line_qty_text text;
  v_line_raw numeric;
  v_line_whole text;
  v_line_qty numeric(20, 6);
  v_seen uuid[] := '{}'::uuid[];
  v_size_ids uuid[] := '{}'::uuid[];
  v_qtys numeric(20, 6) [] := '{}'::numeric(20, 6) [];
  v_n integer := 0;
  v_existing_id uuid;
  v_existing_mixed uuid;
  v_existing_at timestamptz;
  v_existing_qty numeric(20, 6);
  v_existing_note text;
  v_sizes jsonb;
  v_batch_id uuid;
begin
  perform app.assert_ledger_write_allowed ();

  perform app.lock_owner_sync_shares ();

  if p_sort is null or pg_catalog.jsonb_typeof(p_sort) <> 'object' then
    raise exception 'p_sort must be a jsonb object'
      using errcode = '22023';
  end if;

  if p_sort ? 'note'
  and pg_catalog.jsonb_typeof(p_sort -> 'note') not in ('string', 'null') then
    raise exception 'note must be text'
      using errcode = '22023';
  end if;

  v_request_text := nullif(pg_catalog.btrim(p_sort ->> 'request_id'), '');

  if v_request_text is null
  or v_request_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  v_request_id := v_request_text::uuid;
  v_mixed_text := nullif(pg_catalog.btrim(p_sort ->> 'mixed_item_id'), '');

  if v_mixed_text is null then
    raise exception 'mixed_item_id is required'
      using errcode = '22023';
  end if;

  if v_mixed_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'mixed_item_id must be a uuid'
      using errcode = '22023';
  end if;

  v_mixed_id := v_mixed_text::uuid;
  v_at_text := nullif(pg_catalog.btrim(p_sort ->> 'occurred_at'), '');

  if v_at_text is null then
    raise exception 'occurred_at is required'
      using errcode = '22023';
  end if;

  begin
    v_occurred_at := v_at_text::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception 'occurred_at must be a finite timestamp'
        using errcode = '22023';
  end;

  if v_occurred_at is null or not pg_catalog.isfinite(v_occurred_at) then
    raise exception 'occurred_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  v_qty_text := nullif(pg_catalog.btrim(p_sort ->> 'qty_taken'), '');

  if v_qty_text is null or v_qty_text !~ '^\d+(\.\d+)?$' then
    raise exception 'qty_taken must be a finite number > 0'
      using errcode = '22023';
  end if;

  if v_qty_text ~ '\.\d{7,}' then
    raise exception 'qty_taken must have at most 6 decimal places'
      using errcode = '22023';
  end if;

  v_whole := pg_catalog.ltrim(pg_catalog.split_part(v_qty_text, '.', 1), '0');

  if v_whole = '' then
    v_whole := '0';
  end if;

  if pg_catalog.char_length(v_whole) > 14 then
    raise exception 'qty_taken is out of range'
      using errcode = '22023';
  end if;

  begin
    v_raw := v_qty_text::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'qty_taken must be a finite number > 0'
        using errcode = '22023';
  end;

  if v_raw <> pg_catalog.round(v_raw, 6) then
    raise exception 'qty_taken must have at most 6 decimal places'
      using errcode = '22023';
  end if;

  if v_raw <= 0 or v_raw >= 100000000000000 then
    raise exception 'qty_taken must be a finite number > 0'
      using errcode = '22023';
  end if;

  v_qty_taken := v_raw;
  v_note := nullif(pg_catalog.btrim(p_sort ->> 'note'), '');

  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    raise exception 'note must be at most 500 characters'
      using errcode = '22023';
  end if;

  perform app.assert_no_phone_text (v_note);

  if pg_catalog.jsonb_typeof(p_sort -> 'lines') is distinct from 'array'
  or pg_catalog.jsonb_array_length(p_sort -> 'lines') < 1
  or pg_catalog.jsonb_array_length(p_sort -> 'lines') > 20 then
    raise exception 'lines must be a jsonb array of 1 to 20 size lines'
      using errcode = '22023';
  end if;

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_sort -> 'lines') as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each size line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_text := nullif(pg_catalog.btrim(v_elem ->> 'item_id'), '');
    v_line_qty_text := nullif(pg_catalog.btrim(v_elem ->> 'quantity'), '');

    if v_item_text is null or v_line_qty_text is null then
      raise exception 'item_id and quantity are required'
        using errcode = '22023';
    end if;

    if v_item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'item_id must be a uuid'
        using errcode = '22023';
    end if;

    v_size_id := v_item_text::uuid;

    if v_size_id = any (v_seen) then
      raise exception 'duplicate size item'
        using errcode = '22023';
    end if;

    if v_line_qty_text !~ '^\d+(\.\d+)?$' then
      raise exception 'quantity must be a finite number > 0'
        using errcode = '22023';
    end if;

    if v_line_qty_text ~ '\.\d{7,}' then
      raise exception 'quantity must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    v_line_whole := pg_catalog.ltrim(
      pg_catalog.split_part(v_line_qty_text, '.', 1),
      '0'
    );

    if v_line_whole = '' then
      v_line_whole := '0';
    end if;

    if pg_catalog.char_length(v_line_whole) > 14 then
      raise exception 'quantity is out of range'
        using errcode = '22023';
    end if;

    begin
      v_line_raw := v_line_qty_text::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'quantity must be a finite number > 0'
          using errcode = '22023';
    end;

    if v_line_raw <> pg_catalog.round(v_line_raw, 6) then
      raise exception 'quantity must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    if v_line_raw <= 0 or v_line_raw >= 100000000000000 then
      raise exception 'quantity must be a finite number > 0'
        using errcode = '22023';
    end if;

    v_line_qty := v_line_raw;
    v_seen := v_seen || v_size_id;
    v_size_ids := v_size_ids || v_size_id;
    v_qtys := v_qtys || v_line_qty;
    v_n := v_n + 1;
  end loop;

  -- Replay compares the normalized payload only. The catalog is not read
  -- here, so a later rename still returns the saved batch. The advisory lock
  -- serializes this lookup with every other ledger write.
  select
    batch.id,
    batch.mixed_item_id,
    batch.occurred_at,
    batch.qty_taken,
    batch.note
  into
    v_existing_id,
    v_existing_mixed,
    v_existing_at,
    v_existing_qty,
    v_existing_note
  from
    app.sort_batches batch
  where
    batch.request_id = v_request_id;

  if found then
    if v_existing_mixed is distinct from v_mixed_id
    or v_existing_at is distinct from v_occurred_at
    or v_existing_qty is distinct from v_qty_taken
    or v_existing_note is distinct from v_note
    or (
      select
        count(*)
      from
        app.sort_batch_lines line
      where
        line.batch_id = v_existing_id
    ) is distinct from v_n::bigint
    or exists (
      select
        1
      from
        app.sort_batch_lines line
        join rows from (
          pg_catalog.unnest(v_size_ids),
          pg_catalog.unnest(v_qtys)
        ) with ordinality as u (size_item_id, quantity, line_no) on u.line_no = line.line_no
      where
        line.batch_id = v_existing_id
        and (
          line.size_item_id is distinct from u.size_item_id
          or line.quantity is distinct from u.quantity
        )
    ) then
      raise exception 'request_id already used for a different sort'
        using errcode = '22023';
    end if;

    return v_existing_id;
  end if;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id',
          u.size_item_id,
          'quantity',
          u.quantity
        )
        order by
          u.line_no
      ),
      '[]'::jsonb
    )
  into v_sizes
  from
    rows from (
      pg_catalog.unnest(v_size_ids),
      pg_catalog.unnest(v_qtys)
    ) with ordinality as u (size_item_id, quantity, line_no);

  begin
    v_batch_id := app.post_sort (
      v_mixed_id,
      v_occurred_at,
      v_qty_taken,
      v_sizes,
      null::text
    );
  exception
    when sqlstate '22023' then
      if pg_catalog.strpos(sqlerrm, 'not enough stock to sort:') = 1 then
        raise exception 'not enough stock to sort'
          using errcode = '22023';
      elsif pg_catalog.strpos(sqlerrm, 'sum of sorted sizes (') = 1
      and pg_catalog.strpos(sqlerrm, 'exceeds p_qty_taken (') > 0 then
        raise exception 'sum of sizes exceeds quantity taken'
          using errcode = '22023';
      elsif pg_catalog.strpos(sqlerrm, 'size item ') = 1
      and pg_catalog.strpos(
        sqlerrm,
        'is not a valid fish_size child of mixed item '
      ) > 0 then
        raise exception 'size item is not a child of the mixed item'
          using errcode = '22023';
      elsif sqlerrm = 'p_mixed_item must be a fish_mixed item in kg' then
        raise exception 'mixed item must be a fish_mixed item in kg'
          using errcode = '22023';
      else
        raise;
      end if;
    when sqlstate 'P0001' then
      if sqlerrm = 'back-dated movement not supported yet' then
        raise exception 'back-dated movement not supported yet'
          using errcode = 'P0001';
      end if;

      raise;
  end;

  insert into
    app.sort_batches (
      id,
      request_id,
      mixed_item_id,
      occurred_at,
      qty_taken,
      note,
      created_by
    )
  values
    (
      v_batch_id,
      v_request_id,
      v_mixed_id,
      v_occurred_at,
      v_qty_taken,
      v_note,
      auth.uid ()
    );

  for v_i in 1..v_n loop
    insert into
      app.sort_batch_lines (batch_id, line_no, size_item_id, quantity)
    values
      (v_batch_id, v_i, v_size_ids[v_i], v_qtys[v_i]);
  end loop;

  return v_batch_id;
end;
$$;

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

  perform app.lock_owner_sync_shares ();

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
        (
          select
            shift.id
          from
            app.pos_shifts shift
          where
            shift.opened_at <= v_counted_at
          union
          select
            o.shift_id
          from
            app.pos_orders o
          where
            o.ordered_at <= v_counted_at
            and o.shift_id is not null
        ) as required (id)
      where
        required.id <> all (coalesce(v_cov_presented, '{}'::text[]))
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
    v_count_id := app.post_movements_internal (v_movements);
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

create or replace function app.set_item_opening_price (
  p_request_id uuid,
  p_item_id uuid,
  p_unit_cost numeric,
  p_zero_cost_reason text,
  p_expected_current_id uuid,
  p_expected_identity text
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_cost numeric(20, 6);
  v_reason text;
  v_base text;
  v_identity text;
  v_current_id uuid;
  v_new_id uuid;
  v_superseded uuid[] := '{}'::uuid[];
  v_inserted uuid[] := '{}'::uuid[];
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_change_id bigint;
begin
  if coalesce(app.is_owner(), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  perform app.assert_ledger_write_allowed();

  perform app.lock_owner_sync_shares ();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  if p_item_id is null then
    raise exception 'item_id is required'
      using errcode = '22023';
  end if;

  if p_unit_cost is null
  or p_unit_cost in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_unit_cost < 0 then
    raise exception 'unit_cost must be finite and greater than or equal to 0'
      using errcode = '22023';
  end if;

  v_cost := pg_catalog.round(p_unit_cost, 6);

  if v_cost < 0 then
    raise exception 'unit_cost must be finite and greater than or equal to 0'
      using errcode = '22023';
  end if;

  if p_zero_cost_reason is null
  or btrim(p_zero_cost_reason) = '' then
    v_reason := null;
  else
    v_reason := btrim(p_zero_cost_reason);
  end if;

  if v_reason is not null
  and length(v_reason) > 500 then
    raise exception 'zero_cost_reason must be at most 500 characters'
      using errcode = '22023';
  end if;

  if v_cost = 0
  and v_reason is null then
    raise exception 'zero_cost_reason is required when unit_cost is 0'
      using errcode = '22023';
  end if;

  if v_cost > 0
  and v_reason is not null then
    raise exception 'zero_cost_reason must be null when unit_cost is greater than 0'
      using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'fn',
    'set_item_opening_price',
    'item_id',
    p_item_id,
    'unit_cost',
    v_cost,
    'zero_cost_reason',
    v_reason,
    'expected_current_id',
    p_expected_current_id,
    'expected_identity',
    p_expected_identity
  );

  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  select
    si.base_unit,
    si.base_unit || '|' || si.kind || '|' || coalesce(si.parent_item_id::text, '') || '|'
  into v_base,
  v_identity
  from
    app.stock_items si
  where
    si.id = p_item_id
  for update;

  if not found then
    raise exception 'unknown stock_item id: %', p_item_id
      using errcode = '22023';
  end if;

  if v_identity is distinct from p_expected_identity then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  select
    p.id
  into v_current_id
  from
    app.item_opening_prices p
  where
    p.item_id = p_item_id
    and p.superseded_change_id is null
  for update;

  if v_current_id is distinct from p_expected_current_id then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  v_new_id := pg_catalog.gen_random_uuid();
  v_inserted := pg_catalog.array_append(v_inserted, v_new_id);

  if v_current_id is not null then
    v_superseded := pg_catalog.array_append(v_superseded, v_current_id);
  end if;

  v_result := app.insert_owner_costing_change(
    p_request_id,
    null,
    v_payload,
    jsonb_build_object(
      'superseded',
      pg_catalog.to_jsonb(v_superseded),
      'inserted',
      pg_catalog.to_jsonb(v_inserted),
      'current_id',
      v_new_id
    )
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  if v_current_id is not null then
    update app.item_opening_prices
    set
      superseded_change_id = v_change_id
    where
      id = v_current_id;
  end if;

  insert into
    app.item_opening_prices (id, item_id, base_unit, unit_cost, zero_cost_reason, approved_by, created_change_id)
  values
    (
      v_new_id,
      p_item_id,
      v_base,
      v_cost,
      v_reason,
      auth.uid (),
      v_change_id
    );

  return v_result;
end;
$$;

create or replace function app.set_order_disposition (
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

  v_applicable := coalesce(
    (
      p_decision = 'not_made'
      and v_class = 'partial_refund'
    )
    or (
      p_decision = 'made'
      and app.disposition_family (v_class) = 'terminal'
    ),
    false
  );

  if v_ret is not null
  and pg_catalog.jsonb_array_length(v_ret) > 0
  and not v_applicable then
    raise exception 'returned quantities apply only to a not-made partial refund or a made canceled, missing or fully refunded order'
      using errcode = '22023';
  end if;

  v_r := coalesce(v_ret, v_ev.returned);

  -- A confirmed allocation is checked against the current basis whether or
  -- not it affects this posting: a retained one is stored on the new event, so
  -- it must fit, or the owner clears it.
  if pg_catalog.jsonb_array_length(v_r) > 0 then
    if v_ctx ->> 'q_status' <> 'ready' then
      raise exception '%',
      case
        when v_applicable then 'the preparation basis is not available'
        else 'the retained returned quantities need a preparation basis; clear them or choose the decision they apply to'
      end
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
      raise exception '%',
      case
        when v_applicable then 'returned quantities must be listed items and not exceed the prepared quantities'
        else 'the retained returned quantities no longer fit the preparation basis; clear them or choose the decision they apply to'
      end
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
    is_open = true,
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

  perform app.enqueue_accounting_event (
    p_order_id,
    'decision',
    'decision:' || v_new::text,
    v_input.id,
    null
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

create or replace function app.trg_pos_cost_inputs_work_event () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  perform app.enqueue_accounting_event (
    new.order_id,
    'pos_input',
    'input:' || new.id::text,
    new.id,
    null
  );

  return null;
end;
$$;

create or replace function app.trg_wake_cost_basis_blockers () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_order text;
begin
  for v_order in
    select
      state.order_id
    from
      app.accounting_work_state state
    where
      state.last_outcome = 'blocked'
      and state.last_reason = 'missing_cost_basis'
      and state.blocked_item_ids @> pg_catalog.array_fill(new.item_id, array[1])
    order by
      state.order_id
  loop
    perform app.enqueue_accounting_event (
      v_order,
      'cost_basis',
      tg_argv[0] || ':' || new.id::text || ':' || v_order,
      null,
      null
    );
  end loop;

  return null;
end;
$$;

create or replace function app.accounting_pending_orders (p_limit integer) returns table (
  order_id text,
  has_new boolean,
  eff_generation integer
) language sql stable security definer
set
  search_path = '' as $$
  select
    queue.order_id,
    queue.has_new,
    queue.eff_generation
  from
    app.accounting_work_queue queue
  where
    queue.eligible
  order by
    queue.occurrence_at nulls last,
    queue.order_id
  limit
    p_limit;
$$;

create or replace function app.accounting_order_pending (p_order_id text) returns table (has_new boolean, eff_generation integer) language sql stable security definer
set
  search_path = '' as $$
  select
    queue.has_new,
    queue.eff_generation
  from
    app.accounting_work_queue queue
  where
    queue.order_id = p_order_id
    and queue.eligible;
$$;

create or replace view app.accounting_revision_differences
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
      )::numeric(14, 2) as count_difference,
      coalesce(
        sum(movement.total_cost) filter (
          where
            movement.movement_type = 'closed_period'::app.movement_type
        ),
        0
      )::numeric(14, 2) as inventory_difference
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
            when movement.movement_type = 'closed_period'::app.movement_type then case movement.closed_bucket
              when 'cogs' then 'cogs'
              when 'waste' then 'waste'
              when 'count' then 'count'
              when 'inventory' then 'inventory'
              else null
            end
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
          bucket.bucket in ('cogs', 'waste', 'count', 'inventory')
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
      ledger.count_difference,
      ledger.inventory_difference
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
      events.inventory_difference,
      (
        events.net_sales_difference - events.cogs_difference - events.waste_difference - events.count_difference
      )::numeric(14, 2) as profit_difference,
      sum(events.net_sales_difference) over shift_order as cumulative_net_sales_difference,
      sum(events.cogs_difference) over shift_order as cumulative_cogs_difference,
      sum(events.waste_difference) over shift_order as cumulative_waste_difference,
      sum(events.count_difference) over shift_order as cumulative_count_difference,
      sum(events.inventory_difference) over shift_order as cumulative_inventory_difference,
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
  )::numeric(14, 2)::text as cumulative_profit_difference,
  rolled.inventory_difference::numeric(14, 2)::text as inventory_difference,
  rolled.cumulative_inventory_difference::numeric(14, 2)::text as cumulative_inventory_difference
from
  rolled;

create or replace function app.list_shift_accounting_status (
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
  v_expenses boolean;
  v_month date;
  v_causes text[];
  v_label text;
  v_revised boolean;
  v_latest jsonb;
  v_cumulative jsonb;
  v_history jsonb;
  v_page_ids text[];
  v_page_revisions jsonb;
  v_order_coverage jsonb;
  v_sync_by_shift jsonb;
  v_open_by_shift jsonb;
  v_pending_by_shift jsonb;
  v_blocked_by_shift jsonb;
  v_stale_by_shift jsonb;
  v_incomplete_by_shift jsonb;
  v_tracking_by_shift jsonb;
  v_unreviewed_by_shift jsonb;
  v_preparation_by_shift jsonb;
  v_refunds_by_shift jsonb;
  v_deficit_by_shift jsonb;
  v_missing_by_shift jsonb;
  v_expenses_by_month jsonb;
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
    'inventory_difference',
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

  v_opening := app.coverage_stock_start ();

  select
    coalesce(
      pg_catalog.array_agg(
        page.id
        order by
          page.opened_at,
          page.id
      ),
      '{}'::text[]
    )
  into v_page_ids
  from
    (
      select
        shift.id,
        shift.opened_at
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
    ) page;

  -- Same rows as shift_count_coverage for this page. The view proves every
  -- count in the database before the shift filter applies, so a year of
  -- orders makes each proof scan the order table. Anchors are lagged once,
  -- and the scope proof runs only for a count that covers a shift on the page.
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
        (
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
              where
                shift.id = any (v_page_ids)
            ),
            chosen as materialized (
              select
                roster.shift_id,
                roster.item_id,
                roster.count_frequency,
                roster.known_since,
                cover.count_id,
                cover.counted_at,
                cover.interval_start,
                cover.owning_shift_id
              from
                roster
                left join lateral (
                  select
                    anchor.count_id,
                    anchor.counted_at,
                    anchor.interval_start,
                    anchor.owning_shift_id
                  from
                    anchors anchor
                  where
                    anchor.item_id = roster.item_id
                    and anchor.frequency = roster.count_frequency
                    and (
                      (
                        roster.count_frequency = 'daily'
                        and anchor.owning_shift_id = roster.shift_id
                      )
                      or (
                        roster.count_frequency = 'weekly'
                        and roster.opened_at > coalesce(
                          anchor.interval_start,
                          '-infinity'::timestamptz
                        )
                        and roster.opened_at <= anchor.counted_at
                      )
                    )
                  order by
                    anchor.counted_at desc,
                    anchor.count_id desc,
                    anchor.line_no desc
                  limit
                    1
                ) cover on true
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
                    chosen.counted_at
                  from
                    chosen
                  where
                    chosen.count_id is not null
                ) times
            )
          select
            chosen.shift_id,
            chosen.item_id,
            chosen.count_frequency,
            chosen.known_since,
            chosen.count_id as anchor_count_id,
            chosen.counted_at as anchor_counted_at,
            chosen.interval_start,
            chosen.counted_at as interval_end,
            chosen.owning_shift_id,
            scope.interval_owning_shift_id,
            scope.sync_scope_covered,
            (chosen.count_id is not null) as covered
          from
            chosen
            left join scope on scope.counted_at = chosen.counted_at
        ) coverage
      group by
        coverage.shift_id
    ) page;

  -- One read of this page's revision rows. The difference view builds a
  -- receipt map for every batch before its shift filter can apply, so this
  -- copy keeps the same cause shape and only the shifts on the page.
  select
    coalesce(
      pg_catalog.jsonb_object_agg(grouped.shift_id, grouped.history),
      '{}'::jsonb
    )
  into v_page_revisions
  from
    (
      select
        diff.shift_id,
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
            'inventory_difference',
            diff.inventory_difference,
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
            'cumulative_inventory_difference',
            diff.cumulative_inventory_difference,
            'cumulative_profit_difference',
            diff.cumulative_profit_difference
          )
          order by
            diff.captured_at,
            diff.cause_sort nulls last,
            diff.cause_kind,
            diff.cause_id
        ) as history
      from
        (
          with
            page_batches as (
              select distinct
                revision.cause_batch_id as batch_id
              from
                app.period_revisions revision
              where
                revision.shift_id = any (v_page_ids)
            ),
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
                    application.retire_batch in (
                      select
                        page_batches.batch_id
                      from
                        page_batches
                    )
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
                    application.posting_batch in (
                      select
                        page_batches.batch_id
                      from
                        page_batches
                    )
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
                    document.retire_batch_id in (
                      select
                        page_batches.batch_id
                      from
                        page_batches
                    )
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
                    document.batch_id in (
                      select
                        page_batches.batch_id
                      from
                        page_batches
                    )
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
                min(coalesce(receipt.captured_at, revision.created_at)) as captured_at,
                min(coalesce(receipt.economic_at, movement.occurred_at)) as source_at,
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
                )::numeric(14, 2) as count_difference,
      coalesce(sum(movement.total_cost) filter (
        where movement.movement_type = 'closed_period'::app.movement_type
      ), 0)::numeric(14, 2) as inventory_difference
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
                      when movement.movement_type = 'closed_period'::app.movement_type then case movement.closed_bucket
                        when 'cogs' then 'cogs'
                        when 'waste' then 'waste'
                        when 'count' then 'count'
                        when 'inventory' then 'inventory'
                        else null
                      end
                      else null
                    end as bucket
                ) bucket
                left join receipts receipt on receipt.batch_id = revision.cause_batch_id
              where
                revision.shift_id = any (v_page_ids)
              group by
                1,
                2,
                3,
                revision.shift_id
              having
                count(*) filter (
                  where
                    bucket.bucket in ('cogs', 'waste', 'count', 'inventory')
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
                ledger.count_difference,
              ledger.inventory_difference
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
                0::numeric(14, 2),
      0::numeric(14, 2)
              from
                app.sales_revision_facts fact
              where
                fact.shift_id = any (v_page_ids)
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
                events.inventory_difference,
                (
                  events.net_sales_difference - events.cogs_difference - events.waste_difference - events.count_difference
                )::numeric(14, 2) as profit_difference,
                sum(events.net_sales_difference) over shift_order as cumulative_net_sales_difference,
                sum(events.cogs_difference) over shift_order as cumulative_cogs_difference,
                sum(events.waste_difference) over shift_order as cumulative_waste_difference,
                sum(events.count_difference) over shift_order as cumulative_count_difference,
      sum(events.inventory_difference) over shift_order as cumulative_inventory_difference,
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
            )::numeric(14, 2)::text as cumulative_profit_difference,
            rolled.inventory_difference::numeric(14, 2)::text as inventory_difference,
            rolled.cumulative_inventory_difference::numeric(14, 2)::text as cumulative_inventory_difference
          from
            rolled
        ) diff
      group by
        diff.shift_id
    ) grouped;

  -- A receipt answers only when it proves the resolver's current result.
  -- Every other order on the page is resolved again.
  v_order_coverage := coalesce(
    app.shift_page_order_coverage (v_page_ids, v_opening),
    '{}'::jsonb
  );

  -- One pass over the page. The shift loop used to repeat each of these scans.
  select
    coalesce(
      pg_catalog.jsonb_object_agg(
        hit.shift_id,
        pg_catalog.jsonb_build_object('covered', hit.covered, 'finished', hit.finished)
      ),
      '{}'::jsonb
    )
  into v_sync_by_shift
  from
    (
      select
        shift.id as shift_id,
        coalesce(pg_catalog.bool_or(probe.covers), false) as covered,
        max(probe.finished_at) filter (
          where
            probe.covers
        ) as finished
      from
        app.pos_shifts shift
        left join lateral (
          select
            cov.finished_at,
            app.sync_coverage_covers_shift (
              cov.orders_scope_applied,
              cov.scope_kind,
              cov.scope_from,
              cov.scope_shift_ids,
              cov.presented_shift_ids,
              cov.legacy_direct,
              shift.id,
              shift.opened_at
            ) as covers
          from
            app.pos_sync_coverage cov
        ) probe on true
      where
        shift.id = any (v_page_ids)
      group by
        shift.id
    ) hit;

  select
    coalesce(
      pg_catalog.jsonb_object_agg(counted.shift_id, counted.n),
      '{}'::jsonb
    )
  into v_open_by_shift
  from
    (
      select
        o.shift_id,
        count(*) as n
      from
        app.pos_orders o
      where
        o.shift_id = any (v_page_ids)
        and o.status = 'active'
        and not o.missing_from_pos
      group by
        o.shift_id
    ) counted;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_pending_by_shift
  from
    (
      select
        settled.shift_id,
        count(distinct candidate.order_id) as n
      from
        (
          select
            event.order_id
          from
            app.accounting_work_events event
          where
            event.processed_at is null
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
        ) candidate
        cross join lateral app.order_settlement_shifts (candidate.order_id) settled
      where
        settled.shift_id = any (v_page_ids)
      group by
        settled.shift_id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_blocked_by_shift
  from
    (
      select
        settled.shift_id,
        count(*) as n
      from
        app.accounting_work_state state
        cross join lateral app.order_settlement_shifts (state.order_id) settled
      where
        (
          state.last_outcome = 'blocked'
          or state.failed_at is not null
        )
        and settled.shift_id = any (v_page_ids)
      group by
        settled.shift_id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_stale_by_shift
  from
    (
      select
        settled.shift_id,
        count(*) as n
      from
        app.order_cost_state state
        join app.order_cost_applications application on application.id = state.latest_application_id
        cross join lateral app.order_settlement_shifts (state.order_id) settled
      where
        state.latest_input_id is not null
        and application.cost_input_id is distinct from state.latest_input_id
        and settled.shift_id = any (v_page_ids)
      group by
        settled.shift_id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.payload), '{}'::jsonb)
  into v_incomplete_by_shift
  from
    (
      select
        settled.shift_id,
        pg_catalog.jsonb_build_object(
          'n',
          count(distinct state.order_id),
          'codes',
          coalesce(
            pg_catalog.jsonb_agg(distinct cause.value ->> 'code') filter (
              where
                cause.value ->> 'code' is not null
            ),
            '[]'::jsonb
          )
        ) as payload
      from
        app.order_cost_state state
        join app.order_cost_applications application on application.id = state.latest_application_id
        cross join lateral app.order_settlement_shifts (state.order_id) settled
        left join lateral pg_catalog.jsonb_array_elements(application.causes) as cause (value) on true
      where
        application.disposition = 'incomplete'
        and settled.shift_id = any (v_page_ids)
      group by
        settled.shift_id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_tracking_by_shift
  from
    (
      select
        shift.id as shift_id,
        count(*) as n
      from
        app.pos_shifts shift
        join app.stock_items item on item.created_at <= shift.opened_at
      where
        shift.id = any (v_page_ids)
        and exists (
          select
            1
          from
            app.item_tracking_history backfill
          where
            backfill.item_id = item.id
            and backfill.basis = 'backfill'
            and backfill.known_since > shift.opened_at
        )
        and not exists (
          select
            1
          from
            app.item_tracking_history earlier
          where
            earlier.item_id = item.id
            and earlier.known_since <= shift.opened_at
        )
      group by
        shift.id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_unreviewed_by_shift
  from
    (
      select
        o.shift_id,
        count(*) as n
      from
        app.order_disposition_state state
        join app.pos_orders o on o.id = state.order_id
        left join app.order_disposition_events event on event.id = state.event_id
      where
        o.shift_id = any (v_page_ids)
        and state.is_open
        and (
          state.review_reason is not null
          or event.owner_reviewed is not true
        )
      group by
        o.shift_id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_preparation_by_shift
  from
    (
      select
        o.shift_id,
        count(*) as n
      from
        app.order_cost_state state
        join app.pos_orders o on o.id = state.order_id
      where
        o.shift_id = any (v_page_ids)
        and exists (
          select
            1
          from
            pg_catalog.jsonb_array_elements(state.causes) as cause (value)
          where
            cause.value ->> 'code' = 'missing_preparation_basis'
        )
      group by
        o.shift_id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_refunds_by_shift
  from
    (
      select
        counted.shift_id,
        count(*) as n
      from
        (
          select
            latest.shift_id
          from
            (
              select distinct
                on (revision.shift_id, revision.tx_id) revision.shift_id,
                revision.present,
                revision.tx_type,
                revision.order_id,
                revision.amount
              from
                app.pos_refund_revisions revision
              where
                revision.shift_id = any (v_page_ids)
              order by
                revision.shift_id,
                revision.tx_id,
                revision.id desc
            ) latest
          where
            latest.present
            and latest.tx_type = 3
            and (
              latest.order_id is null
              or latest.amount < 0
            )
          union all
          select
            o.shift_id
          from
            app.order_disposition_state state
            join app.pos_orders o on o.id = state.order_id
          where
            o.shift_id = any (v_page_ids)
            and (
              state.class = 'unresolved_refund'
              or state.review_reason = 'unresolved_refund'
            )
        ) counted
      group by
        counted.shift_id
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.payload), '{}'::jsonb)
  into v_deficit_by_shift
  from
    (
      select
        coalesce(movement.shift_id, attribution.shift_id) as shift_id,
        pg_catalog.jsonb_build_object(
          'n',
          count(*),
          'qty',
          coalesce(sum(deficit.qty_uncovered), 0)
        ) as payload
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
        left join app.movement_attributions attribution on attribution.movement_id = movement.id
      where
        deficit.qty_uncovered > 0
        and coalesce(movement.shift_id, attribution.shift_id) = any (v_page_ids)
      group by
        coalesce(movement.shift_id, attribution.shift_id)
    ) hit;

  select
    coalesce(pg_catalog.jsonb_object_agg(hit.shift_id, hit.n), '{}'::jsonb)
  into v_missing_by_shift
  from
    (
      select
        o.shift_id,
        count(*) as n
      from
        app.pos_orders o
      where
        o.shift_id = any (v_page_ids)
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
        )
      group by
        o.shift_id
    ) hit;

  select
    coalesce(
      pg_catalog.jsonb_object_agg(status.month::text, status.complete),
      '{}'::jsonb
    )
  into v_expenses_by_month
  from
    app.month_expense_status status;

  for v_shift in
    select
      shift.id,
      shift.opened_at,
      shift.closed_at,
      shift.is_active
    from
      app.pos_shifts shift
    where
      shift.id = any (v_page_ids)
    order by
      shift.opened_at,
      shift.id
  loop
    v_pack := v_coverage -> v_shift.id;
    v_daily_required := coalesce((v_pack ->> 'daily_required')::integer, 0);
    v_daily_covered := coalesce((v_pack ->> 'daily_covered')::integer, 0);
    v_weekly_required := coalesce((v_pack ->> 'weekly_required')::integer, 0);
    v_weekly_covered := coalesce((v_pack ->> 'weekly_covered')::integer, 0);
    v_anchor_sync := coalesce((v_pack ->> 'anchor_sync')::boolean, true);
    v_daily := coalesce(v_pack -> 'daily', '[]'::jsonb);
    v_weekly := coalesce(v_pack -> 'weekly', '[]'::jsonb);

    v_scope_covered := coalesce(
      (v_sync_by_shift -> v_shift.id ->> 'covered')::boolean,
      false
    );
    v_finished := (v_sync_by_shift -> v_shift.id ->> 'finished')::timestamptz;

    v_budget := case
      when v_shift.opened_at >= pg_catalog.now() - interval '35 days' then interval '1 day'
      else interval '7 days'
    end;

    v_fresh := v_finished is not null
    and v_finished >= pg_catalog.now() - v_budget;

    v_open_orders := coalesce((v_open_by_shift ->> v_shift.id)::integer, 0);

    v_pending := coalesce((v_pending_by_shift ->> v_shift.id)::integer, 0);

    v_blocked := coalesce((v_blocked_by_shift ->> v_shift.id)::integer, 0);
    v_stale := coalesce((v_stale_by_shift ->> v_shift.id)::integer, 0);
    v_incomplete := coalesce((v_incomplete_by_shift -> v_shift.id ->> 'n')::integer, 0);

    select
      coalesce(pg_catalog.array_agg(code.value), '{}'::text[])
    into v_incomplete_codes
    from
      pg_catalog.jsonb_array_elements_text(
        coalesce(v_incomplete_by_shift -> v_shift.id -> 'codes', '[]'::jsonb)
      ) as code (value);

    v_tracking := coalesce((v_tracking_by_shift ->> v_shift.id)::integer, 0);
    v_unreviewed := coalesce((v_unreviewed_by_shift ->> v_shift.id)::integer, 0);
    v_preparation := coalesce((v_preparation_by_shift ->> v_shift.id)::integer, 0);
    v_refunds := coalesce((v_refunds_by_shift ->> v_shift.id)::integer, 0);
    v_deficit_count := coalesce((v_deficit_by_shift -> v_shift.id ->> 'n')::integer, 0);
    v_deficit_qty := coalesce((v_deficit_by_shift -> v_shift.id ->> 'qty')::numeric, 0);
    v_missing_cost := coalesce((v_missing_by_shift ->> v_shift.id)::integer, 0);

    -- Line coverage follows each line's own ready or exception status.
    -- An unresolved order does not zero the lines that are already eligible.
    v_orders_denom := coalesce((v_order_coverage -> v_shift.id ->> 'orders_denom')::integer, 0);
    v_orders_covered := coalesce((v_order_coverage -> v_shift.id ->> 'orders_covered')::integer, 0);
    v_lines_denom := coalesce((v_order_coverage -> v_shift.id ->> 'lines_denom')::integer, 0);
    v_lines_covered := coalesce((v_order_coverage -> v_shift.id ->> 'lines_covered')::integer, 0);

    v_month := pg_catalog.date_trunc(
      'month',
      (v_shift.opened_at at time zone 'Africa/Cairo')
    )::date;

    v_expenses := coalesce(
      (v_expenses_by_month ->> v_month::text)::boolean,
      false
    );

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

    v_history := coalesce(v_page_revisions -> v_shift.id, '[]'::jsonb);
    v_revised := pg_catalog.jsonb_typeof (v_history) = 'array'
    and pg_catalog.jsonb_array_length (v_history) > 0;
    v_latest := null;
    v_cumulative := null;

    select
      pg_catalog.jsonb_build_object(
        'net_sales_difference',
        picked.value ->> 'net_sales_difference',
        'cogs_difference',
        picked.value ->> 'cogs_difference',
        'waste_difference',
        picked.value ->> 'waste_difference',
        'count_difference',
        picked.value ->> 'count_difference',
        'inventory_difference',
        picked.value ->> 'inventory_difference',
        'profit_difference',
        picked.value ->> 'profit_difference'
      ),
      pg_catalog.jsonb_build_object(
        'net_sales_difference',
        picked.value ->> 'cumulative_net_sales_difference',
        'cogs_difference',
        picked.value ->> 'cumulative_cogs_difference',
        'waste_difference',
        picked.value ->> 'cumulative_waste_difference',
        'count_difference',
        picked.value ->> 'cumulative_count_difference',
        'inventory_difference',
        picked.value ->> 'cumulative_inventory_difference',
        'profit_difference',
        picked.value ->> 'cumulative_profit_difference'
      )
    into
      v_latest,
      v_cumulative
    from
      (
        select
          elem.value
        from
          pg_catalog.jsonb_array_elements(v_history) as elem (value)
        where
          (elem.value ->> 'is_latest')::boolean
        limit
          1
      ) picked;

    v_latest := coalesce(v_latest, v_zero);
    v_cumulative := coalesce(v_cumulative, v_zero);

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

select
  app.rebuild_accounting_queue ();

-- A deficit from before the window is carried by a closed_period row at the
-- inflow. An in-window deficit keeps the cost adjustment. Base:
-- 20261108010000_outflow_reversals.sql.
create or replace function app.apply_inflow_movement (
  p_batch_id uuid,
  p_item_id uuid,
  p_movement_type app.movement_type,
  p_occurred_at timestamptz,
  p_in_qty numeric(20, 6),
  p_in_unit_cost numeric(20, 6),
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text,
  p_in_total_cost numeric(14, 2) default null
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_bal app.item_balances;
  v_inflow_unit_cost numeric(20, 6);
  v_inflow_total_cost numeric(14, 2);
  v_delta_value numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_remaining_inflow_value numeric(14, 2);
  v_covered_qty numeric(20, 6);
  v_covered_inflow_value numeric(14, 2);
  v_covered_prov_value numeric(14, 2);
  v_adj_unit_cost numeric(20, 6);
  v_adj_total_cost numeric(14, 2);
  v_prior_pos_qty numeric(20, 6);
  v_on_hand_value_after_cover numeric(14, 2);
  v_new_avg_cost numeric(20, 6);
  v_has_deficit boolean;
  r_def record;
  v_adj_id bigint;
  v_target_shift text;
  v_inflow_id bigint;
  v_window timestamptz;
  v_closed_cover boolean := false;
  v_bucket text;
begin
  if p_in_qty is null
  or p_in_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_in_qty <= 0 then
    raise exception 'inflow quantity must be a finite number > 0'
      using errcode = '22023';
  end if;

  v_bal := app.lock_and_validate_item_balance (p_item_id, p_occurred_at);

  if p_movement_type = 'count_adjustment' then
    v_inflow_unit_cost := v_bal.avg_cost;
  else
    v_inflow_unit_cost := p_in_unit_cost;
  end if;

  if v_inflow_unit_cost is null
  or v_inflow_unit_cost in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or v_inflow_unit_cost < 0 then
    raise exception 'inflow unit_cost must be a finite number >= 0'
      using errcode = '22023';
  end if;

  if p_in_total_cost is not null then
    if p_in_total_cost in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or p_in_total_cost < 0 then
      raise exception 'inflow total_cost must be a finite number >= 0'
        using errcode = '22023';
    end if;
    v_inflow_total_cost := p_in_total_cost;
  else
    v_inflow_total_cost := pg_catalog.round(p_in_qty * v_inflow_unit_cost, 2);
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
      shift_id,
      source_type,
      source_id,
      note
    )
  values
    (
      p_batch_id,
      p_item_id,
      p_movement_type,
      p_occurred_at,
      p_in_qty,
      v_inflow_unit_cost,
      v_inflow_total_cost,
      false,
      p_shift_id,
      p_source_type,
      p_source_id,
      p_note
    )
  returning
    id into v_inflow_id;

  v_window := app.restatement_window_start ();

  v_delta_value := v_inflow_total_cost;
  v_remaining_qty := p_in_qty;
  v_remaining_inflow_value := v_inflow_total_cost;

  -- Cover uncovered deficits in logical order: occurred_at, ordinary before count, event position, piece, id.
  for r_def in
    select
      pd.movement_id,
      pd.qty_uncovered,
      pd.value_uncovered,
      pd.provisional_unit_cost,
      sm.movement_type as prov_type,
      sm.occurred_at as prov_at
    from
      app.provisional_deficits pd
      join app.stock_movements sm on sm.id = pd.movement_id
    where
      pd.item_id = p_item_id
      and pd.qty_uncovered > 0
    order by
      sm.occurred_at asc,
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
      end asc,
      coalesce(sm.event_position, sm.id) asc,
      coalesce(sm.piece_position, 0) asc,
      sm.id asc
    for update of pd
  loop
    exit when v_remaining_qty <= 0;

    v_covered_qty := least(v_remaining_qty, r_def.qty_uncovered);

    if v_covered_qty = v_remaining_qty then
      v_covered_inflow_value := v_remaining_inflow_value;
    else
      v_covered_inflow_value := pg_catalog.round(
        v_remaining_inflow_value * v_covered_qty / v_remaining_qty,
        2
      );
    end if;

    -- Conserve the original provisional value. A cover of the whole remainder
    -- takes value_uncovered exactly; a partial cover takes its quantity share,
    -- rounded to the piaster. provisional_unit_cost stays for unit_cost only.
    if v_covered_qty = r_def.qty_uncovered then
      v_covered_prov_value := r_def.value_uncovered;
    else
      v_covered_prov_value := pg_catalog.round(
        r_def.value_uncovered * v_covered_qty / r_def.qty_uncovered,
        2
      );
    end if;

    v_adj_unit_cost := v_inflow_unit_cost - r_def.provisional_unit_cost;
    v_adj_total_cost := -(v_covered_inflow_value - v_covered_prov_value);

    if r_def.prov_at < v_window then
      v_closed_cover := true;
      v_bucket := case r_def.prov_type
        when 'waste'::app.movement_type then 'waste'
        when 'sort_loss'::app.movement_type then 'waste'
        else 'cogs'
      end;

      perform app.insert_closed_movement (
        p_batch_id,
        p_item_id,
        p_occurred_at,
        0,
        v_adj_total_cost,
        v_bucket,
        null,
        app.closed_containing_shift (p_occurred_at),
        'cover',
        r_def.movement_id::text,
        null,
        null,
        null,
        v_inflow_id,
        r_def.movement_id,
        null,
        1
      );
    else
      v_target_shift := app.shift_for_target (r_def.movement_id);

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
          source_id,
          note
        )
      values
        (
          p_batch_id,
          p_item_id,
          'cost_adjustment',
          r_def.prov_at,
          0,
          v_adj_unit_cost,
          v_adj_total_cost,
          false,
          r_def.movement_id,
          v_target_shift,
          p_source_type,
          p_source_id,
          p_note
        )
      returning
        id into v_adj_id;

      perform app.note_period_revision (
        v_adj_id,
        v_target_shift,
        app.profit_bucket (r_def.prov_type),
        v_adj_total_cost,
        p_item_id,
        p_batch_id
      );

      -- An open cover is dated on the deficit, so a later inflow cannot resume
      -- from a cut that sits between the deficit and the cover.
      perform app.invalidate_checkpoints_from (p_item_id, r_def.prov_at, 'cover');
    end if;

    update app.provisional_deficits
    set
      qty_uncovered = qty_uncovered - v_covered_qty,
      value_uncovered = value_uncovered - v_covered_prov_value
    where
      movement_id = r_def.movement_id;

    v_remaining_qty := v_remaining_qty - v_covered_qty;
    v_remaining_inflow_value := v_remaining_inflow_value - v_covered_inflow_value;
    v_delta_value := v_delta_value + v_adj_total_cost;
  end loop;

  if v_closed_cover then
    perform app.invalidate_checkpoints_from (p_item_id, p_occurred_at, 'cover');
  end if;

  v_prior_pos_qty := greatest(v_bal.on_hand_qty, 0::numeric(20, 6));
  v_on_hand_value_after_cover := case
    when v_bal.on_hand_qty > 0 then greatest(v_bal.on_hand_value, 0::numeric(14, 2))
    else 0::numeric(14, 2)
  end;

  if v_prior_pos_qty + v_remaining_qty > 0 then
    v_new_avg_cost := pg_catalog.round(
      (v_on_hand_value_after_cover + v_remaining_inflow_value) / (v_prior_pos_qty + v_remaining_qty),
      6
    );
  elsif p_movement_type in ('purchase', 'sort_in')
  or (
    p_movement_type = 'opening'
    and v_inflow_unit_cost > 0
  ) then
    v_new_avg_cost := v_inflow_unit_cost;
  else
    v_new_avg_cost := v_bal.avg_cost;
  end if;

  select
    exists (
      select
        1
      from
        app.provisional_deficits pd
      where
        pd.item_id = p_item_id
        and pd.qty_uncovered > 0
    )
  into v_has_deficit;

  -- Put any piaster rounding remainder on on_hand_value so ledger sum == on_hand_value at all times.
  update app.item_balances
  set
    on_hand_qty = v_bal.on_hand_qty + p_in_qty,
    on_hand_value = v_bal.on_hand_value + v_delta_value,
    avg_cost = v_new_avg_cost,
    last_occurred_at = p_occurred_at,
    has_uncovered_deficit = v_has_deficit
  where
    item_id = p_item_id;
end;
$$;

-- A closed correction keeps the predecessor and posts the difference. It has a
-- posting batch and no reversal batch. A closed void keeps batch_id null and
-- stores the return batch in retire_batch_id.
alter table app.waste_documents
drop constraint waste_documents_retire_chk;

alter table app.waste_documents
add constraint waste_documents_retire_chk check (
  (
    predecessor_id is null
    and retire_batch_id is null
  )
  or (
    predecessor_id is not null
    and retire_batch_id is not null
  )
  or (
    predecessor_id is not null
    and retire_batch_id is null
    and batch_id is not null
    and not is_void
  )
);

comment on column app.waste_documents.retire_batch_id is 'Batch that removed the predecessor''s effect. An in-window correction stores the reversal batch. A closed void stores the return batch. A closed correction that still posts a replacement leaves this null. Null for a first document.';

create or replace function app.record_waste (p_request_id uuid, p_document jsonb) returns jsonb language plpgsql volatile security definer
set
  search_path = ''
set
  lock_timeout = '2s'
set
  statement_timeout = '15s' as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pred_text text;
  v_pred bigint;
  v_n integer;
  v_void boolean;
  v_at_text text;
  v_at timestamptz;
  v_reason text;
  v_expl text;
  v_elem jsonb;
  v_ord bigint;
  v_item uuid;
  v_qty numeric;
  v_unit text;
  v_code text;
  v_base text;
  v_factor numeric;
  v_source text;
  v_ver uuid;
  v_base_qty numeric;
  v_norm jsonb := '[]'::jsonb;
  v_res jsonb := '[]'::jsonb;
  v_seen uuid[] := '{}'::uuid[];
  v_hash text;
  v_req record;
  v_prev app.waste_documents%rowtype;
  v_shift text;
  v_event bigint;
  v_items uuid[];
  v_old_ids bigint[];
  v_retire_batch uuid := null;
  v_batch uuid := null;
  v_lines jsonb;
  v_detail text;
  v_blocked uuid[];
  v_doc bigint;
  v_diff record;
  v_kind text;
  v_result jsonb;
  v_closed_waste boolean := false;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_request_id is null
  or p_document is null
  or pg_catalog.jsonb_typeof (p_document) <> 'object'
  or exists (
    select
      1
    from
      pg_catalog.jsonb_object_keys(p_document) k
    where
      k not in (
        'occurred_at',
        'reason_code',
        'explanation',
        'predecessor_id',
        'lines'
      )
  )
  or pg_catalog.jsonb_typeof (p_document -> 'lines') is distinct from 'array'
  or pg_catalog.jsonb_typeof (p_document -> 'predecessor_id') not in ('string', 'null')
  or pg_catalog.jsonb_typeof (p_document -> 'occurred_at') not in ('string', 'null')
  or pg_catalog.jsonb_typeof (p_document -> 'reason_code') not in ('string', 'null')
  or pg_catalog.jsonb_typeof (p_document -> 'explanation') not in ('string', 'null') then
    raise exception 'invalid waste document'
      using errcode = '22023';
  end if;

  v_pred_text := p_document ->> 'predecessor_id';

  if v_pred_text is not null
  and v_pred_text !~ '^[1-9][0-9]{0,17}$' then
    raise exception 'invalid predecessor id'
      using errcode = '22023';
  end if;

  v_pred := v_pred_text::bigint;
  v_n := pg_catalog.jsonb_array_length(p_document -> 'lines');

  if v_n > 50 then
    raise exception 'a waste document has at most 50 lines'
      using errcode = '22023';
  end if;

  if v_n = 0
  and v_pred is null then
    raise exception 'a waste document needs at least one line'
      using errcode = '22023';
  end if;

  v_void := v_n = 0;

  if v_void then
    if (p_document ->> 'occurred_at') is not null
    or (p_document ->> 'reason_code') is not null
    or (p_document ->> 'explanation') is not null then
      raise exception 'a void carries no time, reason or explanation'
        using errcode = '22023';
    end if;
  else
    v_at_text := p_document ->> 'occurred_at';
    v_reason := p_document ->> 'reason_code';
    v_expl := nullif(pg_catalog.btrim (p_document ->> 'explanation'), '');

    if v_at_text is null
    or v_at_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      raise exception 'occurred_at must be an ISO timestamp with an offset'
        using errcode = '22023';
    end if;

    begin
      v_at := v_at_text::timestamptz;
    exception
      when others then
        raise exception 'occurred_at is not a valid timestamp'
          using errcode = '22023';
    end;

    if v_reason = 'cancel_after_preparation' then
      raise exception 'cancel_after_preparation is recorded by the system only'
        using errcode = '22023';
    end if;

    if v_reason is null
    or v_reason not in ('staff_meal', 'spoilage', 'other') then
      raise exception 'unknown waste reason'
        using errcode = '22023';
    end if;

    if v_expl is not null
    and length(v_expl) > 300 then
      raise exception 'explanation is longer than 300 characters'
        using errcode = '22023';
    end if;

    if v_reason = 'other'
    and v_expl is null then
      raise exception 'an explanation is required for the reason other'
        using errcode = '22023';
    end if;

    for v_elem in
      select
        e.value
      from
        pg_catalog.jsonb_array_elements(p_document -> 'lines') as e (value)
    loop
      if pg_catalog.jsonb_typeof (v_elem) <> 'object'
      or (
        select
          count(*)
        from
          pg_catalog.jsonb_object_keys(v_elem)
      ) <> 3
      or pg_catalog.jsonb_typeof (v_elem -> 'item_id') is distinct from 'string'
      or pg_catalog.jsonb_typeof (v_elem -> 'quantity') is distinct from 'string'
      or pg_catalog.jsonb_typeof (v_elem -> 'unit') is distinct from 'string'
      or pg_catalog.lower (v_elem ->> 'item_id') !~ c_uuid
      or v_elem ->> 'quantity' !~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' then
        raise exception 'each line is {item_id, quantity, unit} with decimal text'
          using errcode = '22023';
      end if;

      v_item := pg_catalog.lower (v_elem ->> 'item_id')::uuid;
      v_qty := (v_elem ->> 'quantity')::numeric;
      v_unit := pg_catalog.btrim (v_elem ->> 'unit');

      if v_qty <= 0 then
        raise exception 'quantity must be greater than zero'
          using errcode = '22023';
      end if;

      if v_unit = ''
      or length(v_unit) > 20 then
        raise exception 'invalid unit'
          using errcode = '22023';
      end if;

      if v_item = any (v_seen) then
        raise exception 'a stock item is listed twice'
          using errcode = '22023';
      end if;

      v_seen := v_seen || v_item;
      v_norm := v_norm || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id',
          v_item,
          'quantity',
          pg_catalog.trim_scale (v_qty)::text,
          'unit',
          v_unit
        )
      );
    end loop;
  end if;

  v_hash := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'predecessor_id',
      v_pred_text,
      'occurred_at',
      app.costing_timestamptz_text (v_at),
      'reason_code',
      v_reason,
      'explanation',
      v_expl,
      'lines',
      v_norm
    )::text
  );

  -- Replay: the stored result, before any mutable state is read.
  select
    r.*
  into v_req
  from
    app.waste_requests r
  where
    r.request_id = p_request_id;

  if found then
    if v_req.payload_hash <> v_hash then
      raise exception 'request id was used for a different waste document'
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
    raise exception 'inventory is not activated'
      using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  select
    r.*
  into v_req
  from
    app.waste_requests r
  where
    r.request_id = p_request_id;

  if found then
    if v_req.payload_hash <> v_hash then
      raise exception 'request id was used for a different waste document'
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

  if v_pred is not null then
    select
      d.*
    into v_prev
    from
      app.waste_documents d
    where
      d.id = v_pred;

    if not found then
      raise exception 'unknown waste document'
        using errcode = '22023';
    end if;

    if exists (
      select
        1
      from
        app.waste_documents s
      where
        s.predecessor_id = v_pred
    ) then
      raise exception 'the waste document was already corrected'
        using errcode = '40001';
    end if;

    if v_prev.is_void then
      raise exception 'a voided waste document cannot be corrected'
        using errcode = '22023';
    end if;

    select
      pg_catalog.array_agg(
        wm.movement_id
        order by
          wm.movement_id
      )
    into v_old_ids
    from
      app.waste_line_movements wm
    where
      wm.document_id = v_pred;
  end if;

  if v_void then
    v_at := v_prev.occurred_at;
    v_reason := v_prev.reason_code;
    v_expl := v_prev.explanation;
    v_shift := v_prev.shift_id;
  else
    v_shift := app.resolve_shift_id (v_at);

    for v_elem, v_ord in
      select
        e.value,
        e.ordinality
      from
        pg_catalog.jsonb_array_elements(v_norm) with ordinality as e (value, ordinality)
    loop
      v_item := (v_elem ->> 'item_id')::uuid;
      v_qty := (v_elem ->> 'quantity')::numeric;

      select
        si.base_unit
      into v_base
      from
        app.stock_items si
      where
        si.id = v_item;

      if not found then
        raise exception 'unknown stock item'
          using errcode = '22023';
      end if;

      v_code := app.resolve_unit_code (v_elem ->> 'unit');

      if v_code is null then
        raise exception 'unknown unit'
          using errcode = '22023';
      end if;

      v_factor := app.item_factor_at (v_item, v_code, v_at);
      v_ver := null;

      if v_code = v_base then
        v_source := 'base';
      else
        select
          v.id
        into v_ver
        from
          app.item_conversion_versions v
        where
          v.item_id = v_item
          and v.unit_code = v_code
          and v.superseded_change_id is null
          and v.valid_during @> v_at;

        v_source := case
          when found then 'explicit'
          else 'metric'
        end;
      end if;

      if v_qty * v_factor >= 100000000000000::numeric then
        raise exception 'quantity is too large'
          using errcode = '22023';
      end if;

      v_base_qty := pg_catalog.round(v_qty * v_factor, 6);

      if v_base_qty <= 0 then
        raise exception 'quantity is too small in the base unit'
          using errcode = '22023';
      end if;

      v_res := v_res || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_no',
          v_ord,
          'item_id',
          v_item,
          'input_quantity',
          v_qty,
          'input_unit',
          v_code,
          'factor',
          v_factor,
          'factor_source',
          v_source,
          'conversion_version_id',
          v_ver,
          'base_unit',
          v_base,
          'base_quantity',
          v_base_qty
        )
      );
    end loop;
  end if;

  select
    coalesce(
      pg_catalog.array_agg(
        x.id
        order by
          x.id
      ),
      '{}'::uuid[]
    )
  into v_items
  from
    (
      select
        (r.value ->> 'item_id')::uuid as id
      from
        pg_catalog.jsonb_array_elements(v_res) as r (value)
      union
      select
        sm.item_id
      from
        app.stock_movements sm
      where
        sm.id = any (coalesce(v_old_ids, '{}'::bigint[]))
    ) x;

  perform app.prepare_balance_locks (app.recompute_item_set (v_items));

  v_event := coalesce(
    v_prev.event_position,
    pg_catalog.nextval(
      pg_catalog.pg_get_serial_sequence('app.stock_movements', 'id')
    )
  );

  if v_pred is not null
  and v_prev.occurred_at < app.restatement_window_start () then
    v_batch := app.apply_closed_waste_delta (v_pred, v_res, v_void, v_reason);
    v_closed_waste := true;

    -- A void has no posting batch. The return batch is the removal of the
    -- predecessor, which is what retire_batch_id records.
    if v_void then
      v_retire_batch := v_batch;
      v_batch := null;
    end if;
  elsif v_pred is not null then
    v_retire_batch := pg_catalog.gen_random_uuid ();
    perform app.retire_movements (v_old_ids, v_retire_batch);
  end if;

  if not v_void
  and not v_closed_waste then
    -- A line with the same item, time and base quantity as before reposts each previous piece, in order.
    with
      prior as (
        select
          pl.item_id,
          pl.base_quantity,
          pg_catalog.abs(sm.quantity) as qty,
          pg_catalog.row_number() over (
            partition by
              pl.id
            order by
              sm.event_position,
              coalesce(sm.piece_position, 0),
              sm.id
          ) as ord,
          pg_catalog.sum(pg_catalog.abs(sm.quantity)) over (
            partition by
              pl.id
          ) as total
        from
          app.waste_lines pl
          join app.waste_line_movements wm on wm.line_id = pl.id
          join app.stock_movements sm on sm.id = wm.movement_id
        where
          v_pred is not null
          and v_prev.occurred_at = v_at
          and pl.document_id = v_pred
      )
    select
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id',
          req.item_id,
          'movement_type',
          'waste',
          'occurred_at',
          v_at,
          'quantity',
          coalesce(pr.qty, req.base_quantity),
          'shift_id',
          v_shift,
          'source_id',
          'waste:' || p_request_id::text || ':' || req.line_no::text,
          'note',
          null,
          'event_position',
          v_event
        )
        order by
          req.line_no,
          coalesce(pr.ord, 1)
      )
    into v_lines
    from
      (
        select
          (r.value ->> 'line_no')::integer as line_no,
          r.value ->> 'item_id' as item_id,
          (r.value ->> 'base_quantity')::numeric as base_quantity
        from
          pg_catalog.jsonb_array_elements(v_res) as r (value)
      ) req
      left join prior pr on pr.item_id::text = req.item_id
      and pr.base_quantity = req.base_quantity
      and pr.total = req.base_quantity;

    begin
      v_batch := app.post_engine_outflows (v_lines);
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_detail = pg_exception_detail;

        if v_detail is distinct from 'missing_cost_basis' then
          raise;
        end if;

        select
          coalesce(
            pg_catalog.array_agg(
              (r.value ->> 'item_id')::uuid
              order by
                r.value ->> 'item_id'
            ),
            '{}'::uuid[]
          )
        into v_blocked
        from
          pg_catalog.jsonb_array_elements(v_res) as r (value)
        where
          not exists (
            select
              1
            from
              app.item_provisional_seeds sd
            where
              sd.item_id = (r.value ->> 'item_id')::uuid
          )
          and not exists (
            select
              1
            from
              app.item_opening_prices p
            where
              p.item_id = (r.value ->> 'item_id')::uuid
              and p.superseded_change_id is null
          );

        if coalesce(pg_catalog.cardinality (v_blocked), 0) = 0 then
          select
            pg_catalog.array_agg(
              (r.value ->> 'item_id')::uuid
              order by
                r.value ->> 'item_id'
            )
          into v_blocked
          from
            pg_catalog.jsonb_array_elements(v_res) as r (value);
        end if;

        raise exception 'missing_cost_basis'
          using errcode = 'P0001',
          detail = 'missing_cost_basis',
          hint = pg_catalog.array_to_string(v_blocked, ',');
    end;
  end if;

  insert into
    app.waste_documents (
      request_id,
      occurred_at,
      reason_code,
      explanation,
      shift_id,
      predecessor_id,
      is_void,
      event_position,
      batch_id,
      retire_batch_id,
      actor
    )
  values
    (
      p_request_id,
      v_at,
      v_reason,
      v_expl,
      v_shift,
      v_pred,
      v_void,
      v_event,
      v_batch,
      v_retire_batch,
      auth.uid ()
    )
  returning
    id into v_doc;

  insert into
    app.waste_lines (
      document_id,
      line_no,
      item_id,
      input_quantity,
      input_unit,
      factor,
      factor_source,
      conversion_version_id,
      base_unit,
      base_quantity
    )
  select
    v_doc,
    (r.value ->> 'line_no')::integer,
    (r.value ->> 'item_id')::uuid,
    (r.value ->> 'input_quantity')::numeric,
    r.value ->> 'input_unit',
    (r.value ->> 'factor')::numeric,
    r.value ->> 'factor_source',
    (r.value ->> 'conversion_version_id')::uuid,
    r.value ->> 'base_unit',
    (r.value ->> 'base_quantity')::numeric
  from
    pg_catalog.jsonb_array_elements(v_res) as r (value)
  order by
    (r.value ->> 'line_no')::integer;

  if v_batch is not null
  and not v_closed_waste then
    insert into
      app.waste_line_movements (movement_id, line_id, document_id)
    select
      sm.id,
      l.id,
      v_doc
    from
      app.stock_movements sm
      join app.waste_lines l on l.document_id = v_doc
      and sm.source_id = 'waste:' || p_request_id::text || ':' || l.line_no::text
    where
      sm.batch_id = v_batch
      and sm.source_type = 'engine'
      and sm.movement_type = 'waste';

    if (
      select
        count(distinct wm.line_id)
      from
        app.waste_line_movements wm
      where
        wm.document_id = v_doc
    ) <> pg_catalog.jsonb_array_length(v_res) then
      raise exception 'waste posting did not link every line'
        using errcode = '55000';
    end if;
  end if;

  select
    coalesce(e.stock_qty_delta, 0) as qty,
    coalesce(e.stock_value_delta, 0)::numeric(14, 2) as val,
    coalesce(e.cogs_cost_delta, 0)::numeric(14, 2) as cogs,
    coalesce(e.waste_cost_delta, 0)::numeric(14, 2) as waste,
    coalesce(e.profit_delta, 0)::numeric(14, 2) as profit
  into v_diff
  from
    app.disposition_effect (v_retire_batch, v_batch) e;

  v_kind := case
    when v_void then 'void'
    when v_pred is not null then 'correction'
    else 'record'
  end;

  v_result := pg_catalog.jsonb_build_object(
    'status',
    'ok',
    'document_id',
    v_doc,
    'predecessor_id',
    v_pred,
    'kind',
    v_kind,
    'occurred_at',
    app.costing_timestamptz_text (v_at),
    'reason_code',
    v_reason,
    'lines',
    (
      select
        coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'line_no',
              l.line_no,
              'item_id',
              l.item_id,
              'input_quantity',
              pg_catalog.trim_scale (l.input_quantity)::text,
              'input_unit',
              l.input_unit,
              'factor',
              pg_catalog.trim_scale (l.factor)::text,
              'factor_source',
              l.factor_source,
              'base_unit',
              l.base_unit,
              'base_quantity',
              pg_catalog.trim_scale (l.base_quantity)::text
            )
            order by
              l.line_no
          ),
          '[]'::jsonb
        )
      from
        app.waste_lines l
      where
        l.document_id = v_doc
    ),
    'differences',
    pg_catalog.jsonb_build_object(
      'stock_quantity',
      pg_catalog.trim_scale (v_diff.qty)::text,
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
    app.waste_requests (request_id, payload_hash, document_id, result)
  values
    (p_request_id, v_hash, v_doc, v_result);

  return v_result;
end;
$$;

comment on function app.record_waste (uuid, jsonb) is 'Owner only. A correction or cancellation of a waste document dated before the window posts the contribution difference and leaves the original rows. An in-window correction still retires and reposts.';

revoke all on function app.record_waste (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.record_waste (uuid, jsonb) to authenticated;

create or replace function app.accounting_scaling_ready () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    true;
$$;

comment on function app.accounting_scaling_ready () is 'Private. True once this migration has installed the checkpoint, the closed-period cause, and the queue. No API role can execute it.';

revoke all on function app.accounting_scaling_ready ()
from
  public,
  anon,
  authenticated,
  service_role;

commit;
