-- Reasoned manual waste (phase 5, PR 6). Replaces no function.
-- Lock order: the ledger advisory lock first, then the referenced tables, NOWAIT.
select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

do $lock_tables$
begin
  lock table app.item_conversion_versions,
  app.stock_items,
  app.stock_movements,
  app.units in share row exclusive mode nowait;
end;
$lock_tables$;

-- ============================================================================
-- 1. Documents, lines, posting links, requests. All append-only.
-- ============================================================================
create table app.waste_documents (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  occurred_at timestamptz not null check (pg_catalog.isfinite (occurred_at)),
  reason_code text not null check (
    reason_code in ('staff_meal', 'spoilage', 'other')
  ),
  explanation text null check (
    explanation is null
    or (
      explanation = pg_catalog.btrim (explanation)
      and length(explanation) between 1 and 300
    )
  ),
  shift_id text null,
  predecessor_id bigint null unique references app.waste_documents (id) on delete restrict,
  is_void boolean not null default false,
  event_position bigint not null,
  batch_id uuid null,
  retire_batch_id uuid null,
  actor uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint waste_documents_other_chk check (
    reason_code <> 'other'
    or explanation is not null
  ),
  constraint waste_documents_void_chk check (
    is_void = (batch_id is null)
    and (
      not is_void
      or predecessor_id is not null
    )
  ),
  constraint waste_documents_retire_chk check (
    (retire_batch_id is not null) = (predecessor_id is not null)
  )
);

comment on table app.waste_documents is 'Append-only. One owner-entered waste document: occurrence time, manual reason code, optional explanation, the shift it is attributed to, its stable event position, and the posting batch. A correction is a new row whose predecessor_id names the corrected row (at most one correction per row); a void is a correction with no lines (is_void). The original is never edited. No customer data; explanation is owner free text of at most 300 characters.';

comment on column app.waste_documents.batch_id is 'Posting batch of the waste movements; null for a void.';

comment on column app.waste_documents.retire_batch_id is 'Batch of the reversal movements that retired the predecessor; null for a first document.';

create table app.waste_lines (
  id bigint generated always as identity primary key,
  document_id bigint not null references app.waste_documents (id) on delete restrict,
  line_no integer not null check (line_no >= 1),
  item_id uuid not null references app.stock_items (id) on delete restrict,
  input_quantity numeric(20, 6) not null check (input_quantity > 0),
  input_unit text not null references app.units (code) on delete restrict,
  factor numeric not null check (
    factor > 0
    and factor <> 'NaN'::numeric
    and factor <> 'Infinity'::numeric
  ),
  factor_source text not null check (factor_source in ('base', 'explicit', 'metric')),
  conversion_version_id uuid null,
  base_unit text not null,
  base_quantity numeric(20, 6) not null check (base_quantity > 0),
  constraint waste_lines_document_line_key unique (document_id, line_no),
  constraint waste_lines_document_item_key unique (document_id, item_id),
  constraint waste_lines_source_chk check (
    (factor_source = 'explicit') = (conversion_version_id is not null)
  )
);

comment on table app.waste_lines is 'Append-only. One stock item per line: the input quantity and unit, the conversion saved as of the occurrence time (factor, its source, and the dated version when explicit), the base unit and the base quantity that was posted. base_quantity is physical stock removed; recipe cleaning loss is never applied.';

comment on column app.waste_lines.conversion_version_id is 'Dated conversion version read by the server (explicit factors only). No foreign key: it would block the TRUNCATE guard on app.item_conversion_versions.';

create table app.waste_line_movements (
  movement_id bigint primary key references app.stock_movements (id) on delete restrict,
  line_id bigint not null references app.waste_lines (id) on delete restrict,
  document_id bigint not null references app.waste_documents (id) on delete restrict
);

comment on table app.waste_line_movements is 'Append-only. The waste movements each line posted (more than one when the ledger splits a line across cost layers).';

create index waste_line_movements_line_idx on app.waste_line_movements (line_id);

create index waste_line_movements_document_idx on app.waste_line_movements (document_id);

create table app.waste_requests (
  request_id uuid primary key,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{32}$'),
  document_id bigint not null references app.waste_documents (id) on delete restrict,
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp ()
);

comment on table app.waste_requests is 'Append-only. The stored result of each committed record_waste request id. A repeat with the same payload returns it without reading mutable state; a different payload for the same id is rejected.';

create trigger trg_waste_documents_no_update_delete
before update or delete on app.waste_documents for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_waste_documents_no_truncate
before truncate on app.waste_documents for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_waste_lines_no_update_delete
before update or delete on app.waste_lines for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_waste_lines_no_truncate
before truncate on app.waste_lines for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_waste_line_movements_no_update_delete
before update or delete on app.waste_line_movements for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_waste_line_movements_no_truncate
before truncate on app.waste_line_movements for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_waste_requests_no_update_delete
before update or delete on app.waste_requests for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_waste_requests_no_truncate
before truncate on app.waste_requests for each statement
execute function app.prevent_append_only_mutation ();

-- ============================================================================
-- 2. RLS and grants. Owner-only SELECT. No DML grant for any API role.
-- ============================================================================
alter table app.waste_documents enable row level security;

alter table app.waste_lines enable row level security;

alter table app.waste_line_movements enable row level security;

alter table app.waste_requests enable row level security;

create policy waste_documents_select_owner on app.waste_documents for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy waste_lines_select_owner on app.waste_lines for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy waste_line_movements_select_owner on app.waste_line_movements for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy waste_requests_select_owner on app.waste_requests for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.waste_documents,
app.waste_lines,
app.waste_line_movements,
app.waste_requests
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.waste_documents_id_seq,
app.waste_lines_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.waste_documents,
  app.waste_lines,
  app.waste_line_movements,
  app.waste_requests to authenticated,
  service_role;

-- ============================================================================
-- 3. Owner RPC. Lock order: ledger advisory lock, pos_sync_runs SHARE (a
-- running sync is 55P03), pos_shifts SHARE, then balances in item order.
-- Posting goes through the private engine path, never the public poster.
-- ============================================================================
create function app.record_waste (p_request_id uuid, p_document jsonb) returns jsonb language plpgsql volatile security definer
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

  if v_pred is not null then
    v_retire_batch := pg_catalog.gen_random_uuid ();
    perform app.retire_movements (v_old_ids, v_retire_batch);
  end if;

  if not v_void then
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

  if v_batch is not null then
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

comment on function app.record_waste (uuid, jsonb) is 'Owner only. Records a reasoned waste document, or corrects or voids one, in one transaction under the ledger lock. Document: {occurred_at (ISO with offset), reason_code (staff_meal, spoilage, other; other needs an explanation; cancel_after_preparation is engine-only and refused), explanation, predecessor_id (decimal text), lines: [{item_id, quantity (decimal text), unit}]}. A correction names the predecessor and carries the new document; a void names the predecessor with no lines. The predecessor movements are retired through the one reversal path and the replacement posts at the same event position. A predecessor that was already corrected is 40001. Quantities are physical base stock removed: the dated conversion in force at the occurrence time is saved and recipe cleaning loss is not applied. Valued at the event instant with the engine provisional basis; a missing basis is P0001 missing_cost_basis (hint lists the item ids). Before inventory activation: 55000 inventory is not activated. A running POS sync is 55P03; retry with the same request id. The same payload under a request id returns the stored result; a different payload is 22023. Returns the exact stock, cost and profit differences as decimal text.';

revoke all on function app.record_waste (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.record_waste (uuid, jsonb) to authenticated;

-- ============================================================================
-- 4. Read side. security_invoker, so the owner-only RLS of the base tables
-- applies. Keyset by id descending. Quantities and money are decimal text.
-- ============================================================================
create view app.waste_history
with
  (security_invoker = true) as
select
  d.id,
  d.request_id,
  d.occurred_at,
  d.reason_code,
  d.explanation,
  d.shift_id,
  d.predecessor_id,
  succ.id as successor_id,
  case
    when d.is_void then 'void'
    when d.predecessor_id is not null then 'correction'
    else 'record'
  end as kind,
  d.is_void,
  (
    succ.id is null
    and not d.is_void
  ) as is_current,
  d.created_at,
  coalesce(v.total, 0)::numeric(14, 2)::text as value,
  coalesce(ln.lines, '[]'::jsonb) as lines
from
  app.waste_documents d
  left join app.waste_documents succ on succ.predecessor_id = d.id
  left join lateral (
    select
      - sum(sm.total_cost + coalesce(adj.total, 0)) as total
    from
      app.waste_line_movements wm
      join app.stock_movements sm on sm.id = wm.movement_id
      left join lateral (
        select
          sum(ca.total_cost) as total
        from
          app.stock_movements ca
        where
          ca.adjusts_movement_id = sm.id
          and ca.movement_type = 'cost_adjustment'
      ) adj on true
    where
      wm.document_id = d.id
  ) v on true
  left join lateral (
    select
      pg_catalog.jsonb_agg (
        pg_catalog.jsonb_build_object (
          'line_no',
          l.line_no,
          'item_id',
          l.item_id,
          'name',
          si.name,
          'input_quantity',
          pg_catalog.trim_scale (l.input_quantity)::text,
          'input_unit',
          l.input_unit,
          'factor',
          pg_catalog.trim_scale (l.factor)::text,
          'factor_source',
          l.factor_source,
          'conversion_version_id',
          l.conversion_version_id,
          'base_unit',
          l.base_unit,
          'base_quantity',
          pg_catalog.trim_scale (l.base_quantity)::text,
          'value',
          coalesce(lv.total, 0)::numeric(14, 2)::text
        )
        order by
          l.line_no
      ) as lines
    from
      app.waste_lines l
      join app.stock_items si on si.id = l.item_id
      left join lateral (
        select
          - sum(sm.total_cost + coalesce(adj.total, 0)) as total
        from
          app.waste_line_movements wm
          join app.stock_movements sm on sm.id = wm.movement_id
          left join lateral (
            select
              sum(ca.total_cost) as total
            from
              app.stock_movements ca
            where
              ca.adjusts_movement_id = sm.id
              and ca.movement_type = 'cost_adjustment'
          ) adj on true
        where
          wm.line_id = l.id
      ) lv on true
    where
      l.document_id = d.id
  ) ln on true;

comment on view app.waste_history is 'One row per waste document; callers page with order by id desc and id < after. successor_id names the correction that replaced it, if any; is_current marks the live document of a chain. value is the cost of the document movements including later valuation adjustments, positive for a loss, as decimal text. lines carry the saved conversion and quantities as decimal text. security_invoker so owner-only RLS applies.';

revoke all on table app.waste_history
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.waste_history to authenticated,
  service_role;
