-- Mixed-fish sorting documents.
--
-- app.post_sort already posts one batch: sort_out of the kilograms that go to
-- sizes, sort_loss of the remainder, and sort_in of each size at the mixed
-- item's moving average (the last size keeps the remaining piasters). This
-- migration does not redo that math. It records the owner's request, replays
-- it, and calls post_sort.
--
-- Lock order matches record_purchase. app.assert_ledger_write_allowed() is
-- the first statement. It checks the owner (or service_role) and takes
-- advisory lock 7342750000000000001 before this function reads sort_batches
-- and before post_sort locks item_balances. The request_id lookup uses only
-- the normalized payload, so a replay returns before any catalog read.
-- sort_batches.request_id is unique as the last guard.
-- ============================================================================
-- 1. Append-only sort documents
-- ============================================================================
create table app.sort_batches (
  -- The ledger batch id returned by app.post_sort. Not a second id.
  id uuid primary key,
  -- One id per draft. A lost reply retries this id; a new draft gets a new one.
  request_id uuid not null unique,
  mixed_item_id uuid not null references app.stock_items (id) on delete restrict,
  occurred_at timestamptz not null,
  qty_taken numeric(20, 6) not null,
  note text null,
  created_at timestamptz not null default now(),
  created_by uuid null default auth.uid (),
  constraint sort_batches_occurred_at_finite_chk check (pg_catalog.isfinite (occurred_at)),
  constraint sort_batches_qty_taken_chk check (
    qty_taken <> 'NaN'::numeric
    and qty_taken > 0
  ),
  constraint sort_batches_note_chk check (
    note is null
    or (
      char_length(note) between 1 and 500
      and note = btrim(note)
    )
  )
);

comment on table app.sort_batches is 'Append-only mixed-fish sorts. id is the ledger batch id returned by app.post_sort. Writes go through app.record_sort.';

comment on column app.sort_batches.request_id is 'Idempotency key generated once per sort draft. The same key and the same normalized payload return this batch; a different payload is refused.';

comment on column app.sort_batches.qty_taken is 'Kilograms taken from the mixed item. The ledger splits this into sort_out (the sizes) and sort_loss (the remainder).';

create index sort_batches_created_at_idx on app.sort_batches (created_at, id);

create index sort_batches_occurred_at_idx on app.sort_batches (occurred_at, created_at, id);

create index sort_batches_mixed_item_idx on app.sort_batches (mixed_item_id);

create table app.sort_batch_lines (
  batch_id uuid not null references app.sort_batches (id) on delete restrict,
  line_no integer not null,
  size_item_id uuid not null references app.stock_items (id) on delete restrict,
  quantity numeric(20, 6) not null,
  primary key (batch_id, line_no),
  constraint sort_batch_lines_size_key unique (batch_id, size_item_id),
  constraint sort_batch_lines_line_no_chk check (line_no > 0),
  constraint sort_batch_lines_quantity_chk check (
    quantity <> 'NaN'::numeric
    and quantity > 0
  )
);

comment on table app.sort_batch_lines is 'Append-only size lines of a sort, in the order they were posted. quantity is kilograms.';

create index sort_batch_lines_size_item_id_idx on app.sort_batch_lines (size_item_id);

create function app.prevent_sort_mutation () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception '%.% is append-only; % is not allowed', tg_table_schema, tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

comment on function app.prevent_sort_mutation () is 'Rejects update, delete, and truncate on sort documents.';

revoke all on function app.prevent_sort_mutation ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_sort_batches_no_update_delete
before update or delete on app.sort_batches for each row
execute function app.prevent_sort_mutation ();

create trigger trg_sort_batches_no_truncate
before truncate on app.sort_batches for each statement
execute function app.prevent_sort_mutation ();

create trigger trg_sort_batch_lines_no_update_delete
before update or delete on app.sort_batch_lines for each row
execute function app.prevent_sort_mutation ();

create trigger trg_sort_batch_lines_no_truncate
before truncate on app.sort_batch_lines for each statement
execute function app.prevent_sort_mutation ();

-- ============================================================================
-- 2. record_sort
-- ============================================================================
create function app.record_sort (p_sort jsonb) returns uuid language plpgsql security definer
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

comment on function app.record_sort (jsonb) is 'Posts one mixed-fish sort through app.post_sort and stores the request. Takes advisory lock 7342750000000000001 before the replay lookup. The same request_id and normalized payload returns the saved batch id and does not post again.';

revoke all on function app.record_sort (jsonb)
from
  public,
  anon;

grant
execute on function app.record_sort (jsonb) to authenticated,
service_role;

-- ============================================================================
-- 3. History. Figures come from the batch movements, not a second costing.
-- qty_taken is the mixed item's sort_out plus sort_loss (the kilograms that
-- left). sizes_qty is the sort_in sum. loss_qty and loss_value are sort_loss.
-- cost_per_kg is the mixed moving average stored on sort_out.
-- ============================================================================
create view app.sort_history
with
  (security_invoker = true) as
select
  batch.id,
  batch.mixed_item_id,
  item.name as mixed_item_name,
  coalesce(moved.occurred_at, batch.occurred_at) as occurred_at,
  batch.created_at,
  batch.note,
  coalesce(moved.qty_taken, 0::numeric(20, 6)) as qty_taken,
  coalesce(moved.sizes_qty, 0::numeric(20, 6)) as sizes_qty,
  coalesce(moved.loss_qty, 0::numeric(20, 6)) as loss_qty,
  coalesce(moved.loss_value, 0::numeric(14, 2)) as loss_value,
  moved.cost_per_kg
from
  app.sort_batches batch
  join app.stock_items item on item.id = batch.mixed_item_id
  join lateral (
    select
      min(sm.occurred_at) filter (
        where
          sm.movement_type = 'sort_out'
      ) as occurred_at,
      (
        - sum(sm.quantity) filter (
          where
            sm.movement_type in ('sort_out', 'sort_loss')
            and sm.item_id = batch.mixed_item_id
        )
      )::numeric(20, 6) as qty_taken,
      coalesce(
        sum(sm.quantity) filter (
          where
            sm.movement_type = 'sort_in'
        ),
        0
      )::numeric(20, 6) as sizes_qty,
      coalesce(
        - sum(sm.quantity) filter (
          where
            sm.movement_type = 'sort_loss'
        ),
        0
      )::numeric(20, 6) as loss_qty,
      coalesce(
        - sum(sm.total_cost) filter (
          where
            sm.movement_type = 'sort_loss'
        ),
        0
      )::numeric(14, 2) as loss_value,
      (
        min(sm.unit_cost) filter (
          where
            sm.movement_type = 'sort_out'
            and sm.item_id = batch.mixed_item_id
        )
      )::numeric(20, 6) as cost_per_kg
    from
      app.stock_movements sm
    where
      sm.batch_id = batch.id
      and sm.movement_type in ('sort_out', 'sort_in', 'sort_loss')
  ) as moved on true;

comment on view app.sort_history is 'One row per sort. security_invoker so RLS on sort_batches, stock_items, and stock_movements applies. Quantities and the loss value are exact numerics read from that batch''s movements.';

revoke all on table app.sort_history
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.sort_history to authenticated,
  service_role;

-- ============================================================================
-- 4. Row-level security and grants
-- ============================================================================
alter table app.sort_batches enable row level security;

alter table app.sort_batch_lines enable row level security;

create policy sort_batches_select_owner on app.sort_batches for
select
  to authenticated using (app.is_owner ());

create policy sort_batch_lines_select_owner on app.sort_batch_lines for
select
  to authenticated using (app.is_owner ());

revoke all on table app.sort_batches
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.sort_batch_lines
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.sort_batches,
  app.sort_batch_lines to authenticated,
  service_role;
