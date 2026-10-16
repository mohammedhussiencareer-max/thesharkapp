-- Stock ledger core: items, unit conversions, append-only movements,
-- derived balances, provisional deficits, and the single server-side posting path.
-- ============================================================================
-- 1. Items & Unit Conversions
-- ============================================================================
create table app.stock_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  kind text not null check (
    kind in (
      'fish_mixed',
      'fish_size',
      'seafood',
      'ingredient',
      'packaging'
    )
  ),
  base_unit text not null check (base_unit in ('kg', 'piece', 'liter')),
  count_frequency text not null check (count_frequency in ('daily', 'weekly')),
  loss_pct numeric(6, 5) not null default 0 check (
    loss_pct >= 0
    and loss_pct < 1
  ),
  parent_item_id uuid null references app.stock_items (id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint stock_items_parent_presence_chk check (
    (
      kind = 'fish_size'
      and parent_item_id is not null
      and parent_item_id <> id
    )
    or (
      kind <> 'fish_size'
      and parent_item_id is null
    )
  )
);

comment on table app.stock_items is 'Inventory catalog items (mixed fish, sorted fish sizes, seafood, ingredients, packaging).';

create function app.trg_validate_stock_item_parent () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_parent_kind text;
begin
  if new.kind = 'fish_size' then
    if new.parent_item_id is null then
      raise exception 'fish_size item requires parent_item_id'
        using errcode = '23514';
    end if;

    select
      si.kind
    into v_parent_kind
    from
      app.stock_items si
    where
      si.id = new.parent_item_id;

    if v_parent_kind is distinct from 'fish_mixed' then
      raise exception 'parent_item_id for fish_size must reference a fish_mixed item'
        using errcode = '23514';
    end if;
  else
    if new.parent_item_id is not null then
      raise exception 'parent_item_id must be null for non-fish_size items'
        using errcode = '23514';
    end if;

    if tg_op = 'UPDATE' and old.kind = 'fish_mixed' and new.kind <> 'fish_mixed' then
      if exists (
        select
          1
        from
          app.stock_items c
        where
          c.parent_item_id = new.id
      ) then
        raise exception 'cannot change kind of fish_mixed item that has fish_size children'
          using errcode = '23514';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app.trg_validate_stock_item_parent ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_items_validate_parent
before insert or update on app.stock_items for each row
execute function app.trg_validate_stock_item_parent ();

create table app.item_unit_conversions (
  item_id uuid not null references app.stock_items (id) on delete cascade,
  unit text not null check (length(btrim(unit)) > 0),
  factor_to_base numeric(18, 9) not null check (factor_to_base > 0),
  primary key (item_id, unit)
);

comment on table app.item_unit_conversions is 'Per-item conversion factors from input unit to the item base_unit.';

-- ============================================================================
-- 2. Movements (Append-Only Ledger)
-- ============================================================================
create type app.movement_type as enum(
  'opening',
  'purchase',
  'sort_out',
  'sort_in',
  'sort_loss',
  'sale',
  'sale_reversal',
  'waste',
  'count_adjustment',
  'cost_adjustment'
);

create table app.stock_movements (
  id bigint generated always as identity primary key,
  batch_id uuid not null,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  movement_type app.movement_type not null,
  occurred_at timestamptz not null,
  quantity numeric(20, 6) not null,
  unit_cost numeric(20, 6) not null,
  total_cost numeric(14, 2) not null,
  is_provisional boolean not null default false,
  adjusts_movement_id bigint null references app.stock_movements (id) on delete restrict,
  shift_id text null,
  source_type text null,
  source_id text null,
  note text null,
  created_at timestamptz not null default now(),
  created_by uuid null default auth.uid (),
  constraint stock_movements_cost_adj_chk check (
    (
      movement_type = 'cost_adjustment'
      and quantity = 0
      and adjusts_movement_id is not null
    )
    or (
      movement_type <> 'cost_adjustment'
      and quantity <> 0
      and adjusts_movement_id is null
    )
  )
);

comment on table app.stock_movements is 'Append-only stock movement ledger. Never updated or deleted.';

create index stock_movements_item_occurred_idx on app.stock_movements (item_id, occurred_at, id);

create index stock_movements_batch_idx on app.stock_movements (batch_id);

create index stock_movements_adjusts_idx on app.stock_movements (adjusts_movement_id)
where
  adjusts_movement_id is not null;

create function app.prevent_stock_movements_mutation () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.stock_movements is append-only; % is not allowed', tg_op
    using errcode = '55000';
end;
$$;

revoke all on function app.prevent_stock_movements_mutation ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_movements_no_update_delete
before update or delete on app.stock_movements for each row
execute function app.prevent_stock_movements_mutation ();

create trigger trg_stock_movements_no_truncate
before truncate on app.stock_movements for each statement
execute function app.prevent_stock_movements_mutation ();

-- ============================================================================
-- 3. Derived Balances & Provisional Deficits
-- ============================================================================
create table app.item_balances (
  item_id uuid primary key references app.stock_items (id) on delete restrict,
  on_hand_qty numeric(20, 6) not null default 0,
  on_hand_value numeric(14, 2) not null default 0,
  avg_cost numeric(20, 6) not null default 0 check (avg_cost >= 0),
  last_occurred_at timestamptz null,
  has_uncovered_deficit boolean not null default false
);

comment on table app.item_balances is 'Derived per-item stock balance and moving average cost, maintained solely by the posting functions.';

create table app.provisional_deficits (
  movement_id bigint primary key references app.stock_movements (id) on delete restrict,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  qty_uncovered numeric(20, 6) not null check (qty_uncovered >= 0),
  provisional_unit_cost numeric(20, 6) not null check (provisional_unit_cost >= 0)
);

comment on table app.provisional_deficits is 'Tracks uncovered negative-stock outflow movements until subsequent inflows cover them.';

create index provisional_deficits_uncovered_idx on app.provisional_deficits (item_id, movement_id)
where
  qty_uncovered > 0;

-- ============================================================================
-- 4. Internal Posting Helpers (Shared Core)
-- ============================================================================
create function app.assert_ledger_write_allowed () returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_jwt_role text;
begin
  v_jwt_role := coalesce(
    (
      select
        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    ),
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '')
  );

  if not (
    app.is_owner ()
    or pg_catalog.current_setting('role', true) = 'service_role'
    or v_jwt_role = 'service_role'
  ) then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Serialize all ledger writes with a single fixed transaction-level advisory lock key.
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);
end;
$$;

revoke all on function app.assert_ledger_write_allowed ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.lock_and_validate_item_balance (p_item_id uuid, p_occurred_at timestamptz) returns app.item_balances language plpgsql security definer
set
  search_path = '' as $$
declare
  v_bal app.item_balances;
begin
  if p_occurred_at is null then
    raise exception 'occurred_at is required'
      using errcode = '22023';
  end if;

  insert into
    app.item_balances (
      item_id,
      on_hand_qty,
      on_hand_value,
      avg_cost,
      last_occurred_at,
      has_uncovered_deficit
    )
  values
    (p_item_id, 0, 0, 0, null, false)
  on conflict (item_id) do nothing;

  select
    ib.*
  into v_bal
  from
    app.item_balances ib
  where
    ib.item_id = p_item_id
  for update;

  if v_bal.last_occurred_at is not null and p_occurred_at < v_bal.last_occurred_at then
    raise exception 'back-dated movement not supported yet'
      using errcode = 'P0001',
      detail = pg_catalog.format(
        'occurred_at %s is before last_occurred_at %s',
        p_occurred_at,
        v_bal.last_occurred_at
      );
  end if;

  return v_bal;
end;
$$;

revoke all on function app.lock_and_validate_item_balance (uuid, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.apply_outflow_movement (
  p_batch_id uuid,
  p_item_id uuid,
  p_movement_type app.movement_type,
  p_occurred_at timestamptz,
  p_out_qty numeric(20, 6),
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_bal app.item_balances;
  v_unit_cost numeric(20, 6);
  v_normal_qty numeric(20, 6);
  v_prov_qty numeric(20, 6);
  v_normal_cost numeric(14, 2);
  v_prov_cost numeric(14, 2);
  v_delta_value numeric(14, 2) := 0;
  v_prov_movement_id bigint;
  v_has_deficit boolean;
begin
  if p_out_qty is null or p_out_qty <= 0 then
    raise exception 'outflow quantity must be > 0'
      using errcode = '22023';
  end if;

  v_bal := app.lock_and_validate_item_balance (p_item_id, p_occurred_at);
  v_unit_cost := v_bal.avg_cost;

  v_normal_qty := least(p_out_qty, greatest(v_bal.on_hand_qty, 0::numeric(20, 6)));
  v_prov_qty := p_out_qty - v_normal_qty;

  if v_normal_qty > 0 then
    v_normal_cost := -pg_catalog.round(v_normal_qty * v_unit_cost, 2);

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
        -v_normal_qty,
        v_unit_cost,
        v_normal_cost,
        false,
        p_shift_id,
        p_source_type,
        p_source_id,
        p_note
      );

    v_delta_value := v_delta_value + v_normal_cost;
  end if;

  if v_prov_qty > 0 then
    v_prov_cost := -pg_catalog.round(v_prov_qty * v_unit_cost, 2);

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
        -v_prov_qty,
        v_unit_cost,
        v_prov_cost,
        true,
        p_shift_id,
        p_source_type,
        p_source_id,
        p_note
      )
    returning
      id into v_prov_movement_id;

    insert into
      app.provisional_deficits (
        movement_id,
        item_id,
        qty_uncovered,
        provisional_unit_cost
      )
    values
      (
        v_prov_movement_id,
        p_item_id,
        v_prov_qty,
        v_unit_cost
      );

    v_delta_value := v_delta_value + v_prov_cost;
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

  update app.item_balances
  set
    on_hand_qty = v_bal.on_hand_qty - p_out_qty,
    on_hand_value = v_bal.on_hand_value + v_delta_value,
    last_occurred_at = p_occurred_at,
    has_uncovered_deficit = v_has_deficit
  where
    item_id = p_item_id;
end;
$$;

revoke all on function app.apply_outflow_movement (
  uuid,
  uuid,
  app.movement_type,
  timestamptz,
  numeric,
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

create function app.apply_inflow_movement (
  p_batch_id uuid,
  p_item_id uuid,
  p_movement_type app.movement_type,
  p_occurred_at timestamptz,
  p_in_qty numeric(20, 6),
  p_in_unit_cost numeric(20, 6),
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_bal app.item_balances;
  v_inflow_unit_cost numeric(20, 6);
  v_inflow_total_cost numeric(14, 2);
  v_delta_value numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_covered_qty numeric(20, 6);
  v_adj_unit_cost numeric(20, 6);
  v_adj_total_cost numeric(14, 2);
  v_prior_pos_qty numeric(20, 6);
  v_new_avg_cost numeric(20, 6);
  v_has_deficit boolean;
  r_def record;
begin
  if p_in_qty is null or p_in_qty <= 0 then
    raise exception 'inflow quantity must be > 0'
      using errcode = '22023';
  end if;

  v_bal := app.lock_and_validate_item_balance (p_item_id, p_occurred_at);

  if p_movement_type = 'count_adjustment' then
    v_inflow_unit_cost := v_bal.avg_cost;
  else
    v_inflow_unit_cost := p_in_unit_cost;
  end if;

  if v_inflow_unit_cost is null or v_inflow_unit_cost < 0 then
    raise exception 'inflow unit_cost must be >= 0'
      using errcode = '22023';
  end if;

  v_inflow_total_cost := pg_catalog.round(p_in_qty * v_inflow_unit_cost, 2);

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
    );

  v_delta_value := v_inflow_total_cost;
  v_remaining_qty := p_in_qty;

  -- Cover uncovered deficits oldest-first.
  for r_def in
    select
      pd.movement_id,
      pd.qty_uncovered,
      pd.provisional_unit_cost,
      sm.shift_id as prov_shift_id
    from
      app.provisional_deficits pd
      join app.stock_movements sm on sm.id = pd.movement_id
    where
      pd.item_id = p_item_id
      and pd.qty_uncovered > 0
    order by
      pd.movement_id asc
    for update of pd
  loop
    exit when v_remaining_qty <= 0;

    v_covered_qty := least(v_remaining_qty, r_def.qty_uncovered);
    v_adj_unit_cost := v_inflow_unit_cost - r_def.provisional_unit_cost;
    v_adj_total_cost := -pg_catalog.round(v_covered_qty * v_adj_unit_cost, 2);

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
        p_occurred_at,
        0,
        v_adj_unit_cost,
        v_adj_total_cost,
        false,
        r_def.movement_id,
        r_def.prov_shift_id,
        p_source_type,
        p_source_id,
        p_note
      );

    update app.provisional_deficits
    set
      qty_uncovered = qty_uncovered - v_covered_qty
    where
      movement_id = r_def.movement_id;

    v_remaining_qty := v_remaining_qty - v_covered_qty;
    v_delta_value := v_delta_value + v_adj_total_cost;
  end loop;

  v_prior_pos_qty := greatest(v_bal.on_hand_qty, 0::numeric(20, 6));

  if v_prior_pos_qty + v_remaining_qty > 0 then
    v_new_avg_cost := pg_catalog.round(
      (v_prior_pos_qty * v_bal.avg_cost + v_remaining_qty * v_inflow_unit_cost) / (v_prior_pos_qty + v_remaining_qty),
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

revoke all on function app.apply_inflow_movement (
  uuid,
  uuid,
  app.movement_type,
  timestamptz,
  numeric,
  numeric,
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

-- ============================================================================
-- 5. Public Posting Functions
-- ============================================================================
create function app.post_movements (p_movements jsonb) returns uuid language plpgsql security definer
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
  v_qty numeric(20, 6);
  v_unit_cost numeric(20, 6);
begin
  perform app.assert_ledger_write_allowed ();

  if p_movements is null
  or pg_catalog.jsonb_typeof(p_movements) <> 'array'
  or pg_catalog.jsonb_array_length(p_movements) = 0 then
    raise exception 'p_movements must be a non-empty jsonb array'
      using errcode = '22023';
  end if;

  v_batch_id := pg_catalog.gen_random_uuid();

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_movements) as e (value)
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

    if v_item_id is null or v_type_text is null or v_occurred_at is null or v_raw_qty is null then
      raise exception 'item_id, movement_type, occurred_at, and quantity are required'
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
      select
        iuc.factor_to_base
      into v_factor
      from
        app.item_unit_conversions iuc
      where
        iuc.item_id = v_item_id
        and iuc.unit = v_unit;

      if not found then
        raise exception 'unknown unit "%" for item %', v_unit, v_item_id
          using errcode = '22023';
      end if;
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

      v_unit_cost := pg_catalog.round(v_raw_unit_cost / v_factor, 6);

      if v_unit_cost <= 0 then
        raise exception 'converted purchase unit_cost must be > 0'
          using errcode = '22023';
      end if;

      perform app.apply_inflow_movement (
        v_batch_id,
        v_item_id,
        'purchase',
        v_occurred_at,
        v_qty,
        v_unit_cost,
        v_shift_id,
        v_source_type,
        v_source_id,
        v_note
      );
    elsif v_movement_type = 'opening' then
      if v_qty <= 0 then
        raise exception 'opening quantity must be > 0'
          using errcode = '22023';
      end if;

      if v_raw_unit_cost is null or v_raw_unit_cost < 0 then
        raise exception 'opening unit_cost must be >= 0'
          using errcode = '22023';
      end if;

      v_unit_cost := pg_catalog.round(v_raw_unit_cost / v_factor, 6);

      perform app.apply_inflow_movement (
        v_batch_id,
        v_item_id,
        'opening',
        v_occurred_at,
        v_qty,
        v_unit_cost,
        v_shift_id,
        v_source_type,
        v_source_id,
        v_note
      );
    elsif v_movement_type in ('sale', 'waste') then
      if v_qty <= 0 then
        raise exception '% quantity must be > 0', v_movement_type
          using errcode = '22023';
      end if;

      perform app.apply_outflow_movement (
        v_batch_id,
        v_item_id,
        v_movement_type,
        v_occurred_at,
        v_qty,
        v_shift_id,
        v_source_type,
        v_source_id,
        v_note
      );
    elsif v_movement_type = 'count_adjustment' then
      if v_qty > 0 then
        perform app.apply_inflow_movement (
          v_batch_id,
          v_item_id,
          'count_adjustment',
          v_occurred_at,
          v_qty,
          null,
          v_shift_id,
          v_source_type,
          v_source_id,
          v_note
        );
      else
        perform app.apply_outflow_movement (
          v_batch_id,
          v_item_id,
          'count_adjustment',
          v_occurred_at,
          -v_qty,
          v_shift_id,
          v_source_type,
          v_source_id,
          v_note
        );
      end if;
    end if;
  end loop;

  return v_batch_id;
end;
$$;

comment on function app.post_movements (jsonb) is 'Single server-side entry point to post opening, purchase, sale, waste, and count_adjustment movements.';

revoke all on function app.post_movements (jsonb)
from
  public,
  anon;

grant
execute on function app.post_movements (jsonb) to authenticated,
service_role;

create function app.post_sort (
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
  v_mixed_unit_cost numeric(20, 6);
  v_qty_taken numeric(20, 6);
  v_sum_sizes numeric(20, 6) := 0;
  v_loss_qty numeric(20, 6);
  v_elem jsonb;
  v_size_id uuid;
  v_size_qty numeric(20, 6);
  v_size_kind text;
  v_size_parent uuid;
  v_size_unit text;
begin
  perform app.assert_ledger_write_allowed ();

  if p_mixed_item is null or p_occurred_at is null or p_qty_taken is null then
    raise exception 'p_mixed_item, p_occurred_at, and p_qty_taken are required'
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

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_sizes) as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each size element must be a jsonb object'
        using errcode = '22023';
    end if;

    v_size_id := (v_elem ->> 'item_id')::uuid;
    v_size_qty := pg_catalog.round((v_elem ->> 'quantity')::numeric, 6);

    if v_size_id is null or v_size_qty is null or v_size_qty <= 0 then
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
  end loop;

  if v_sum_sizes > v_qty_taken then
    raise exception 'sum of sorted sizes (%) exceeds p_qty_taken (%)',
      v_sum_sizes,
      v_qty_taken
      using errcode = '22023';
  end if;

  v_batch_id := pg_catalog.gen_random_uuid();

  v_mixed_bal := app.lock_and_validate_item_balance (p_mixed_item, p_occurred_at);
  v_mixed_unit_cost := v_mixed_bal.avg_cost;

  -- 1. sort_out of sum(sizes) from mixed item at its avg cost.
  perform app.apply_outflow_movement (
    v_batch_id,
    p_mixed_item,
    'sort_out',
    p_occurred_at,
    v_sum_sizes,
    p_shift_id,
    'sort',
    v_batch_id::text,
    null
  );

  -- 2. sort_loss of p_qty_taken - sum(sizes) (if > 0) from mixed item at the same cost.
  v_loss_qty := v_qty_taken - v_sum_sizes;

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
      null
    );
  end if;

  -- 3. sort_in for each size at the same per-kg cost.
  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_sizes) as e (value)
  loop
    v_size_id := (v_elem ->> 'item_id')::uuid;
    v_size_qty := pg_catalog.round((v_elem ->> 'quantity')::numeric, 6);

    perform app.apply_inflow_movement (
      v_batch_id,
      v_size_id,
      'sort_in',
      p_occurred_at,
      v_size_qty,
      v_mixed_unit_cost,
      p_shift_id,
      'sort',
      v_batch_id::text,
      null
    );
  end loop;

  return v_batch_id;
end;
$$;

comment on function app.post_sort (uuid, timestamptz, numeric, jsonb, text) is 'Posts a mixed-fish sorting batch (sort_out, optional sort_loss, and sort_in per size).';

revoke all on function app.post_sort (uuid, timestamptz, numeric, jsonb, text)
from
  public,
  anon;

grant
execute on function app.post_sort (uuid, timestamptz, numeric, jsonb, text) to authenticated,
service_role;

-- ============================================================================
-- 6. Row-Level Security & Table Grants
-- ============================================================================
alter table app.stock_items enable row level security;

alter table app.item_unit_conversions enable row level security;

alter table app.stock_movements enable row level security;

alter table app.item_balances enable row level security;

alter table app.provisional_deficits enable row level security;

create policy stock_items_select_owner on app.stock_items for
select
  to authenticated using (app.is_owner ());

create policy item_unit_conversions_select_owner on app.item_unit_conversions for
select
  to authenticated using (app.is_owner ());

create policy stock_movements_select_owner on app.stock_movements for
select
  to authenticated using (app.is_owner ());

create policy item_balances_select_owner on app.item_balances for
select
  to authenticated using (app.is_owner ());

create policy provisional_deficits_select_owner on app.provisional_deficits for
select
  to authenticated using (app.is_owner ());

revoke all on table app.stock_items
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.item_unit_conversions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.stock_movements
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.item_balances
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.provisional_deficits
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_items,
  app.item_unit_conversions,
  app.stock_movements,
  app.item_balances,
  app.provisional_deficits to authenticated,
  service_role;

grant insert,
update,
delete on table app.stock_items,
app.item_unit_conversions to service_role;
