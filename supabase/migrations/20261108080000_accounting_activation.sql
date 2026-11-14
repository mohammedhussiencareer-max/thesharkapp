-- Inventory activation. The public poster keeps its grants and, once the
-- singleton exists, refuses sale, waste, and count_adjustment. Typed writers
-- call app.post_movements_internal. No checkpoint is built here.
-- app.accounting_scaling_ready() stays false until
-- 20261108090000_replay_checkpoint.sql replaces it.
-- ============================================================================
-- 1. Stored opening observations and the activation request row.
-- ============================================================================
create table app.inventory_opening_observations (
  item_id uuid primary key references app.stock_items (id) on delete restrict,
  base_unit text not null check (length(pg_catalog.btrim (base_unit)) > 0),
  quantity numeric(20, 6) not null check (quantity >= 0),
  explicit_zero boolean not null,
  opening_id uuid null,
  line_no integer null,
  observed_at timestamptz not null check (pg_catalog.isfinite (observed_at)),
  constraint inventory_opening_observations_shape_chk check (
    (
      explicit_zero
      and quantity = 0
      and opening_id is null
      and line_no is null
    )
    or (
      not explicit_zero
      and quantity > 0
      and opening_id is not null
      and line_no is not null
    )
  ),
  constraint inventory_opening_observations_line_fk foreign key (opening_id, line_no) references app.opening_stock_lines (opening_id, line_no) on delete restrict
);

comment on table app.inventory_opening_observations is 'Append-only. One row per stock item the owner confirmed at activation. A positive row stores the matching opening movement''s base quantity. An explicit zero stores quantity 0 and posts no movement.';

create table app.inventory_activation_requests (
  request_id uuid primary key,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{32}$'),
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.inventory_activation_requests is 'Append-only. The stored result of each committed activate_inventory request id. A repeat with the same payload returns it; a different payload for the same id is rejected.';

create trigger trg_inventory_opening_observations_no_update_delete
before update or delete on app.inventory_opening_observations for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_inventory_opening_observations_no_truncate
before truncate on app.inventory_opening_observations for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_inventory_activation_requests_no_update_delete
before update or delete on app.inventory_activation_requests for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_inventory_activation_requests_no_truncate
before truncate on app.inventory_activation_requests for each statement
execute function app.prevent_append_only_mutation ();

alter table app.inventory_opening_observations enable row level security;

alter table app.inventory_activation_requests enable row level security;

create policy inventory_opening_observations_select_owner on app.inventory_opening_observations for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy inventory_activation_requests_select_owner on app.inventory_activation_requests for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.inventory_opening_observations,
app.inventory_activation_requests
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.inventory_opening_observations,
  app.inventory_activation_requests to authenticated,
  service_role;

-- ============================================================================
-- 2. Manifest token. One catalog-wide digest, stable for every review page.
-- ============================================================================
create function app.opening_manifest_digest (p_confirmed boolean) returns text language sql stable security definer
set
  search_path = '' as $$
  select
    pg_catalog.md5(
      coalesce(
        (
          select
            pg_catalog.string_agg(line.body, E'\n' order by line.item_id)
          from
            (
              select
                si.id as item_id,
                si.id::text || '|' || si.base_unit || '|' || case
                  when earliest.opening_id is null then '0|' || case
                    when p_confirmed then 'zero'
                    else 'missing'
                  end
                  when move.quantity is null then cnt.n || '|' || earliest.opening_id::text || '|' || earliest.line_no::text || '|no-movement'
                  else cnt.n || '|' || earliest.opening_id::text || '|' || earliest.line_no::text || '|' || pg_catalog.trim_scale (move.quantity)::text || '|' || si.base_unit || '|' || app.costing_timestamptz_text (earliest.occurred_at)
                end as body
              from
                app.stock_items si
                left join lateral (
                  select
                    line.opening_id,
                    line.line_no,
                    os.occurred_at
                  from
                    app.opening_stock_lines line
                    join app.opening_stocks os on os.id = line.opening_id
                  where
                    line.item_id = si.id
                  order by
                    os.occurred_at,
                    line.opening_id,
                    line.line_no
                  limit
                    1
                ) earliest on true
                left join lateral (
                  select
                    count(*)::text as n
                  from
                    app.opening_stock_lines line
                  where
                    line.item_id = si.id
                ) cnt on true
                left join lateral (
                  select
                    sm.quantity
                  from
                    app.stock_movements sm
                  where
                    sm.batch_id = earliest.opening_id
                    and sm.item_id = si.id
                    and sm.movement_type = 'opening'
                    and sm.occurred_at = earliest.occurred_at
                  order by
                    sm.id
                  limit
                    1
                ) move on true
            ) line
        ),
        ''
      )
    );
$$;

comment on function app.opening_manifest_digest (boolean) is 'Private. md5 of one line per stock item, ordered by item id. A positive line uses the earliest opening and that movement''s base quantity. p_confirmed replaces missing with zero for the stored hash.';

create function app.opening_manifest_token () returns text language sql stable security definer
set
  search_path = '' as $$
  select
    app.opening_manifest_digest (false);
$$;

comment on function app.opening_manifest_token () is 'Private. The catalog token the owner confirms. Every page of opening_activation_review returns it until activation is stored.';

revoke all on function app.opening_manifest_digest (boolean),
app.opening_manifest_token ()
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 3. Coverage start. PR 7 added the helper. This replaces only its body.
-- ============================================================================
create or replace function app.coverage_stock_start () returns timestamptz language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      (
        select
          activation.stock_started_at
        from
          app.inventory_activation activation
        where
          activation.id = 1
      ),
      (
        select
          min(opening.occurred_at)
        from
          app.opening_stocks opening
      )
    );
$$;

comment on function app.coverage_stock_start () is 'Private. inventory_activation.stock_started_at when the row exists, otherwise the earliest opening. Before activation, coverage stays the earliest opening.';

revoke all on function app.coverage_stock_start ()
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 4. Private poster, then the public guard.
-- ============================================================================
create function app.post_movements_internal (p_movements jsonb) returns uuid language plpgsql security definer
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

  if app.batch_is_forward (v_item_ids, v_times) then
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

comment on function app.post_movements_internal (jsonb) is 'Private implementation of the stock poster. Typed writers call this. It is not granted to API roles. Always rejects sale_reversal, waste_reversal, and count_compensation.';

revoke all on function app.post_movements_internal (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.post_movements (p_movements jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_type text;
begin
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

comment on function app.post_movements (jsonb) is 'Public poster. Opening and purchase stay allowed. Always rejects sale_reversal, waste_reversal, and count_compensation through the private implementation. Once inventory_activation exists, also rejects sale, waste, and count_adjustment regardless of source.';

revoke all on function app.post_movements (jsonb)
from
  public,
  anon;

grant
execute on function app.post_movements (jsonb) to authenticated,
service_role;

-- ============================================================================
-- 5. Typed writers call the private poster.
-- ============================================================================
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

comment on function app.record_opening_stock (timestamptz, jsonb, uuid) is 'Posts one opening batch through app.post_movements_internal. Unit text is a unit code or an alias. The factor is app.item_factor_at at occurred_at. Request-id replay returns before any unit lookup.';

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

comment on function app.record_count (jsonb) is 'Prepares, then posts, one stock count. Takes advisory lock 7342750000000000001 first, validates the payload, and replays request_id against stock_counts before any catalog, shift, sync, or balance read. The same normalized payload returns {"status":"posted","count_id":...} and does not post again. counted_qty is stored as numeric(20, 6) text, not a JSON number, and both the prepare replay and the posted replay compare that same text and the trimmed expected_base_unit. A missing or blank expected_base_unit raises 22023 expected_base_unit is required. The first submit and the post both raise 22023 item base unit changed when that unit differs from stock_items.base_unit. A different payload raises 22023 request_id already used for a different count. The first submit stores stock_count_requests with prepared_at = clock_timestamp() and returns {"status":"waiting_for_sync"} without raising, after the shift and item guards. The owner submits only after the physical count, so prepared_at is after the count. A later call with the same payload waits until the newest ok pos_sync_runs row, by id, has finished_at not null, started_at > prepared_at, and started_at > the latest close_recorded_at among shifts with opened_at <= counted_at. Those times are all the database clock. started_at is not compared with counted_at. Sale and shift times are POS-clock and are compared with counted_at only to place movements before or after the count. When that run exists, every guard runs again on the fresh mirror, then non-zero deltas post as one count_adjustment batch through app.post_movements_internal (actual minus locked on-hand). After the post, last_occurred_at moves to counted_at plus one microsecond so a later movement at or before the count is back-dated. A sale still missing is refused by that watermark until a later recompute. The same newest ok run must also have app.pos_sync_coverage. A legacy_direct row keeps the time check above. Any other row returns {"status":"waiting_for_sync"} unless that run applied a known order scope covering every shift with opened_at <= counted_at (all, shift_ids containing each such shift, or from at or before the earliest such opened_at; an unknown scope never covers) and its presented_shift_ids contain each such shift, so every one had its transaction subcollection replaced. finish_pos_sync_run does not require scope_applied. A failed finish writes no coverage row.';

-- ============================================================================
-- 6. Review, count waiting, and coverage.
-- ============================================================================
create or replace function app.opening_activation_review (
  p_after_id uuid default null,
  p_limit integer default null
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_limit integer;
  v_items bigint;
  v_missing bigint;
  v_unreceipted bigint;
  v_activated boolean;
  v_started text;
  v_hash text;
  v_roster jsonb;
  v_next uuid;
begin
  if not app.is_owner () then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_limit := coalesce(p_limit, 100);

  if v_limit < 1 or v_limit > 200 then
    raise exception 'limit is out of range'
      using errcode = '22023';
  end if;

  select
    count(*)
  into v_items
  from
    app.stock_items;

  select
    count(*)
  into v_missing
  from
    app.stock_items si
  where
    not exists (
      select
        1
      from
        app.opening_stock_lines line
      where
        line.item_id = si.id
    );

  select
    count(*)
  into v_unreceipted
  from
    app.stock_movements sm
  where
    sm.movement_type in (
      'sale',
      'sale_reversal',
      'waste',
      'waste_reversal'
    )
    and not exists (
      select
        1
      from
        app.order_cost_movement_links link
      where
        link.movement_id = sm.id
    )
    and not exists (
      select
        1
      from
        app.order_cost_applications application
      where
        sm.id = any (application.reversal_movement_ids)
    );

  select
    exists (
      select
        1
      from
        app.inventory_activation
    )
  into v_activated;

  select
    app.costing_timestamptz_text (activation.stock_started_at),
    activation.opening_manifest_hash
  into
    v_started,
    v_hash
  from
    app.inventory_activation activation;

  if not v_activated then
    v_hash := app.opening_manifest_token ();
  end if;

  with
    ordered as (
      select
        si.id,
        si.name,
        si.base_unit,
        si.active
      from
        app.stock_items si
      where
        p_after_id is null
        or si.id > p_after_id
      order by
        si.id
      limit
        v_limit + 1
    )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id',
          page.id,
          'name',
          page.name,
          'base_unit',
          page.base_unit,
          'active',
          page.active,
          'missing',
          case
            when v_activated
            and stored.item_id is not null then false
            else obs.opening_id is null
          end,
          'opening_line_count',
          cnt.n,
          'observation',
          case
            when v_activated
            and stored.item_id is not null
            and stored.explicit_zero then pg_catalog.jsonb_build_object(
              'opening_id',
              null,
              'line_no',
              null,
              'quantity',
              '0',
              'unit',
              stored.base_unit,
              'unit_cost',
              '0',
              'occurred_at',
              app.costing_timestamptz_text (stored.observed_at),
              'explicit_zero',
              true
            )
            when v_activated
            and stored.item_id is not null then pg_catalog.jsonb_build_object(
              'opening_id',
              stored.opening_id,
              'line_no',
              stored.line_no::text,
              'quantity',
              pg_catalog.trim_scale (stored.quantity)::text,
              'unit',
              stored.base_unit,
              'unit_cost',
              pg_catalog.trim_scale (coalesce(obs.unit_cost, 0))::text,
              'occurred_at',
              app.costing_timestamptz_text (stored.observed_at),
              'explicit_zero',
              false
            )
            when obs.opening_id is null then null::jsonb
            else pg_catalog.jsonb_build_object(
              'opening_id',
              obs.opening_id,
              'line_no',
              obs.line_no::text,
              'quantity',
              pg_catalog.trim_scale (obs.quantity)::text,
              'unit',
              obs.unit,
              'unit_cost',
              pg_catalog.trim_scale (obs.unit_cost)::text,
              'occurred_at',
              app.costing_timestamptz_text (obs.occurred_at),
              'explicit_zero',
              false
            )
          end
        )
        order by
          page.id
      ),
      '[]'::jsonb
    ),
    (
      select
        included.id
      from
        (
          select
            ordered.id
          from
            ordered
          order by
            ordered.id
          limit
            v_limit
        ) included
      where
        exists (
          select
            1
          from
            ordered extra
          offset
            v_limit
        )
      order by
        included.id desc
      limit
        1
    )
  into
    v_roster,
    v_next
  from
    (
      select
        *
      from
        ordered
      order by
        id
      limit
        v_limit
    ) page
    left join app.inventory_opening_observations stored on stored.item_id = page.id
    left join lateral (
      select
        line.opening_id,
        line.line_no,
        line.quantity,
        line.unit,
        line.unit_cost,
        os.occurred_at
      from
        app.opening_stock_lines line
        join app.opening_stocks os on os.id = line.opening_id
      where
        line.item_id = page.id
      order by
        os.occurred_at,
        line.opening_id,
        line.line_no
      limit
        1
    ) obs on true
    left join lateral (
      select
        count(*)::text as n
      from
        app.opening_stock_lines line
      where
        line.item_id = page.id
    ) cnt on true;

  return pg_catalog.jsonb_build_object(
    'activated',
    v_activated,
    'stock_started_at',
    v_started,
    'opening_manifest_hash',
    v_hash,
    'can_activate',
    (not v_activated)
    and v_items > 0
    and v_missing = 0
    and v_unreceipted = 0,
    'checklist',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'not_activated',
        'ready',
        v_activated,
        'count',
        case
          when v_activated then '1'
          else '0'
        end
      ),
      pg_catalog.jsonb_build_object(
        'code',
        'missing_observations',
        'ready',
        v_missing = 0,
        'count',
        v_missing::text
      ),
      pg_catalog.jsonb_build_object(
        'code',
        'unreceipted_outflows',
        'ready',
        v_unreceipted = 0,
        'count',
        v_unreceipted::text
      ),
      pg_catalog.jsonb_build_object(
        'code',
        'empty_roster',
        'ready',
        v_items > 0,
        'count',
        v_items::text
      )
    ),
    'roster',
    coalesce(v_roster, '[]'::jsonb),
    'next_item_id',
    v_next
  );
end;
$$;

comment on function app.opening_activation_review (uuid, integer) is 'Owner only. One page of the stock roster. Before activation, and for a direct activation row with no observations, a stored opening line is shown and a missing line is not a recorded zero. After activation, inventory_opening_observations win, including explicit zeros. opening_manifest_hash is the catalog token until the row is stored, then the stored hash. Every page carries that same value. can_activate stays the data-gap flag and is false while activation is already recorded.';

create or replace function app.stock_count_derivation_detail (p_count_id uuid) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_at timestamptz;
  v_frequency text;
  v_note text;
  v_waiting_sync boolean;
  v_waiting_work boolean;
  v_start timestamptz;
  v_lines jsonb;
  v_surplus boolean;
begin
  if not app.is_owner () then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_count_id is null then
    raise exception 'count id is required'
      using errcode = '22023';
  end if;

  select
    counted.counted_at,
    counted.frequency,
    counted.note
  into
    v_at,
    v_frequency,
    v_note
  from
    app.stock_counts counted
  where
    counted.id = p_count_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'found',
      false,
      'count_id',
      p_count_id,
      'counted_at',
      null,
      'frequency',
      null,
      'note',
      null,
      'has_surplus',
      false,
      'waiting_for_sync',
      false,
      'waiting_for_processing',
      false,
      'lines',
      '[]'::jsonb
    );
  end if;

  v_waiting_sync := not app.count_sync_scope_covered (v_at);

  select
    activation.stock_started_at
  into v_start
  from
    app.inventory_activation activation;

  -- Unprocessed events stay relevant after the order is parked. Retrying a
  -- claimed parked order can still change the settlement, so this warning
  -- does not use worker eligibility.
  select
    exists (
      select
        1
      from
        (
          select distinct
            e.order_id
          from
            app.accounting_work_events e
          where
            e.processed_at is null
        ) pending
        left join lateral (
          select
            snap.ordered_at
          from
            app.pos_cost_inputs i
            join app.pos_order_snapshots snap on snap.id = i.snapshot_id
          where
            i.order_id = pending.order_id
          order by
            i.input_revision desc
          limit
            1
        ) li on true
        left join lateral (
          select
            application.occurred_at
          from
            app.order_cost_state head
            join app.order_cost_applications application on application.id = head.owner_application_id
          where
            head.order_id = pending.order_id
        ) cur on true
      where
        (
          least(li.ordered_at, cur.occurred_at) is null
          or least(li.ordered_at, cur.occurred_at) <= v_at
        )
        and not (
          v_start is not null
          and li.ordered_at is not null
          and cur.occurred_at is not null
          and li.ordered_at < v_start
          and cur.occurred_at < v_start
        )
    )
    or exists (
      select
        1
      from
        app.accounting_rederive_spans sp
      where
        sp.completed_at is null
        and sp.effective_from <= v_at
        and not (
          v_start is not null
          and sp.effective_to is not null
          and sp.effective_to <= v_start
          and not exists (
            select
              1
            from
              app.order_cost_state head
              join app.order_cost_applications application on application.id = head.owner_application_id
              join app.pos_orders ord on ord.id = head.order_id
            where
              ord.ordered_at >= sp.effective_from
              and ord.ordered_at < sp.effective_to
              and application.occurred_at >= v_start
          )
        )
    )
  into v_waiting_work;

  select
    coalesce(
      pg_catalog.jsonb_agg(line_row.obj order by line_row.line_no),
      '[]'::jsonb
    ),
    coalesce(bool_or(line_row.surplus), false)
  into
    v_lines,
    v_surplus
  from
    (
      select
        line.line_no,
        (
          line.delta_qty > 0
          or coalesce(latest.required_qty, line.delta_qty) > 0
        ) as surplus,
        pg_catalog.jsonb_build_object(
          'line_no',
          line.line_no::text,
          'item_id',
          line.item_id,
          'name',
          si.name,
          'base_unit',
          line.expected_base_unit,
          'counted_qty',
          pg_catalog.trim_scale (line.counted_qty)::text,
          'original_expected_qty',
          pg_catalog.trim_scale (line.expected_qty)::text,
          'original_delta_qty',
          pg_catalog.trim_scale (line.delta_qty)::text,
          'original_delta_value',
          pg_catalog.trim_scale (line.delta_value)::text,
          'latest_expected_qty',
          pg_catalog.trim_scale (coalesce(latest.expected_qty, line.expected_qty))::text,
          'latest_required_qty',
          pg_catalog.trim_scale (coalesce(latest.required_qty, line.delta_qty))::text,
          'latest_required_value',
          pg_catalog.trim_scale (coalesce(latest.required_value, line.delta_value))::text,
          'compensator_qty',
          pg_catalog.trim_scale (coalesce(comp.qty, 0))::text,
          'compensator_value',
          pg_catalog.trim_scale (coalesce(comp.value, 0))::text,
          'original_surplus',
          line.delta_qty > 0,
          'derived_surplus',
          coalesce(latest.required_qty, line.delta_qty) > 0,
          'derivations',
          coalesce(
            (
              select
                pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'id',
                    deriv.id::text,
                    'expected_qty',
                    pg_catalog.trim_scale (deriv.expected_qty)::text,
                    'required_qty',
                    pg_catalog.trim_scale (deriv.required_qty)::text,
                    'required_value',
                    pg_catalog.trim_scale (deriv.required_value)::text,
                    'cause_batch_id',
                    deriv.cause_batch_id,
                    'predecessor_id',
                    deriv.predecessor_id::text,
                    'created_at',
                    app.costing_timestamptz_text (deriv.created_at)
                  )
                  order by
                    deriv.id
                )
              from
                app.stock_count_derivations deriv
              where
                deriv.count_id = line.count_id
                and deriv.line_no = line.line_no
            ),
            '[]'::jsonb
          ),
          'postings',
          coalesce(
            (
              select
                pg_catalog.jsonb_agg(
                  posted.obj
                  order by
                    posted.movement_id,
                    posted.role_ord
                )
              from
                (
                  select
                    sm.id as movement_id,
                    0 as role_ord,
                    pg_catalog.jsonb_build_object(
                      'movement_id',
                      sm.id::text,
                      'role',
                      posting.posting_role,
                      'movement_type',
                      sm.movement_type::text,
                      'quantity',
                      pg_catalog.trim_scale (sm.quantity)::text,
                      'total_cost',
                      pg_catalog.trim_scale (sm.total_cost)::text,
                      'occurred_at',
                      app.costing_timestamptz_text (sm.occurred_at),
                      'created_at',
                      app.costing_timestamptz_text (posting.created_at)
                    ) as obj
                  from
                    app.stock_count_postings posting
                    join app.stock_movements sm on sm.id = posting.movement_id
                  where
                    posting.count_id = line.count_id
                    and posting.line_no = line.line_no
                  union all
                  select
                    sm.id,
                    1,
                    pg_catalog.jsonb_build_object(
                      'movement_id',
                      sm.id::text,
                      'role',
                      'adjustment',
                      'movement_type',
                      sm.movement_type::text,
                      'quantity',
                      pg_catalog.trim_scale (sm.quantity)::text,
                      'total_cost',
                      pg_catalog.trim_scale (sm.total_cost)::text,
                      'occurred_at',
                      app.costing_timestamptz_text (sm.occurred_at),
                      'created_at',
                      app.costing_timestamptz_text (sm.created_at)
                    )
                  from
                    app.stock_movements sm
                  where
                    sm.movement_type = 'cost_adjustment'
                    and sm.adjusts_movement_id in (
                      select
                        posting.movement_id
                      from
                        app.stock_count_postings posting
                      where
                        posting.count_id = line.count_id
                        and posting.line_no = line.line_no
                    )
                ) posted
            ),
            '[]'::jsonb
          )
        ) as obj
      from
        app.stock_count_lines line
        join app.stock_items si on si.id = line.item_id
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
            sum(sm.quantity) as qty,
            sum(sm.total_cost) as value
          from
            app.stock_count_postings posting
            join app.stock_movements sm on sm.id = posting.movement_id
          where
            posting.count_id = line.count_id
            and posting.line_no = line.line_no
            and sm.movement_type = 'count_compensation'
        ) comp on true
      where
        line.count_id = p_count_id
    ) line_row;

  return pg_catalog.jsonb_build_object(
    'found',
    true,
    'count_id',
    p_count_id,
    'counted_at',
    app.costing_timestamptz_text (v_at),
    'frequency',
    v_frequency,
    'note',
    v_note,
    'has_surplus',
    coalesce(v_surplus, false),
    'waiting_for_sync',
    v_waiting_sync,
    'waiting_for_processing',
    v_waiting_work,
    'lines',
    coalesce(v_lines, '[]'::jsonb)
  );
end;
$$;

comment on function app.stock_count_derivation_detail (uuid) is 'Owner only. One count: original observation, latest derivation, compensators, value adjustments on that settlement, surplus, and whether a covering sync or pending accounting work still reaches the count instant. A pending event is ignored only when both its latest input and its owner application are strictly before inventory_activation.stock_started_at. A rederive span that ends at or before that instant is ignored only when no order in it has an owner application at or after the start. An unresolved event stays relevant after its order is parked. Quantities and money are decimal text. Does not post stock.';

create or replace function app.pos_mapping_coverage (p_from timestamptz, p_to timestamptz) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_start timestamptz;
  v_missing bigint;
  v_canceled bigint;
  v_open bigint;
  v_before bigint;
  v_ready bigint;
  v_incomplete bigint;
  v_exception bigint;
  v_eligible bigint;
  v_covered bigint;
  v_subjects jsonb;
  v_coverage numeric;
  v_order_eligible bigint;
  v_order_ready bigint;
  v_order_incomplete bigint;
  v_order_line bigint;
  v_order_unreviewed bigint;
  v_order_blocked bigint;
  v_order_canceled bigint;
  v_order_open bigint;
  v_order_missing bigint;
  v_order_before bigint;
  v_order_coverage numeric;
  v_order_types jsonb;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_from is null
  or p_to is null
  or not pg_catalog.isfinite (p_from)
  or not pg_catalog.isfinite (p_to)
  or p_to <= p_from then
    raise exception 'coverage window must be a finite half-open interval'
      using errcode = '22023';
  end if;

  v_start := app.coverage_stock_start ();

  with
    window_lines as (
      select
        l.order_id,
        l.line_id,
        l.item_id,
        app.pos_size_key (l.size_name) as size_key,
        o.status,
        o.missing_from_pos,
        o.ordered_at
      from
        app.pos_order_lines l
        join app.pos_orders o on o.id = l.order_id
        join app.pos_shifts s on s.id = o.shift_id
      where
        s.opened_at >= p_from
        and s.opened_at < p_to
        and (
          l.quantity > 0
          or l.weighted_qty > 0
        )
    ),
    marked as (
      select
        w.*,
        case
          when w.missing_from_pos then 'missing'
          when w.status = 'canceled' then 'canceled'
          when w.status = 'active' then 'open'
          when v_start is null
          or w.ordered_at < v_start then 'before_stock_start'
          else 'eligible'
        end as cause
      from
        window_lines w
    ),
    resolved as materialized (
      select
        m.*,
        case
          when m.cause = 'eligible' then app.resolve_line_requirements (m.order_id, m.line_id) ->> 'status'
          else null
        end as line_status
      from
        marked m
    )
  select
    count(*) filter (
      where
        cause = 'missing'
    ),
    count(*) filter (
      where
        cause = 'canceled'
    ),
    count(*) filter (
      where
        cause = 'open'
    ),
    count(*) filter (
      where
        cause = 'before_stock_start'
    ),
    count(*) filter (
      where
        line_status = 'ready'
    ),
    count(*) filter (
      where
        line_status = 'incomplete'
    ),
    count(*) filter (
      where
        line_status = 'exception'
    ),
    count(*) filter (
      where
        cause = 'eligible'
    )
  into v_missing,
    v_canceled,
    v_open,
    v_before,
    v_ready,
    v_incomplete,
    v_exception,
    v_eligible
  from
    resolved;

  v_covered := coalesce(v_ready, 0) + coalesce(v_exception, 0);

  if coalesce(v_eligible, 0) = 0 then
    v_coverage := null;
  else
    v_coverage := pg_catalog.round(v_covered::numeric / v_eligible::numeric, 6);
  end if;

  with
    window_lines as (
      select
        l.order_id,
        l.line_id,
        l.item_id,
        app.pos_size_key (l.size_name) as size_key,
        o.status,
        o.missing_from_pos,
        o.ordered_at
      from
        app.pos_order_lines l
        join app.pos_orders o on o.id = l.order_id
        join app.pos_shifts s on s.id = o.shift_id
      where
        s.opened_at >= p_from
        and s.opened_at < p_to
        and (
          l.quantity > 0
          or l.weighted_qty > 0
        )
    ),
    marked as (
      select
        w.*,
        case
          when w.missing_from_pos then 'missing'
          when w.status = 'canceled' then 'canceled'
          when w.status = 'active' then 'open'
          when v_start is null
          or w.ordered_at < v_start then 'before_stock_start'
          else 'eligible'
        end as cause
      from
        window_lines w
    ),
    resolved as materialized (
      select
        m.*,
        case
          when m.cause = 'eligible' then app.resolve_line_requirements (m.order_id, m.line_id) ->> 'status'
          else null
        end as line_status
      from
        marked m
    )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'pos_item_id',
          g.item_id,
          'size_key',
          g.size_key,
          'line_count',
          g.line_count,
          'ready_count',
          g.ready_count,
          'incomplete_count',
          g.incomplete_count,
          'exception_count',
          g.exception_count,
          'status',
          case
            when g.incomplete_count > 0 then 'incomplete'
            when g.exception_count = g.line_count then 'exception'
            else 'ready'
          end
        )
        order by
          g.item_id,
          g.size_key::text
      ),
      '[]'::jsonb
    )
  into v_subjects
  from
    (
      select
        r.item_id,
        r.size_key,
        count(*)::integer as line_count,
        count(*) filter (
          where
            r.line_status = 'ready'
        )::integer as ready_count,
        count(*) filter (
          where
            r.line_status = 'incomplete'
        )::integer as incomplete_count,
        count(*) filter (
          where
            r.line_status = 'exception'
        )::integer as exception_count
      from
        resolved r
      where
        r.cause = 'eligible'
      group by
        r.item_id,
        r.size_key
    ) g;

  with
    window_orders as (
      select
        o.id,
        o.status,
        o.missing_from_pos,
        o.ordered_at,
        app.packaging_order_type_key (o.order_type) as order_type_key
      from
        app.pos_orders o
        join app.pos_shifts s on s.id = o.shift_id
      where
        s.opened_at >= p_from
        and s.opened_at < p_to
    ),
    marked as (
      select
        w.*,
        case
          when w.missing_from_pos then 'missing'
          when w.status = 'canceled' then 'canceled'
          when w.status = 'active' then 'open'
          when v_start is null
          or w.ordered_at < v_start then 'before_stock_start'
          else 'eligible'
        end as cause
      from
        window_orders w
    ),
    resolved as materialized (
      select
        m.*,
        case
          when m.cause = 'eligible' then app.resolve_order_requirements (m.id, null)
          else null
        end as resolved
      from
        marked m
    )
  select
    count(*) filter (
      where
        cause = 'eligible'
    ),
    count(*) filter (
      where
        resolved ->> 'status' = 'ready'
    ),
    count(*) filter (
      where
        resolved ->> 'status' = 'incomplete'
    ),
    count(*) filter (
      where
        resolved -> 'causes' ? 'line'
    ),
    count(*) filter (
      where
        resolved -> 'causes' ? 'packaging_unreviewed'
    ),
    count(*) filter (
      where
        resolved -> 'causes' ? 'blocked'
    ),
    count(*) filter (
      where
        cause = 'canceled'
    ),
    count(*) filter (
      where
        cause = 'open'
    ),
    count(*) filter (
      where
        cause = 'missing'
    ),
    count(*) filter (
      where
        cause = 'before_stock_start'
    )
  into v_order_eligible,
    v_order_ready,
    v_order_incomplete,
    v_order_line,
    v_order_unreviewed,
    v_order_blocked,
    v_order_canceled,
    v_order_open,
    v_order_missing,
    v_order_before
  from
    resolved;

  if coalesce(v_order_eligible, 0) = 0 then
    v_order_coverage := null;
  else
    v_order_coverage := pg_catalog.round(
      coalesce(v_order_ready, 0)::numeric / v_order_eligible::numeric,
      6
    );
  end if;

  with
    window_orders as (
      select
        o.id,
        o.status,
        o.missing_from_pos,
        o.ordered_at,
        app.packaging_order_type_key (o.order_type) as order_type_key
      from
        app.pos_orders o
        join app.pos_shifts s on s.id = o.shift_id
      where
        s.opened_at >= p_from
        and s.opened_at < p_to
    ),
    marked as (
      select
        w.*,
        case
          when w.missing_from_pos then 'missing'
          when w.status = 'canceled' then 'canceled'
          when w.status = 'active' then 'open'
          when v_start is null
          or w.ordered_at < v_start then 'before_stock_start'
          else 'eligible'
        end as cause
      from
        window_orders w
    ),
    resolved as materialized (
      select
        m.*,
        case
          when m.cause = 'eligible' then app.resolve_order_requirements (m.id, null)
          else null
        end as resolved
      from
        marked m
    )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'order_type_key',
          g.order_type_key,
          'label',
          case
            when g.order_type_key = '["none"]'::jsonb then null
            else g.order_type_key ->> 1
          end,
          'seen',
          g.seen,
          'eligible',
          g.eligible,
          'covered',
          g.covered,
          'unreviewed',
          g.unreviewed,
          'blocked',
          g.blocked,
          'coverage',
          case
            when g.eligible = 0 then null
            else pg_catalog.round(g.covered::numeric / g.eligible::numeric, 6)
          end
        )
        order by
          g.order_type_key::text
      ),
      '[]'::jsonb
    )
  into v_order_types
  from
    (
      select
        r.order_type_key,
        count(*)::integer as seen,
        count(*) filter (
          where
            r.cause = 'eligible'
        )::integer as eligible,
        count(*) filter (
          where
            r.cause = 'eligible'
            and r.resolved -> 'order_packaging' ->> 'state' in ('none', 'lines')
        )::integer as covered,
        count(*) filter (
          where
            r.cause = 'eligible'
            and r.resolved -> 'order_packaging' ->> 'state' = 'gap'
        )::integer as unreviewed,
        count(*) filter (
          where
            r.cause = 'eligible'
            and r.resolved -> 'order_packaging' ->> 'state' = 'blocked'
        )::integer as blocked
      from
        resolved r
      group by
        r.order_type_key
    ) g;

  return pg_catalog.jsonb_build_object(
    'stock_start',
    v_start,
    'eligible_lines',
    coalesce(v_eligible, 0),
    'covered_lines',
    v_covered,
    'ready_lines',
    coalesce(v_ready, 0),
    'incomplete_lines',
    coalesce(v_incomplete, 0),
    'exception_lines',
    coalesce(v_exception, 0),
    'coverage',
    v_coverage,
    'causes',
    pg_catalog.jsonb_build_object(
      'canceled',
      coalesce(v_canceled, 0),
      'open',
      coalesce(v_open, 0),
      'missing',
      coalesce(v_missing, 0),
      'before_stock_start',
      coalesce(v_before, 0)
    ),
    'subjects',
    coalesce(v_subjects, '[]'::jsonb),
    'orders',
    pg_catalog.jsonb_build_object(
      'eligible',
      coalesce(v_order_eligible, 0),
      'ready',
      coalesce(v_order_ready, 0),
      'incomplete',
      coalesce(v_order_incomplete, 0),
      'coverage',
      v_order_coverage,
      'causes',
      pg_catalog.jsonb_build_object(
        'line',
        coalesce(v_order_line, 0),
        'packaging_unreviewed',
        coalesce(v_order_unreviewed, 0),
        'blocked',
        coalesce(v_order_blocked, 0)
      ),
      'excluded',
      pg_catalog.jsonb_build_object(
        'canceled',
        coalesce(v_order_canceled, 0),
        'open',
        coalesce(v_order_open, 0),
        'missing',
        coalesce(v_order_missing, 0),
        'before_stock_start',
        coalesce(v_order_before, 0)
      )
    ),
    'order_types',
    coalesce(v_order_types, '[]'::jsonb)
  );
end;
$$;

-- ============================================================================
-- 7. First-attempt park for a caught recompute limit, and the timeout recorder.
-- ============================================================================
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
        and e.work_generation is null;

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

comment on function app.run_accounting_work (uuid, integer, text, integer) is 'Owner or service_role. Processes ONE pending order per call (p_limit is validated, 1 to 10, and reserved), after one bounded slice of a rederive span, under the ledger lock. A call must name its order: with p_order_id and p_work_generation (given together) it processes only that order in that generation, which must be the head of the queue when the call starts, and otherwise returns stale with the current head, so a caller that loses the reply knows which order to report. A call that names no order is maintenance only: it expands a span slice and returns the head (status processed with zero counts, or empty when nothing is pending and no span is open), and processes no order even when one is pending, so no order is ever processed without a caller who can report its failure. Work the slice enqueues waits for the next call. The order runs in a subtransaction; a caught error rolls it back and records the attempt, once per attempt id. A caught recompute_limit parks the order on the first attempt. Other caught reasons park after five attempts in one work generation (failed_at) until a new event or retry_accounting_work. Every processed outcome writes an accounting_work_completions row for the attempt id. blocked, none and disposition_pending count as success. critical stops the worker. Returns not_activated before an inventory_activation row exists, busy when the ledger lock is held, sync_running while a POS sync run is open. head is the next pending order and the generation to bind the next call to. The function settings (statement_timeout 6s, lock_timeout 250ms) are applied by PostgREST before the call, so they bound a Data API call; a direct SQL caller must set its own statement_timeout.';

create function app.record_accounting_recompute_timeout (
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

comment on function app.record_accounting_recompute_timeout (uuid, text, integer) is 'Owner or service_role. Records SQLSTATE 57014 for the order the worker call was bound to. Same completion and duplicate checks as record_accounting_call_failure. The first charge uses reason recompute_limit and sets failed_at immediately. A lost connection is not this function.';

revoke all on function app.record_accounting_recompute_timeout (uuid, text, integer)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.record_accounting_recompute_timeout (uuid, text, integer) to authenticated,
service_role;

comment on function app.record_accounting_call_failure (uuid, text, integer) is 'Owner or service_role. Records a worker call that failed without a reply (lost connection or a server error that is not SQLSTATE 57014) against the order the call was bound to, and only that order. Under the ledger lock it answers duplicate when the attempt id was already charged, committed when the call left completion evidence, no_work when the order has nothing pending, stale when it is pending in another generation; otherwise it charges one attempt in the generation the caller bound. Never charges the queue head or any other order.';

-- ============================================================================
-- 8. Catalog inserts take the ledger lock before the row lock.
-- ============================================================================
create function app.trg_stock_items_insert_lock () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

  return null;
end;
$$;

comment on function app.trg_stock_items_insert_lock () is 'BEFORE INSERT STATEMENT on stock_items. Takes the ledger advisory lock before any item row lock, so an insert cannot land between the activation token check and the observation write.';

revoke all on function app.trg_stock_items_insert_lock ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_items_insert_lock
before insert on app.stock_items for each statement
execute function app.trg_stock_items_insert_lock ();

-- ============================================================================
-- 9. Owner activation. Does not post stock and does not call the worker.
-- An all-zero catalog is refused: this restaurant always has opening stock.
-- A new activation also waits until accounting_scaling_ready is replaced.
-- ============================================================================
create function app.accounting_scaling_ready () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    false;
$$;

comment on function app.accounting_scaling_ready () is 'Private. False in this migration. 20261108090000_replay_checkpoint.sql replaces this function atomically once its checkpoint components exist and its benchmark gates pass. No API role can execute it.';

revoke all on function app.accounting_scaling_ready ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.activate_inventory (
  p_request_id uuid,
  p_manifest_hash text,
  p_explicit_zero_item_ids uuid[]
) returns jsonb language plpgsql volatile security definer
set
  search_path = ''
set
  lock_timeout = '2s'
set
  statement_timeout = '15s' as $$
declare
  v_hash text;
  v_token text;
  v_req app.inventory_activation_requests;
  v_start timestamptz;
  v_result jsonb;
  v_zeros text;
begin
  if not app.is_owner () then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  if p_manifest_hash is null
  or p_manifest_hash !~ '^[0-9a-f]{32}$' then
    raise exception 'opening manifest hash is required'
      using errcode = '22023';
  end if;

  if p_explicit_zero_item_ids is null then
    raise exception 'explicit zeros are required'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.unnest (p_explicit_zero_item_ids) z (item_id)
    group by
      z.item_id
    having
      count(*) > 1
  ) then
    raise exception 'explicit zero is repeated'
      using errcode = '22023';
  end if;

  select
    pg_catalog.string_agg(z.item_id::text, ',' order by z.item_id)
  into v_zeros
  from
    pg_catalog.unnest (p_explicit_zero_item_ids) z (item_id);

  v_hash := pg_catalog.md5(p_manifest_hash || '|' || coalesce(v_zeros, ''));

  select
    r.*
  into v_req
  from
    app.inventory_activation_requests r
  where
    r.request_id = p_request_id;

  if found then
    if v_req.payload_hash <> v_hash then
      raise exception 'request id was used for a different activation'
        using errcode = '22023';
    end if;

    return v_req.result;
  end if;

  perform pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

  select
    r.*
  into v_req
  from
    app.inventory_activation_requests r
  where
    r.request_id = p_request_id;

  if found then
    if v_req.payload_hash <> v_hash then
      raise exception 'request id was used for a different activation'
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

  v_token := app.opening_manifest_token ();

  if v_token is distinct from p_manifest_hash then
    raise exception 'opening manifest changed'
      using errcode = '40001';
  end if;

  if exists (
    select
      1
    from
      app.inventory_activation
  ) then
    raise exception 'inventory is already activated'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      app.stock_movements sm
    where
      sm.movement_type in (
        'sale',
        'sale_reversal',
        'waste',
        'waste_reversal'
      )
      and not exists (
        select
          1
        from
          app.order_cost_movement_links link
        where
          link.movement_id = sm.id
      )
      and not exists (
        select
          1
        from
          app.order_cost_applications application
        where
          sm.id = any (application.reversal_movement_ids)
      )
  ) then
    raise exception 'unreceipted outflows'
      using errcode = '22023';
  end if;

  if not exists (
    select
      1
    from
      app.stock_items
  ) then
    raise exception 'empty roster'
      using errcode = '22023';
  end if;

  if exists (
    select
      z.item_id
    from
      pg_catalog.unnest (p_explicit_zero_item_ids) z (item_id)
    except
    select
      si.id
    from
      app.stock_items si
    where
      not exists (
        select
          1
        from
          app.opening_stock_lines line
        where
          line.item_id = si.id
      )
  )
  or exists (
    select
      si.id
    from
      app.stock_items si
    where
      not exists (
        select
          1
        from
          app.opening_stock_lines line
        where
          line.item_id = si.id
      )
    except
    select
      z.item_id
    from
      pg_catalog.unnest (p_explicit_zero_item_ids) z (item_id)
  ) then
    raise exception 'explicit zeros do not match the roster'
      using errcode = '22023';
  end if;

  if not exists (
    select
      1
    from
      app.opening_stock_lines
  ) then
    raise exception 'a positive opening is required'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      app.opening_stock_lines line
    group by
      line.item_id
    having
      count(*) > 1
  ) then
    raise exception 'repeated opening'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.unnest (p_explicit_zero_item_ids) z (item_id)
      join app.stock_movements sm on sm.item_id = z.item_id
  ) then
    raise exception 'explicit zero item has movements'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      app.stock_items si
      join lateral (
        select
          line.opening_id,
          os.occurred_at
        from
          app.opening_stock_lines line
          join app.opening_stocks os on os.id = line.opening_id
        where
          line.item_id = si.id
        order by
          os.occurred_at,
          line.opening_id,
          line.line_no
        limit
          1
      ) earliest on true
    where
      not exists (
        select
          1
        from
          app.stock_movements sm
        where
          sm.batch_id = earliest.opening_id
          and sm.item_id = si.id
          and sm.movement_type = 'opening'
          and sm.occurred_at = earliest.occurred_at
      )
  ) then
    raise exception 'opening floor does not match'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      app.stock_items si
      join lateral (
        select
          line.opening_id,
          line.quantity,
          line.unit,
          os.occurred_at
        from
          app.opening_stock_lines line
          join app.opening_stocks os on os.id = line.opening_id
        where
          line.item_id = si.id
        order by
          os.occurred_at,
          line.opening_id,
          line.line_no
        limit
          1
      ) earliest on true
      join lateral (
        select
          sm.quantity
        from
          app.stock_movements sm
        where
          sm.batch_id = earliest.opening_id
          and sm.item_id = si.id
          and sm.movement_type = 'opening'
          and sm.occurred_at = earliest.occurred_at
        order by
          sm.id
        limit
          1
      ) move on true
    where
      earliest.unit = si.base_unit
      and move.quantity is distinct from earliest.quantity
  ) then
    raise exception 'item base unit changed'
      using errcode = '22023';
  end if;

  -- After both request replays, still holding the ledger lock, and before
  -- any insert. A stored request already returned above.
  if not app.accounting_scaling_ready () then
    raise exception 'scaling is not ready'
      using errcode = '55000';
  end if;

  select
    min(os.occurred_at)
  into v_start
  from
    app.opening_stocks os
    join app.opening_stock_lines line on line.opening_id = os.id;

  v_result := pg_catalog.jsonb_build_object(
    'activated',
    true,
    'stock_started_at',
    app.costing_timestamptz_text (v_start),
    'opening_manifest_hash',
    app.opening_manifest_digest (true)
  );

  insert into
    app.inventory_activation (
      id,
      stock_started_at,
      approved_by,
      approved_at,
      request_id,
      opening_manifest_hash
    )
  values
    (
      1,
      v_start,
      auth.uid (),
      pg_catalog.clock_timestamp (),
      p_request_id,
      v_result ->> 'opening_manifest_hash'
    );

  insert into
    app.inventory_opening_observations (
      item_id,
      base_unit,
      quantity,
      explicit_zero,
      opening_id,
      line_no,
      observed_at
    )
  select
    si.id,
    si.base_unit,
    case
      when earliest.opening_id is null then 0
      else move.quantity
    end,
    earliest.opening_id is null,
    earliest.opening_id,
    earliest.line_no,
    case
      when earliest.opening_id is null then v_start
      else earliest.occurred_at
    end
  from
    app.stock_items si
    left join lateral (
      select
        line.opening_id,
        line.line_no,
        os.occurred_at
      from
        app.opening_stock_lines line
        join app.opening_stocks os on os.id = line.opening_id
      where
        line.item_id = si.id
      order by
        os.occurred_at,
        line.opening_id,
        line.line_no
      limit
        1
    ) earliest on true
    left join lateral (
      select
        sm.quantity
      from
        app.stock_movements sm
      where
        sm.batch_id = earliest.opening_id
        and sm.item_id = si.id
        and sm.movement_type = 'opening'
        and sm.occurred_at = earliest.occurred_at
      order by
        sm.id
      limit
        1
    ) move on true;

  insert into
    app.inventory_activation_requests (request_id, payload_hash, result)
  values
    (p_request_id, v_hash, v_result);

  return v_result;
end;
$$;

comment on function app.activate_inventory (uuid, text, uuid[]) is 'Owner only. Confirms the catalog token and the explicit-zero set, then stores inventory_activation and one observation per current item. stock_started_at is the earliest referenced positive opening. Differing opening instants stay legal. An empty roster and an all-zero catalog are refused. A stored request is returned before the scaling check. A new activation raises 55000 scaling is not ready while app.accounting_scaling_ready() is false. Does not post a stock movement and does not call the worker. service_role is not granted.';

revoke all on function app.activate_inventory (uuid, text, uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.activate_inventory (uuid, text, uuid[]) to authenticated;
