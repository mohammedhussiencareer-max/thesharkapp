-- Costing foundation (phase 4, PR 1). Additive only.
--
-- Dated loss and per-item conversions, an append-only audit of every
-- configuration change, and one current opening price per item. Nothing here
-- writes the stock ledger, and legacy loss_pct / item_unit_conversions rows
-- are not copied forward (that is the PR 2 cutover).
--
-- Writers take advisory lock 7342750000000000001 before any item or version
-- row lock, the same key as posting. A base_unit / kind / parent_item_id
-- update takes that lock in a BEFORE STATEMENT trigger, then the row trigger
-- refuses the change once the item is configured or has movements.
-- ============================================================================
-- A. btree_gist lives in the extensions schema, same as the other extensions.
-- ============================================================================
create extension if not exists btree_gist
with
  schema extensions;

-- ============================================================================
-- B. Append-only audit of configuration changes.
-- ============================================================================
create table app.costing_changes (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  kind text not null check (kind in ('owner', 'import', 'legacy')),
  actor_id uuid null references auth.users (id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  reason text null,
  payload jsonb not null,
  result jsonb not null,
  constraint costing_changes_reason_chk check (
    reason is null
    or (
      length(btrim(reason)) = length(reason)
      and length(reason) between 1 and 500
    )
  )
);

comment on table app.costing_changes is 'Append-only audit of costing configuration. payload and result are built by the writer from typed arguments. reason is required when the change backdates.';

create index costing_changes_recorded_at_id_idx on app.costing_changes (recorded_at, id);

create index costing_changes_actor_id_idx on app.costing_changes (actor_id);

create trigger trg_costing_changes_no_update_delete
before update or delete on app.costing_changes for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_costing_changes_no_truncate
before truncate on app.costing_changes for each statement
execute function app.prevent_append_only_mutation ();

-- ============================================================================
-- C. Units. Mass and volume convert implicitly by metric_scale.
-- Count and custom never convert implicitly, and neither does a cross-dimension pair.
-- ============================================================================
create table app.units (
  code text primary key,
  label_ar text not null,
  dimension text not null check (
    dimension in ('mass', 'volume', 'count', 'custom')
  ),
  metric_scale numeric null,
  constraint units_code_chk check (
    code = btrim(code)
    and length(code) between 1 and 20
  ),
  constraint units_metric_scale_chk check (
    (
      dimension in ('mass', 'volume')
      and metric_scale is not null
      and metric_scale <> 'NaN'::numeric
      and metric_scale <> 'Infinity'::numeric
      and metric_scale <> '-Infinity'::numeric
      and metric_scale > 0
    )
    or (
      dimension in ('count', 'custom')
      and metric_scale is null
    )
  )
);

comment on table app.units is 'Unit catalog. code, dimension, and metric_scale are immutable; label_ar may change. Implicit factor between two mass or volume units is from.metric_scale / to.metric_scale.';

create function app.trg_units_immutable () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'app.units rows are immutable; DELETE is not allowed'
      using errcode = '55000';
  end if;

  if new.code is distinct from old.code
  or new.dimension is distinct from old.dimension
  or new.metric_scale is distinct from old.metric_scale then
    raise exception 'app.units code, dimension, and metric_scale are immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create function app.trg_units_no_truncate () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.units is immutable; TRUNCATE is not allowed'
    using errcode = '55000';
end;
$$;

create trigger trg_units_immutable
before update or delete on app.units for each row
execute function app.trg_units_immutable ();

create trigger trg_units_no_truncate
before truncate on app.units for each statement
execute function app.trg_units_no_truncate ();

insert into
  app.units (code, label_ar, dimension, metric_scale)
values
  ('kg', 'كيلو', 'mass', 1),
  ('g', 'جرام', 'mass', 0.001),
  ('liter', 'لتر', 'volume', 1),
  ('ml', 'ملل', 'volume', 0.001),
  ('piece', 'قطعة', 'count', null);

-- Existing rows use kg, piece, or liter. The check constraint stays.
alter table app.stock_items
add constraint stock_items_base_unit_fkey foreign key (base_unit) references app.units (code) on delete restrict;

-- ============================================================================
-- D. Dated versions. The row payload and interval never change. The only
-- permitted update is superseded_change_id from null to a change id.
-- valid_during is half-open: [effective_from, effective_to).
-- ============================================================================
create function app.trg_version_supersede_only () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% is immutable; DELETE is not allowed', pg_catalog.format('%I.%I', tg_table_schema, tg_table_name)
      using errcode = '55000';
  end if;

  -- valid_during is generated and still null in a BEFORE trigger, so it is
  -- not part of the payload comparison.
  if old.superseded_change_id is null
  and new.superseded_change_id is not null
  and (
    pg_catalog.to_jsonb(old) - 'superseded_change_id' - 'valid_during'
  ) = (
    pg_catalog.to_jsonb(new) - 'superseded_change_id' - 'valid_during'
  ) then
    return new;
  end if;

  raise exception '% is immutable; only superseded_change_id may be set once', pg_catalog.format('%I.%I', tg_table_schema, tg_table_name)
    using errcode = '55000';
end;
$$;

create function app.trg_version_no_truncate () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception '% is immutable; TRUNCATE is not allowed', pg_catalog.format('%I.%I', tg_table_schema, tg_table_name)
    using errcode = '55000';
end;
$$;

create table app.item_loss_versions (
  id uuid primary key default gen_random_uuid(),
  effective_from timestamptz not null,
  effective_to timestamptz null,
  valid_during tstzrange generated always as (tstzrange (effective_from, effective_to, '[)')) stored,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  superseded_change_id bigint null references app.costing_changes (id) on delete restrict,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  loss_pct numeric(6, 5) not null,
  constraint item_loss_versions_effective_from_finite_chk check (pg_catalog.isfinite (effective_from)),
  constraint item_loss_versions_effective_to_chk check (
    effective_to is null
    or (
      pg_catalog.isfinite (effective_to)
      and effective_to > effective_from
    )
  ),
  constraint item_loss_versions_loss_pct_chk check (
    loss_pct <> 'NaN'::numeric
    and loss_pct <> 'Infinity'::numeric
    and loss_pct <> '-Infinity'::numeric
    and loss_pct >= 0
    and loss_pct < 1
  ),
  constraint item_loss_versions_no_overlap exclude using gist (
    item_id extensions.gist_uuid_ops
    with
      =,
      valid_during
    with
      &&
  )
  where
    (superseded_change_id is null)
);

comment on table app.item_loss_versions is 'Dated loss fraction for one item. Non-superseded intervals do not overlap. A gap means no loss is configured (callers must not treat that as zero).';

create index item_loss_versions_item_from_idx on app.item_loss_versions (item_id, effective_from);

create index item_loss_versions_created_change_idx on app.item_loss_versions (created_change_id);

create index item_loss_versions_superseded_change_idx on app.item_loss_versions (superseded_change_id)
where
  superseded_change_id is not null;

create trigger trg_item_loss_versions_supersede_only
before update or delete on app.item_loss_versions for each row
execute function app.trg_version_supersede_only ();

create trigger trg_item_loss_versions_no_truncate
before truncate on app.item_loss_versions for each statement
execute function app.trg_version_no_truncate ();

create function app.trg_conversion_not_base_unit () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_base_unit text;
begin
  select
    si.base_unit
  into v_base_unit
  from
    app.stock_items si
  where
    si.id = new.item_id;

  if v_base_unit is not null
  and v_base_unit = new.unit_code then
    raise exception 'conversion unit must differ from the item base_unit'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create table app.item_conversion_versions (
  id uuid primary key default gen_random_uuid(),
  effective_from timestamptz not null,
  effective_to timestamptz null,
  valid_during tstzrange generated always as (tstzrange (effective_from, effective_to, '[)')) stored,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  superseded_change_id bigint null references app.costing_changes (id) on delete restrict,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  unit_code text not null references app.units (code) on delete restrict,
  factor_to_base numeric(18, 9) not null,
  constraint item_conversion_versions_effective_from_finite_chk check (pg_catalog.isfinite (effective_from)),
  constraint item_conversion_versions_effective_to_chk check (
    effective_to is null
    or (
      pg_catalog.isfinite (effective_to)
      and effective_to > effective_from
    )
  ),
  constraint item_conversion_versions_factor_chk check (
    factor_to_base <> 'NaN'::numeric
    and factor_to_base <> 'Infinity'::numeric
    and factor_to_base <> '-Infinity'::numeric
    and factor_to_base > 0
  ),
  constraint item_conversion_versions_no_overlap exclude using gist (
    item_id extensions.gist_uuid_ops
    with
      =,
      unit_code extensions.gist_text_ops
    with
      =,
      valid_during
    with
      &&
  )
  where
    (superseded_change_id is null)
);

comment on table app.item_conversion_versions is 'Dated explicit factor from unit_code to the item base unit. A gap means nothing is in force: item_factor_at then uses an implicit mass or volume factor, or raises.';

create index item_conversion_versions_item_unit_from_idx on app.item_conversion_versions (item_id, unit_code, effective_from);

create index item_conversion_versions_created_change_idx on app.item_conversion_versions (created_change_id);

create index item_conversion_versions_superseded_change_idx on app.item_conversion_versions (superseded_change_id)
where
  superseded_change_id is not null;

create trigger trg_item_conversion_versions_not_base
before insert on app.item_conversion_versions for each row
execute function app.trg_conversion_not_base_unit ();

create trigger trg_item_conversion_versions_supersede_only
before update or delete on app.item_conversion_versions for each row
execute function app.trg_version_supersede_only ();

create trigger trg_item_conversion_versions_no_truncate
before truncate on app.item_conversion_versions for each statement
execute function app.trg_version_no_truncate ();

-- ============================================================================
-- G. One current opening price per item. The writer posts no movement.
-- ============================================================================
create function app.trg_opening_price_base_unit () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_base_unit text;
begin
  select
    si.base_unit
  into v_base_unit
  from
    app.stock_items si
  where
    si.id = new.item_id;

  if v_base_unit is not null
  and v_base_unit is distinct from new.base_unit then
    raise exception 'opening price base_unit must match the item base_unit'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create table app.item_opening_prices (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references app.stock_items (id) on delete restrict,
  base_unit text not null references app.units (code) on delete restrict,
  unit_cost numeric(20, 6) not null,
  zero_cost_reason text null,
  approved_by uuid null references auth.users (id) on delete restrict,
  approved_at timestamptz not null default clock_timestamp(),
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  superseded_change_id bigint null references app.costing_changes (id) on delete restrict,
  constraint item_opening_prices_unit_cost_chk check (
    unit_cost <> 'NaN'::numeric
    and unit_cost <> 'Infinity'::numeric
    and unit_cost <> '-Infinity'::numeric
    and unit_cost >= 0
  ),
  constraint item_opening_prices_zero_reason_chk check (
    (
      unit_cost > 0
      and zero_cost_reason is null
    )
    or (
      unit_cost = 0
      and zero_cost_reason is not null
      and length(btrim(zero_cost_reason)) = length(zero_cost_reason)
      and length(zero_cost_reason) between 1 and 500
    )
  )
);

comment on table app.item_opening_prices is 'Owner-approved opening unit cost in the item base unit. At most one row per item has superseded_change_id null. Setting a price posts no stock movement.';

create unique index item_opening_prices_current_idx on app.item_opening_prices (item_id)
where
  superseded_change_id is null;

create index item_opening_prices_created_change_idx on app.item_opening_prices (created_change_id);

create index item_opening_prices_superseded_change_idx on app.item_opening_prices (superseded_change_id)
where
  superseded_change_id is not null;

create trigger trg_item_opening_prices_base_unit
before insert on app.item_opening_prices for each row
execute function app.trg_opening_price_base_unit ();

create trigger trg_item_opening_prices_supersede_only
before update or delete on app.item_opening_prices for each row
execute function app.trg_version_supersede_only ();

create trigger trg_item_opening_prices_no_truncate
before truncate on app.item_opening_prices for each statement
execute function app.trg_version_no_truncate ();

-- ============================================================================
-- E. Schedule token and the two interval writers.
-- The token line is id|UTC from|UTC to|payload. An empty schedule is md5('').
-- item_costing_schedule inlines the same line because it is security invoker
-- and cannot call this helper.
-- ============================================================================
create function app.costing_schedule_line (
  p_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_payload numeric
) returns text language sql immutable
set
  search_path = '' as $$
  select
    p_id::text || '|' || pg_catalog.to_char(
      p_effective_from at time zone 'UTC',
      'YYYY-MM-DD HH24:MI:SS.US'
    ) || '|' || coalesce(
      pg_catalog.to_char(
        p_effective_to at time zone 'UTC',
        'YYYY-MM-DD HH24:MI:SS.US'
      ),
      ''
    ) || '|' || pg_catalog.trim_scale(p_payload)::text;
$$;

create function app.schedule_token (p_family text, p_item_id uuid, p_unit_code text) returns text language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_token text;
begin
  if p_family not in ('loss', 'conversion') then
    raise exception 'unknown costing family %', p_family
      using errcode = '22023';
  end if;

  if p_family = 'conversion'
  and p_unit_code is null then
    raise exception 'conversion schedule requires a unit'
      using errcode = '22023';
  end if;

  select
    pg_catalog.md5(
      coalesce(
        string_agg(
          app.costing_schedule_line (s.id, s.effective_from, s.effective_to, s.payload),
          ','
          order by
            s.effective_from,
            s.id
        ),
        ''
      )
    )
  into v_token
  from
    (
      select
        v.id,
        v.effective_from,
        v.effective_to,
        v.loss_pct::numeric as payload
      from
        app.item_loss_versions v
      where
        p_family = 'loss'
        and v.item_id = p_item_id
        and v.superseded_change_id is null
      union all
      select
        v.id,
        v.effective_from,
        v.effective_to,
        v.factor_to_base::numeric as payload
      from
        app.item_conversion_versions v
      where
        p_family = 'conversion'
        and v.item_id = p_item_id
        and v.unit_code = p_unit_code
        and v.superseded_change_id is null
    ) s;

  return v_token;
end;
$$;

-- Returns the stored result when request_id was already applied with this
-- payload. Raises 22023 when the same request_id carries a different payload.
-- Returns null when the request_id is new. Callers run this after the ledger
-- advisory lock and before any token or state check.
create function app.costing_replay_result (p_request_id uuid, p_payload jsonb) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_payload jsonb;
  v_result jsonb;
begin
  select
    cc.payload,
    cc.result
  into v_payload,
    v_result
  from
    app.costing_changes cc
  where
    cc.request_id = p_request_id;

  if not found then
    return null;
  end if;

  if v_payload = p_payload then
    return v_result;
  end if;

  raise exception 'request_id already used for a different change'
    using errcode = '22023';
end;
$$;

-- Allocates the identity, stores the owner audit row, and returns the result
-- with change_id filled in. costing_changes is append-only, so the result has
-- to be complete on insert.
create function app.insert_owner_costing_change (
  p_request_id uuid,
  p_reason text,
  p_payload jsonb,
  p_result jsonb
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_id bigint;
  v_result jsonb;
begin
  v_id := pg_catalog.nextval(
    pg_catalog.pg_get_serial_sequence('app.costing_changes', 'id')::regclass
  );
  v_result := p_result || jsonb_build_object('change_id', v_id);

  insert into
    app.costing_changes (id, request_id, kind, actor_id, reason, payload, result)
  overriding system value
  values
    (
      v_id,
      p_request_id,
      'owner',
      auth.uid (),
      p_reason,
      p_payload,
      v_result
    );

  return v_result;
end;
$$;

create function app.set_item_loss (
  p_request_id uuid,
  p_item_id uuid,
  p_loss_pct numeric,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_reason text;
  v_loss numeric(6, 5);
  v_payload jsonb;
  v_replay jsonb;
  v_token text;
  v_new_token text;
  v_result jsonb;
  v_change_id bigint;
  v_superseded uuid[] := '{}'::uuid[];
  v_new_ids uuid[] := '{}'::uuid[];
  v_new_froms timestamptz[] := '{}'::timestamptz[];
  v_new_tos timestamptz[] := '{}'::timestamptz[];
  v_new_losses numeric[] := '{}'::numeric[];
  v_row record;
begin
  if coalesce(app.is_owner(), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Ledger lock before the item row lock. Same key as every posting path.
  perform app.assert_ledger_write_allowed();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  if p_item_id is null then
    raise exception 'item_id is required'
      using errcode = '22023';
  end if;

  if p_loss_pct is null
  or p_loss_pct in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_loss_pct < 0
  or p_loss_pct >= 1 then
    raise exception 'loss_pct must be finite and in [0, 1)'
      using errcode = '22023';
  end if;

  v_loss := pg_catalog.round(p_loss_pct, 5);

  if v_loss >= 1
  or v_loss < 0 then
    raise exception 'loss_pct must be finite and in [0, 1)'
      using errcode = '22023';
  end if;

  if p_effective_from is null
  or not pg_catalog.isfinite(p_effective_from) then
    raise exception 'effective_from must be a finite timestamp'
      using errcode = '22023';
  end if;

  if p_effective_to is not null
  and (
    not pg_catalog.isfinite(p_effective_to)
    or p_effective_to <= p_effective_from
  ) then
    raise exception 'effective_to must be a finite timestamp after effective_from'
      using errcode = '22023';
  end if;

  if p_reason is null
  or btrim(p_reason) = '' then
    v_reason := null;
  else
    v_reason := btrim(p_reason);
  end if;

  if v_reason is not null
  and length(v_reason) > 500 then
    raise exception 'reason must be at most 500 characters'
      using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'fn',
    'set_item_loss',
    'item_id',
    p_item_id,
    'loss_pct',
    v_loss,
    'effective_from',
    p_effective_from,
    'effective_to',
    p_effective_to,
    'expected_token',
    p_expected_token,
    'reason',
    v_reason
  );

  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  perform 1
  from
    app.stock_items si
  where
    si.id = p_item_id
  for update;

  if not found then
    raise exception 'unknown stock_item id: %', p_item_id
      using errcode = '22023';
  end if;

  v_token := app.schedule_token('loss', p_item_id, null);

  if v_token is distinct from p_expected_token then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  if p_effective_from < pg_catalog.now()
  and v_reason is null then
    raise exception 'reason is required for a backdated change'
      using errcode = '22023';
  end if;

  for v_row in
    select
      v.id,
      v.effective_from,
      v.effective_to,
      v.loss_pct
    from
      app.item_loss_versions v
    where
      v.item_id = p_item_id
      and v.superseded_change_id is null
      and v.valid_during && pg_catalog.tstzrange(p_effective_from, p_effective_to, '[)')
    order by
      v.effective_from,
      v.id
    for update
  loop
    v_superseded := pg_catalog.array_append(v_superseded, v_row.id);

    if v_row.effective_from < p_effective_from then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
      v_new_froms := pg_catalog.array_append(v_new_froms, v_row.effective_from);
      v_new_tos := pg_catalog.array_append(v_new_tos, p_effective_from);
      v_new_losses := pg_catalog.array_append(v_new_losses, v_row.loss_pct);
    end if;

    if p_effective_to is not null
    and (
      v_row.effective_to is null
      or v_row.effective_to > p_effective_to
    ) then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
      v_new_froms := pg_catalog.array_append(v_new_froms, p_effective_to);
      v_new_tos := pg_catalog.array_append(v_new_tos, v_row.effective_to);
      v_new_losses := pg_catalog.array_append(v_new_losses, v_row.loss_pct);
    end if;
  end loop;

  v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
  v_new_froms := pg_catalog.array_append(v_new_froms, p_effective_from);
  v_new_tos := pg_catalog.array_append(v_new_tos, p_effective_to);
  v_new_losses := pg_catalog.array_append(v_new_losses, v_loss);

  select
    pg_catalog.md5(
      coalesce(
        string_agg(
          app.costing_schedule_line (s.id, s.effective_from, s.effective_to, s.payload),
          ','
          order by
            s.effective_from,
            s.id
        ),
        ''
      )
    )
  into v_new_token
  from
    (
      select
        v.id,
        v.effective_from,
        v.effective_to,
        v.loss_pct::numeric as payload
      from
        app.item_loss_versions v
      where
        v.item_id = p_item_id
        and v.superseded_change_id is null
        and not (v.id = any (v_superseded))
      union all
      select
        v_new_ids[g.i],
        v_new_froms[g.i],
        v_new_tos[g.i],
        v_new_losses[g.i]
      from
        pg_catalog.generate_series(1, pg_catalog.cardinality(v_new_ids)) as g (i)
    ) s;

  v_result := app.insert_owner_costing_change(
    p_request_id,
    v_reason,
    v_payload,
    jsonb_build_object(
      'superseded',
      pg_catalog.to_jsonb(v_superseded),
      'inserted',
      pg_catalog.to_jsonb(v_new_ids),
      'token',
      v_new_token
    )
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  if pg_catalog.cardinality(v_superseded) > 0 then
    update app.item_loss_versions
    set
      superseded_change_id = v_change_id
    where
      id = any (v_superseded);
  end if;

  if coalesce(pg_catalog.cardinality(v_new_ids), 0) > 0 then
    for v_i in 1..pg_catalog.cardinality(v_new_ids) loop
      insert into
        app.item_loss_versions (id, effective_from, effective_to, created_change_id, item_id, loss_pct)
      values
        (
          v_new_ids[v_i],
          v_new_froms[v_i],
          v_new_tos[v_i],
          v_change_id,
          p_item_id,
          v_new_losses[v_i]
        );
    end loop;
  end if;

  if app.schedule_token('loss', p_item_id, null) is distinct from v_new_token then
    raise exception 'internal costing token mismatch'
      using errcode = '55000';
  end if;

  return v_result;
end;
$$;

comment on function app.set_item_loss (
  uuid,
  uuid,
  numeric,
  timestamptz,
  timestamptz,
  text,
  text
) is 'Replaces the loss schedule on [effective_from, effective_to). Takes advisory lock 7342750000000000001 before locking the item. Owner only. A past effective_from requires a reason. The same request_id and payload return the stored result.';

create function app.set_item_conversion (
  p_request_id uuid,
  p_item_id uuid,
  p_unit_code text,
  p_factor numeric,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_reason text;
  v_unit text;
  v_factor numeric(18, 9);
  v_base_unit text;
  v_name text;
  v_payload jsonb;
  v_replay jsonb;
  v_token text;
  v_new_token text;
  v_result jsonb;
  v_change_id bigint;
  v_superseded uuid[] := '{}'::uuid[];
  v_new_ids uuid[] := '{}'::uuid[];
  v_new_froms timestamptz[] := '{}'::timestamptz[];
  v_new_tos timestamptz[] := '{}'::timestamptz[];
  v_new_factors numeric[] := '{}'::numeric[];
  v_row record;
begin
  if coalesce(app.is_owner(), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  perform app.assert_ledger_write_allowed();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  if p_item_id is null then
    raise exception 'item_id is required'
      using errcode = '22023';
  end if;

  v_unit := btrim(p_unit_code);

  if v_unit is null
  or v_unit = ''
  or length(v_unit) > 20 then
    raise exception 'unit_code is required'
      using errcode = '22023';
  end if;

  v_factor := null;

  if p_factor is not null then
    if p_factor in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or p_factor <= 0 then
      raise exception 'factor must be finite and greater than 0'
        using errcode = '22023';
    end if;

    v_factor := pg_catalog.round(p_factor, 9);

    if v_factor <= 0 then
      raise exception 'factor must be finite and greater than 0'
        using errcode = '22023';
    end if;
  end if;

  if p_effective_from is null
  or not pg_catalog.isfinite(p_effective_from) then
    raise exception 'effective_from must be a finite timestamp'
      using errcode = '22023';
  end if;

  if p_effective_to is not null
  and (
    not pg_catalog.isfinite(p_effective_to)
    or p_effective_to <= p_effective_from
  ) then
    raise exception 'effective_to must be a finite timestamp after effective_from'
      using errcode = '22023';
  end if;

  if p_reason is null
  or btrim(p_reason) = '' then
    v_reason := null;
  else
    v_reason := btrim(p_reason);
  end if;

  if v_reason is not null
  and length(v_reason) > 500 then
    raise exception 'reason must be at most 500 characters'
      using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'fn',
    'set_item_conversion',
    'item_id',
    p_item_id,
    'unit_code',
    v_unit,
    'factor',
    v_factor,
    'effective_from',
    p_effective_from,
    'effective_to',
    p_effective_to,
    'expected_token',
    p_expected_token,
    'reason',
    v_reason
  );

  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  select
    si.base_unit,
    si.name
  into v_base_unit,
    v_name
  from
    app.stock_items si
  where
    si.id = p_item_id
  for update;

  if not found then
    raise exception 'unknown stock_item id: %', p_item_id
      using errcode = '22023';
  end if;

  if v_unit = v_base_unit then
    raise exception 'conversion unit must differ from the item base_unit'
      using errcode = '22023';
  end if;

  if not exists (
    select
      1
    from
      app.units u
    where
      u.code = v_unit
  ) then
    raise exception 'unknown unit "%" for item %', v_unit, v_name
      using errcode = '22023';
  end if;

  v_token := app.schedule_token('conversion', p_item_id, v_unit);

  if v_token is distinct from p_expected_token then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  if p_effective_from < pg_catalog.now()
  and v_reason is null then
    raise exception 'reason is required for a backdated change'
      using errcode = '22023';
  end if;

  for v_row in
    select
      v.id,
      v.effective_from,
      v.effective_to,
      v.factor_to_base
    from
      app.item_conversion_versions v
    where
      v.item_id = p_item_id
      and v.unit_code = v_unit
      and v.superseded_change_id is null
      and v.valid_during && pg_catalog.tstzrange(p_effective_from, p_effective_to, '[)')
    order by
      v.effective_from,
      v.id
    for update
  loop
    v_superseded := pg_catalog.array_append(v_superseded, v_row.id);

    if v_row.effective_from < p_effective_from then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
      v_new_froms := pg_catalog.array_append(v_new_froms, v_row.effective_from);
      v_new_tos := pg_catalog.array_append(v_new_tos, p_effective_from);
      v_new_factors := pg_catalog.array_append(v_new_factors, v_row.factor_to_base);
    end if;

    if p_effective_to is not null
    and (
      v_row.effective_to is null
      or v_row.effective_to > p_effective_to
    ) then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
      v_new_froms := pg_catalog.array_append(v_new_froms, p_effective_to);
      v_new_tos := pg_catalog.array_append(v_new_tos, v_row.effective_to);
      v_new_factors := pg_catalog.array_append(v_new_factors, v_row.factor_to_base);
    end if;
  end loop;

  -- A null factor removes coverage for the interval. Fragments outside it stay.
  if v_factor is not null then
    v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
    v_new_froms := pg_catalog.array_append(v_new_froms, p_effective_from);
    v_new_tos := pg_catalog.array_append(v_new_tos, p_effective_to);
    v_new_factors := pg_catalog.array_append(v_new_factors, v_factor);
  end if;

  select
    pg_catalog.md5(
      coalesce(
        string_agg(
          app.costing_schedule_line (s.id, s.effective_from, s.effective_to, s.payload),
          ','
          order by
            s.effective_from,
            s.id
        ),
        ''
      )
    )
  into v_new_token
  from
    (
      select
        v.id,
        v.effective_from,
        v.effective_to,
        v.factor_to_base::numeric as payload
      from
        app.item_conversion_versions v
      where
        v.item_id = p_item_id
        and v.unit_code = v_unit
        and v.superseded_change_id is null
        and not (v.id = any (v_superseded))
      union all
      select
        v_new_ids[g.i],
        v_new_froms[g.i],
        v_new_tos[g.i],
        v_new_factors[g.i]
      from
        pg_catalog.generate_series(1, pg_catalog.cardinality(v_new_ids)) as g (i)
    ) s;

  v_result := app.insert_owner_costing_change(
    p_request_id,
    v_reason,
    v_payload,
    jsonb_build_object(
      'superseded',
      pg_catalog.to_jsonb(v_superseded),
      'inserted',
      pg_catalog.to_jsonb(v_new_ids),
      'token',
      v_new_token
    )
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  if pg_catalog.cardinality(v_superseded) > 0 then
    update app.item_conversion_versions
    set
      superseded_change_id = v_change_id
    where
      id = any (v_superseded);
  end if;

  if coalesce(pg_catalog.cardinality(v_new_ids), 0) > 0 then
    for v_i in 1..pg_catalog.cardinality(v_new_ids) loop
      insert into
        app.item_conversion_versions (
          id,
          effective_from,
          effective_to,
          created_change_id,
          item_id,
          unit_code,
          factor_to_base
        )
      values
        (
          v_new_ids[v_i],
          v_new_froms[v_i],
          v_new_tos[v_i],
          v_change_id,
          p_item_id,
          v_unit,
          v_new_factors[v_i]
        );
    end loop;
  end if;

  if app.schedule_token('conversion', p_item_id, v_unit) is distinct from v_new_token then
    raise exception 'internal costing token mismatch'
      using errcode = '55000';
  end if;

  return v_result;
end;
$$;

comment on function app.set_item_conversion (
  uuid,
  uuid,
  text,
  numeric,
  timestamptz,
  timestamptz,
  text,
  text
) is 'Replaces one unit conversion on [effective_from, effective_to). A null factor leaves a gap. Takes advisory lock 7342750000000000001 before locking the item. Owner only.';

-- Security invoker: the owner reads through RLS. The token line matches
-- app.costing_schedule_line (trim_scale payload, UTC timestamps).
create function app.item_costing_schedule (p_item_id uuid) returns jsonb language plpgsql stable security invoker
set
  search_path = '' as $$
declare
  v_loss_token text;
  v_loss_versions jsonb;
  v_conversions jsonb;
begin
  if coalesce(app.is_owner(), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_item_id is null then
    raise exception 'item_id is required'
      using errcode = '22023';
  end if;

  select
    pg_catalog.md5(
      coalesce(
        string_agg(
          v.id::text || '|' || pg_catalog.to_char(v.effective_from at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '|' || coalesce(
            pg_catalog.to_char(v.effective_to at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'),
            ''
          ) || '|' || pg_catalog.trim_scale(v.loss_pct)::text,
          ','
          order by
            v.effective_from,
            v.id
        ),
        ''
      )
    )
  into v_loss_token
  from
    app.item_loss_versions v
  where
    v.item_id = p_item_id
    and v.superseded_change_id is null;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',
          v.id,
          'effective_from',
          v.effective_from,
          'effective_to',
          v.effective_to,
          'loss_pct',
          v.loss_pct
        )
        order by
          v.effective_from,
          v.id
      ),
      '[]'::jsonb
    )
  into v_loss_versions
  from
    app.item_loss_versions v
  where
    v.item_id = p_item_id
    and v.superseded_change_id is null;

  select
    coalesce(
      jsonb_agg(
        s.entry
        order by
          s.unit_code
      ),
      '[]'::jsonb
    )
  into v_conversions
  from
    (
      select
        v.unit_code,
        jsonb_build_object(
          'unit_code',
          v.unit_code,
          'token',
          pg_catalog.md5(
            coalesce(
              string_agg(
                v.id::text || '|' || pg_catalog.to_char(v.effective_from at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '|' || coalesce(
                  pg_catalog.to_char(v.effective_to at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'),
                  ''
                ) || '|' || pg_catalog.trim_scale(v.factor_to_base)::text,
                ','
                order by
                  v.effective_from,
                  v.id
              ),
              ''
            )
          ),
          'versions',
          jsonb_agg(
            jsonb_build_object(
              'id',
              v.id,
              'effective_from',
              v.effective_from,
              'effective_to',
              v.effective_to,
              'factor_to_base',
              v.factor_to_base
            )
            order by
              v.effective_from,
              v.id
          )
        ) as entry
      from
        app.item_conversion_versions v
      where
        v.item_id = p_item_id
        and v.superseded_change_id is null
      group by
        v.unit_code
    ) s;

  return jsonb_build_object(
    'loss',
    jsonb_build_object('token', v_loss_token, 'versions', v_loss_versions),
    'conversions',
    v_conversions
  );
end;
$$;

comment on function app.item_costing_schedule (uuid) is 'Owner read of the current loss and conversion schedules for one item, including each concurrency token. Empty schedules use md5 of the empty string.';

-- ============================================================================
-- F. Lookups. They do not check the owner: they return one number or raise.
-- ============================================================================
create function app.item_loss_at (p_item_id uuid, p_at timestamptz) returns numeric(6, 5) language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_loss numeric(6, 5);
begin
  if p_at is null
  or not pg_catalog.isfinite(p_at) then
    raise exception 'p_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  select
    v.loss_pct
  into v_loss
  from
    app.item_loss_versions v
  where
    v.item_id = p_item_id
    and v.superseded_change_id is null
    and v.valid_during @> p_at;

  return v_loss;
end;
$$;

comment on function app.item_loss_at (uuid, timestamptz) is 'Loss fraction in force at p_at, or null when none is configured. Does not default to zero.';

create function app.item_factor_at (
  p_item_id uuid,
  p_unit_code text,
  p_at timestamptz
) returns numeric language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_base text;
  v_name text;
  v_unit text;
  v_factor numeric;
  v_from_dimension text;
  v_from_scale numeric;
  v_to_dimension text;
  v_to_scale numeric;
begin
  if p_at is null
  or not pg_catalog.isfinite(p_at) then
    raise exception 'p_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  select
    si.base_unit,
    si.name
  into v_base,
    v_name
  from
    app.stock_items si
  where
    si.id = p_item_id;

  if not found then
    raise exception 'unknown stock_item id: %', p_item_id
      using errcode = '22023';
  end if;

  v_unit := p_unit_code;

  if v_unit is null then
    v_unit := '';
  end if;

  if v_unit = v_base then
    return 1;
  end if;

  select
    v.factor_to_base
  into v_factor
  from
    app.item_conversion_versions v
  where
    v.item_id = p_item_id
    and v.unit_code = v_unit
    and v.superseded_change_id is null
    and v.valid_during @> p_at;

  if found then
    return v_factor;
  end if;

  select
    u.dimension,
    u.metric_scale
  into v_from_dimension,
    v_from_scale
  from
    app.units u
  where
    u.code = v_unit;

  select
    u.dimension,
    u.metric_scale
  into v_to_dimension,
    v_to_scale
  from
    app.units u
  where
    u.code = v_base;

  if v_from_dimension in ('mass', 'volume')
  and v_from_dimension = v_to_dimension
  and v_from_scale is not null
  and v_to_scale is not null then
    return v_from_scale / v_to_scale;
  end if;

  raise exception 'unknown unit "%" for item %', v_unit, v_name
    using errcode = '22023';
end;
$$;

comment on function app.item_factor_at (uuid, text, timestamptz) is 'Factor from p_unit_code to the item base unit at p_at. Base unit is 1. An explicit version wins over an implicit mass or volume factor.';

create function app.set_item_opening_price (
  p_request_id uuid,
  p_item_id uuid,
  p_unit_cost numeric,
  p_zero_cost_reason text,
  p_expected_current_id uuid
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_cost numeric(20, 6);
  v_reason text;
  v_base text;
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
    p_expected_current_id
  );

  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  select
    si.base_unit
  into v_base
  from
    app.stock_items si
  where
    si.id = p_item_id
  for update;

  if not found then
    raise exception 'unknown stock_item id: %', p_item_id
      using errcode = '22023';
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

comment on function app.set_item_opening_price (uuid, uuid, numeric, text, uuid) is 'Sets the current opening unit cost. Takes advisory lock 7342750000000000001, then locks the item. Posts no movement. p_expected_current_id is the current row id, or null when the item has none.';

-- ============================================================================
-- H. Freeze base_unit, kind, and parent_item_id once the item is configured
-- or has movements. The statement trigger takes the ledger lock before any
-- row lock. The existing base_unit triggers are unchanged: a base_unit change
-- on an item that already has movements still raises their message first.
-- Later PRs add recipe, mapping, and packaging references to this check.
-- ============================================================================
create function app.trg_stock_items_freeze_configured_identity () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_locked boolean;
begin
  if new.base_unit is not distinct from old.base_unit
  and new.kind is not distinct from old.kind
  and new.parent_item_id is not distinct from old.parent_item_id then
    return new;
  end if;

  v_locked := exists (
    select
      1
    from
      app.stock_movements sm
    where
      sm.item_id = old.id
  )
  or exists (
    select
      1
    from
      app.item_loss_versions v
    where
      v.item_id = old.id
      and v.superseded_change_id is null
  )
  or exists (
    select
      1
    from
      app.item_conversion_versions v
    where
      v.item_id = old.id
      and v.superseded_change_id is null
  )
  or exists (
    select
      1
    from
      app.item_opening_prices p
    where
      p.item_id = old.id
      and p.superseded_change_id is null
  );

  if not v_locked then
    return new;
  end if;

  if new.base_unit is distinct from old.base_unit then
    raise exception 'cannot change base_unit of an item that is configured or has movements'
      using errcode = '23514';
  end if;

  if new.kind is distinct from old.kind then
    raise exception 'cannot change kind of an item that is configured or has movements'
      using errcode = '23514';
  end if;

  raise exception 'cannot change parent_item_id of an item that is configured or has movements'
    using errcode = '23514';
end;
$$;

create trigger trg_stock_items_configured_identity_lock
before update of base_unit,
kind,
parent_item_id on app.stock_items for each statement
execute function app.trg_stock_items_base_unit_lock ();

create trigger trg_stock_items_freeze_configured_identity
before update of base_unit,
kind,
parent_item_id on app.stock_items for each row
execute function app.trg_stock_items_freeze_configured_identity ();

-- ============================================================================
-- I. RLS, grants. Writers are owner-only. Lookups are executable by
-- authenticated and service_role. service_role cannot approve configuration.
-- ============================================================================
alter table app.costing_changes enable row level security;

alter table app.units enable row level security;

alter table app.item_loss_versions enable row level security;

alter table app.item_conversion_versions enable row level security;

alter table app.item_opening_prices enable row level security;

create policy costing_changes_select_owner on app.costing_changes for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy units_select_owner on app.units for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy item_loss_versions_select_owner on app.item_loss_versions for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy item_conversion_versions_select_owner on app.item_conversion_versions for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy item_opening_prices_select_owner on app.item_opening_prices for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.costing_changes
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.units
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.item_loss_versions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.item_conversion_versions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.item_opening_prices
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.costing_changes,
  app.units,
  app.item_loss_versions,
  app.item_conversion_versions,
  app.item_opening_prices to authenticated,
  service_role;

revoke all on sequence app.costing_changes_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.set_item_loss (
  uuid,
  uuid,
  numeric,
  timestamptz,
  timestamptz,
  text,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.set_item_conversion (
  uuid,
  uuid,
  text,
  numeric,
  timestamptz,
  timestamptz,
  text,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.set_item_opening_price (uuid, uuid, numeric, text, uuid)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.set_item_loss (
  uuid,
  uuid,
  numeric,
  timestamptz,
  timestamptz,
  text,
  text
),
app.set_item_conversion (
  uuid,
  uuid,
  text,
  numeric,
  timestamptz,
  timestamptz,
  text,
  text
),
app.set_item_opening_price (uuid, uuid, numeric, text, uuid) to authenticated;

revoke all on function app.item_loss_at (uuid, timestamptz)
from
  public,
  anon;

revoke all on function app.item_factor_at (uuid, text, timestamptz)
from
  public,
  anon;

grant
execute on function app.item_loss_at (uuid, timestamptz),
app.item_factor_at (uuid, text, timestamptz) to authenticated,
service_role;

revoke all on function app.item_costing_schedule (uuid)
from
  public,
  anon,
  service_role;

grant
execute on function app.item_costing_schedule (uuid) to authenticated;

revoke all on function app.schedule_token (text, uuid, text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.costing_schedule_line (uuid, timestamptz, timestamptz, numeric)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.costing_replay_result (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.insert_owner_costing_change (uuid, text, jsonb, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_units_immutable ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_units_no_truncate ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_version_supersede_only ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_version_no_truncate ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_conversion_not_base_unit ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_opening_price_base_unit ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_stock_items_freeze_configured_identity ()
from
  public,
  anon,
  authenticated,
  service_role;
