-- Purchases and opening stock.
--
-- Both writes go through security-definer functions that call
-- app.assert_ledger_write_allowed() before any catalog read or row lock.
-- That takes advisory lock 7342750000000000001, the same lock post_movements,
-- base_unit changes, and conversion writes take before their own row locks.
-- A concurrent post or base_unit change therefore either commits before we
-- read, or waits until this transaction ends.
--
-- Purchase total_cost: app.post_movements sets total_cost to
-- round(entered quantity × entered unit cost, 2), rejects a zero purchase
-- cost, and returns only the batch id. A line's amount_paid is the money the
-- owner paid for the whole line, and round(base quantity × round(amount /
-- base quantity, 6), 2) can land on a different piaster (for example 10005
-- units at 10.00). record_purchase therefore calls app.apply_inflow_movement
-- directly and passes amount_paid as p_in_total_cost. That parameter is stored
-- as stock_movements.total_cost and added to on_hand_value without being
-- recomputed from unit_cost. The stored unit_cost is
-- round(amount_paid / base_quantity, 6), the same base-unit rounding the
-- ledger uses, and it is what the moving average falls back to when an inflow
-- only covers a deficit. Opening stock does fit post_movements: the owner
-- enters a unit cost, the ledger rounds quantity × unit cost to the piaster,
-- and the function returns the one batch id. The "no prior movement" rule is
-- not inside post_movements, so record_opening_stock checks it after the
-- advisory lock and before the post.
-- ============================================================================
-- 1. Append-only purchase documents
-- ============================================================================
create table app.purchases (
  id uuid primary key default gen_random_uuid(),
  purchased_at timestamptz not null,
  supplier text null,
  invoice_no text null,
  note text null,
  total_paid numeric(14, 2) not null,
  batch_id uuid not null unique,
  created_at timestamptz not null default now(),
  created_by uuid null default auth.uid (),
  constraint purchases_purchased_at_finite_chk check (pg_catalog.isfinite (purchased_at)),
  constraint purchases_supplier_chk check (
    supplier is null
    or (
      char_length(supplier) between 1 and 120
      and supplier = btrim(supplier)
    )
  ),
  constraint purchases_invoice_no_chk check (
    invoice_no is null
    or (
      char_length(invoice_no) between 1 and 60
      and invoice_no = btrim(invoice_no)
    )
  ),
  constraint purchases_note_chk check (
    note is null
    or (
      char_length(note) between 1 and 500
      and note = btrim(note)
    )
  ),
  constraint purchases_total_paid_chk check (
    total_paid <> 'NaN'::numeric
    and total_paid >= 0
  )
);

comment on table app.purchases is 'Append-only purchase headers. Writes go through app.record_purchase. total_paid is the sum of line amount_paid, each of which is stored as the linked movement total_cost.';

comment on column app.purchases.batch_id is 'stock_movements.batch_id for the purchase lines posted with this header.';

create index purchases_purchased_at_idx on app.purchases (purchased_at desc, created_at desc);

create table app.purchase_lines (
  purchase_id uuid not null references app.purchases (id) on delete restrict,
  line_no integer not null,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  quantity numeric(20, 6) not null,
  unit text not null,
  base_quantity numeric(20, 6) not null,
  amount_paid numeric(14, 2) not null,
  movement_id bigint not null unique references app.stock_movements (id) on delete restrict,
  primary key (purchase_id, line_no),
  constraint purchase_lines_line_no_chk check (line_no > 0),
  constraint purchase_lines_quantity_chk check (
    quantity <> 'NaN'::numeric
    and quantity > 0
  ),
  constraint purchase_lines_unit_chk check (
    char_length(btrim(unit)) > 0
    and unit = btrim(unit)
  ),
  constraint purchase_lines_base_quantity_chk check (
    base_quantity <> 'NaN'::numeric
    and base_quantity > 0
  ),
  constraint purchase_lines_amount_paid_chk check (
    amount_paid <> 'NaN'::numeric
    and amount_paid >= 0
  )
);

comment on table app.purchase_lines is 'Append-only purchase lines. quantity and unit are what the owner entered; base_quantity is the ledger quantity; amount_paid is the movement total_cost.';

comment on column app.purchase_lines.movement_id is 'The purchase inflow posted for this line. total_cost on that movement equals amount_paid.';

create index purchase_lines_item_id_idx on app.purchase_lines (item_id);

create function app.prevent_purchase_mutation () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception '%.% is append-only; % is not allowed', tg_table_schema, tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

revoke all on function app.prevent_purchase_mutation ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_purchases_no_update_delete
before update or delete on app.purchases for each row
execute function app.prevent_purchase_mutation ();

create trigger trg_purchases_no_truncate
before truncate on app.purchases for each statement
execute function app.prevent_purchase_mutation ();

create trigger trg_purchase_lines_no_update_delete
before update or delete on app.purchase_lines for each row
execute function app.prevent_purchase_mutation ();

create trigger trg_purchase_lines_no_truncate
before truncate on app.purchase_lines for each statement
execute function app.prevent_purchase_mutation ();

-- ============================================================================
-- 2. record_purchase
-- ============================================================================
-- Lock order: app.assert_ledger_write_allowed() is the first statement. It
-- checks the owner (or service_role) and takes advisory lock 7342750000000000001
-- before this function reads stock_items, item_unit_conversions, or
-- stock_movements, and before app.apply_inflow_movement locks item_balances
-- for update. base_unit changes and conversion writes take that same advisory
-- lock before their row locks, so the unit and factor read here cannot sit
-- between those locks. Movement ids are read after the inflow insert in the
-- same transaction; no second session can insert into the batch while the
-- advisory lock is held.
create function app.record_purchase (p_purchase jsonb) returns uuid language plpgsql security definer
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
begin
  perform app.assert_ledger_write_allowed ();

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

    if v_unit = v_base_unit then
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
        raise exception 'unknown unit "%" for item %', v_unit, v_name
          using errcode = '22023';
      end if;
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

    v_item_ids := v_item_ids || v_item_id;
    v_names := v_names || v_name;
    v_qtys := v_qtys || v_qty;
    v_units := v_units || v_unit;
    v_base_qtys := v_base_qtys || v_base_qty;
    v_amounts := v_amounts || v_amount;
    v_unit_costs := v_unit_costs || v_unit_cost;
    v_n := v_n + 1;
  end loop;

  v_purchase_id := pg_catalog.gen_random_uuid();
  v_batch_id := pg_catalog.gen_random_uuid();

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
        if sqlerrm = 'back-dated movement not supported yet' then
          raise exception 'back-dated movement not supported yet'
            using errcode = 'P0001',
            detail = v_name;
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

  insert into
    app.purchases (
      id,
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

comment on function app.record_purchase (jsonb) is 'Posts one purchase and its lines in the caller transaction. Takes advisory lock 7342750000000000001 via app.assert_ledger_write_allowed before reading units or locking balances. Each line''s stock_movements.total_cost is amount_paid exactly (passed as apply_inflow_movement.p_in_total_cost); unit_cost is round(amount_paid / base_quantity, 6).';

revoke all on function app.record_purchase (jsonb)
from
  public,
  anon;

grant
execute on function app.record_purchase (jsonb) to authenticated,
service_role;

-- ============================================================================
-- 3. record_opening_stock
-- ============================================================================
-- Lock order matches record_purchase. The "item already has any movement"
-- check runs only after the advisory lock, so a concurrent post cannot insert
-- a movement between the check and app.post_movements. post_movements takes
-- the same lock again (already held) and locks item_balances only then.
-- Quantity 0 lines are omitted. One post_movements call is one batch.
create function app.record_opening_stock (p_occurred_at timestamptz, p_lines jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_batch_id uuid;
  v_movements jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_seen uuid[] := '{}'::uuid[];
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
  v_base_qty numeric;
  v_line_total numeric;
  v_count integer := 0;
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

    if v_qty = 0 then
      continue;
    end if;

    v_unit := nullif(pg_catalog.btrim(v_elem ->> 'unit'), '');

    if v_unit is null then
      raise exception 'unit is required'
        using errcode = '22023';
    end if;

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

    -- Still holding the posting advisory lock, so no concurrent post can
    -- insert a movement for this item until we commit or roll back.
    if exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = v_item_id
    ) then
      raise exception 'item already has movements: %', v_name
        using errcode = '22023';
    end if;

    if v_unit = v_base_unit then
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
        raise exception 'unknown unit "%" for item %', v_unit, v_name
          using errcode = '22023';
      end if;
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

    v_seen := v_seen || v_item_id;
    v_movements := v_movements || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'item_id',
        v_item_id,
        'movement_type',
        'opening',
        'occurred_at',
        p_occurred_at,
        'quantity',
        v_qty,
        'unit',
        v_unit,
        'unit_cost',
        v_unit_cost,
        'source_type',
        'opening'
      )
    );
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'at least one opening line is required'
      using errcode = '22023';
  end if;

  v_batch_id := app.post_movements (v_movements);
  return v_batch_id;
end;
$$;

comment on function app.record_opening_stock (timestamptz, jsonb) is 'Posts one opening batch through app.post_movements. Takes advisory lock 7342750000000000001 before checking that each item has no movements and before post_movements locks balances. Quantity 0 lines are skipped. The returned uuid is the ledger batch id.';

revoke all on function app.record_opening_stock (timestamptz, jsonb)
from
  public,
  anon;

grant
execute on function app.record_opening_stock (timestamptz, jsonb) to authenticated,
service_role;

-- ============================================================================
-- 4. Row-level security and grants
-- ============================================================================
alter table app.purchases enable row level security;

alter table app.purchase_lines enable row level security;

create policy purchases_select_owner on app.purchases for
select
  to authenticated using (app.is_owner ());

create policy purchase_lines_select_owner on app.purchase_lines for
select
  to authenticated using (app.is_owner ());

revoke all on table app.purchases
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.purchase_lines
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.purchases,
  app.purchase_lines to authenticated,
  service_role;
