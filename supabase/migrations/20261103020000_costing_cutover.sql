-- Costing cutover (phase 4, PR 2).
--
-- Dated loss and conversions become the only readers and writers. Legacy
-- loss_pct and item_unit_conversions stay readable and frozen. One legacy
-- costing change records the snapshot taken at this migration's now().
-- A movement before that instant, in a unit other than the base unit, needs
-- an owner-approved interval that covers it. There is no GUC bypass.
-- ============================================================================
-- A. Freeze the legacy columns. Insert of the default loss 0 still succeeds
-- so new rows can be created; any other loss_pct write is rejected.
-- ============================================================================
create function app.trg_stock_items_loss_pct_frozen () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.loss_pct is distinct from 0 then
      raise exception 'stock_items.loss_pct is frozen; use app.set_item_loss'
        using errcode = '55000';
    end if;

    return new;
  end if;

  raise exception 'stock_items.loss_pct is frozen; use app.set_item_loss'
    using errcode = '55000';
end;
$$;

create trigger trg_stock_items_loss_pct_frozen
before insert or update of loss_pct on app.stock_items for each row
execute function app.trg_stock_items_loss_pct_frozen ();

comment on function app.trg_stock_items_loss_pct_frozen () is 'Rejects every loss_pct change and every insert that does not keep the default 0. No bypass.';

create function app.trg_item_unit_conversions_frozen () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'item_unit_conversions is frozen; use app.set_item_conversion'
    using errcode = '55000';
end;
$$;

create trigger trg_item_unit_conversions_frozen
before insert or update or delete or truncate on app.item_unit_conversions for each statement
execute function app.trg_item_unit_conversions_frozen ();

comment on function app.trg_item_unit_conversions_frozen () is 'Rejects every insert, update, delete, and truncate of item_unit_conversions. No bypass.';

comment on column app.stock_items.loss_pct is 'Frozen legacy loss fraction. Dated loss lives in app.item_loss_versions. New rows keep the default 0 and do not write this column.';

revoke insert on table app.stock_items
from
  authenticated;

revoke
update (loss_pct) on table app.stock_items
from
  authenticated;

revoke insert,
update,
delete on table app.item_unit_conversions
from
  authenticated,
  service_role;

-- ============================================================================
-- B. Unit aliases share a namespace with unit codes. Rows are immutable.
-- ============================================================================
create table app.unit_aliases (
  alias text primary key,
  unit_code text not null,
  created_change_id bigint not null,
  constraint unit_aliases_alias_chk check (
    alias = btrim(alias)
    and length(alias) between 1 and 40
  ),
  constraint unit_aliases_unit_code_fkey foreign key (unit_code) references app.units (code) on delete restrict,
  constraint unit_aliases_created_change_id_fkey foreign key (created_change_id) references app.costing_changes (id) on delete restrict
  deferrable initially immediate
);

comment on table app.unit_aliases is 'Immutable map from a legacy name or an Arabic label to a unit code. Codes win over aliases. Labels are not consulted at read time.';

create index unit_aliases_unit_code_idx on app.unit_aliases (unit_code);

create index unit_aliases_created_change_id_idx on app.unit_aliases (created_change_id);

create function app.trg_unit_aliases_immutable () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.unit_aliases is immutable'
    using errcode = '55000';
end;
$$;

create trigger trg_unit_aliases_immutable
before update or delete or truncate on app.unit_aliases for each statement
execute function app.trg_unit_aliases_immutable ();

-- A code and an alias never share text, in either direction.
create function app.trg_units_code_namespace () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if exists (
    select
      1
    from
      app.unit_aliases a
    where
      a.alias = new.code
  ) then
    raise exception 'unit already exists'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger trg_units_code_namespace
before insert or update of code on app.units for each row
execute function app.trg_units_code_namespace ();

create function app.trg_unit_alias_namespace () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if exists (
    select
      1
    from
      app.units u
    where
      u.code = new.alias
  ) then
    raise exception 'unit alias equals a unit code'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger trg_unit_aliases_namespace
before insert on app.unit_aliases for each row
execute function app.trg_unit_alias_namespace ();

-- The backfill inserts versions before the legacy change row that they cite.
do $defer_fks$
declare
  v_name text;
begin
  select
    con.conname into v_name
  from
    pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid
    and att.attnum = any (con.conkey)
  where
    con.conrelid = 'app.item_loss_versions'::regclass
    and con.contype = 'f'
    and att.attname = 'created_change_id';

  if v_name is null then
    raise exception 'item_loss_versions.created_change_id foreign key was not found'
      using errcode = '55000';
  end if;

  if v_name is distinct from 'item_loss_versions_created_change_id_fkey' then
    execute format(
      'alter table app.item_loss_versions rename constraint %I to item_loss_versions_created_change_id_fkey',
      v_name
    );
  end if;

  execute 'alter table app.item_loss_versions alter constraint item_loss_versions_created_change_id_fkey deferrable initially immediate';

  select
    con.conname into v_name
  from
    pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid
    and att.attnum = any (con.conkey)
  where
    con.conrelid = 'app.item_conversion_versions'::regclass
    and con.contype = 'f'
    and att.attname = 'created_change_id';

  if v_name is null then
    raise exception 'item_conversion_versions.created_change_id foreign key was not found'
      using errcode = '55000';
  end if;

  if v_name is distinct from 'item_conversion_versions_created_change_id_fkey' then
    execute format(
      'alter table app.item_conversion_versions rename constraint %I to item_conversion_versions_created_change_id_fkey',
      v_name
    );
  end if;

  execute 'alter table app.item_conversion_versions alter constraint item_conversion_versions_created_change_id_fkey deferrable initially immediate';
end;
$defer_fks$;

-- Exact code first, then an alias. Never the mutable label.
create function app.resolve_unit_code (p_unit text) returns text language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      (
        select
          u.code
        from
          app.units u
        where
          u.code = btrim(p_unit)
      ),
      (
        select
          a.unit_code
        from
          app.unit_aliases a
        where
          a.alias = btrim(p_unit)
      )
    );
$$;

comment on function app.resolve_unit_code (text) is 'Maps posted unit text to a unit code. An exact code wins. Otherwise one alias. A label that is not an alias does not match.';

-- ============================================================================
-- C. Null effective_from means the current minute, date_trunc('minute', now()),
-- and is stored in the replay payload as the text now. The current minute
-- matches the minute-precision purchase and opening forms, and it is not
-- backdating, so it needs no reason.
-- ============================================================================
create or replace function app.set_item_loss (
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
  v_from_is_now boolean;
  v_effective_from timestamptz;
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

  if p_effective_from is null then
    v_from_is_now := true;
  elsif not pg_catalog.isfinite(p_effective_from) then
    raise exception 'effective_from must be a finite timestamp'
      using errcode = '22023';
  else
    v_from_is_now := false;
  end if;

  if p_effective_to is not null
  and not pg_catalog.isfinite(p_effective_to) then
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
    case
      when v_from_is_now then 'now'
      else app.costing_timestamptz_text (p_effective_from)
    end,
    'effective_to',
    app.costing_timestamptz_text (p_effective_to),
    'expected_token',
    p_expected_token,
    'reason',
    v_reason
  );

  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  -- Null means the current minute, and only after replay so a retry
  -- still matches the stored payload text "now".
  if v_from_is_now then
    v_effective_from := pg_catalog.date_trunc('minute', pg_catalog.now());
  else
    v_effective_from := p_effective_from;
  end if;

  if p_effective_to is not null
  and p_effective_to <= v_effective_from then
    raise exception 'effective_to must be a finite timestamp after effective_from'
      using errcode = '22023';
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

  -- The current minute is not backdating.
  if not v_from_is_now
  and v_effective_from < pg_catalog.now()
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
      and v.valid_during && pg_catalog.tstzrange(v_effective_from, p_effective_to, '[)')
    order by
      v.effective_from,
      v.id
    for update
  loop
    v_superseded := pg_catalog.array_append(v_superseded, v_row.id);

    if v_row.effective_from < v_effective_from then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
      v_new_froms := pg_catalog.array_append(v_new_froms, v_row.effective_from);
      v_new_tos := pg_catalog.array_append(v_new_tos, v_effective_from);
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
  v_new_froms := pg_catalog.array_append(v_new_froms, v_effective_from);
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
) is 'Replaces the loss schedule on [effective_from, effective_to). Null effective_from means the current minute, date_trunc(''minute'', now()), and is stored as the text now. The current minute needs no reason. An earlier instant requires a reason. Owner only.';

create or replace function app.set_item_conversion (
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
  v_from_is_now boolean;
  v_effective_from timestamptz;
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

  if p_effective_from is null then
    v_from_is_now := true;
  elsif not pg_catalog.isfinite(p_effective_from) then
    raise exception 'effective_from must be a finite timestamp'
      using errcode = '22023';
  else
    v_from_is_now := false;
  end if;

  if p_effective_to is not null
  and not pg_catalog.isfinite(p_effective_to) then
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
    case
      when v_from_is_now then 'now'
      else app.costing_timestamptz_text (p_effective_from)
    end,
    'effective_to',
    app.costing_timestamptz_text (p_effective_to),
    'expected_token',
    p_expected_token,
    'reason',
    v_reason
  );

  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  -- Null means the current minute, and only after replay so a retry
  -- still matches the stored payload text "now".
  if v_from_is_now then
    v_effective_from := pg_catalog.date_trunc('minute', pg_catalog.now());
  else
    v_effective_from := p_effective_from;
  end if;

  if p_effective_to is not null
  and p_effective_to <= v_effective_from then
    raise exception 'effective_to must be a finite timestamp after effective_from'
      using errcode = '22023';
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
    -- Owners keep the item name. Anyone else gets the id they already passed.
    if coalesce(app.is_owner(), false) then
      raise exception 'unknown unit "%" for item %', v_unit, v_name
        using errcode = '22023';
    end if;

    raise exception 'unknown unit "%" for item %', v_unit, p_item_id
      using errcode = '22023';
  end if;

  v_token := app.schedule_token('conversion', p_item_id, v_unit);

  if v_token is distinct from p_expected_token then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  -- The current minute is not backdating.
  if not v_from_is_now
  and v_effective_from < pg_catalog.now()
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
      and v.valid_during && pg_catalog.tstzrange(v_effective_from, p_effective_to, '[)')
    order by
      v.effective_from,
      v.id
    for update
  loop
    v_superseded := pg_catalog.array_append(v_superseded, v_row.id);

    if v_row.effective_from < v_effective_from then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
      v_new_froms := pg_catalog.array_append(v_new_froms, v_row.effective_from);
      v_new_tos := pg_catalog.array_append(v_new_tos, v_effective_from);
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
    v_new_froms := pg_catalog.array_append(v_new_froms, v_effective_from);
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
) is 'Replaces one unit conversion on [effective_from, effective_to). Null effective_from means the current minute, date_trunc(''minute'', now()), and is stored as the text now. The current minute needs no reason. A null factor leaves a gap. An earlier instant requires a reason. Owner only.';

-- ============================================================================
-- D. Custom units and atomic item creation.
-- ============================================================================
create function app.add_custom_unit (p_request_id uuid, p_code text, p_label_ar text) returns text language plpgsql security definer
set
  search_path = '' as $$
declare
  v_code text;
  v_label text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_change_id bigint;
  v_alias text;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  perform app.assert_ledger_write_allowed ();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  v_code := btrim(p_code);
  v_label := btrim(p_label_ar);

  if v_code is null
  or length(v_code) < 1
  or length(v_code) > 20 then
    raise exception 'unit code must be 1 to 20 characters'
      using errcode = '22023';
  end if;

  if v_label is null
  or length(v_label) < 1
  or length(v_label) > 40 then
    raise exception 'unit label must be 1 to 40 characters'
      using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'fn',
    'add_custom_unit',
    'code',
    v_code,
    'label_ar',
    v_label
  );
  v_replay := app.costing_replay_result (p_request_id, v_payload);

  if v_replay is not null then
    return v_replay ->> 'code';
  end if;

  if exists (
    select
      1
    from
      app.units u
    where
      u.code = v_code
  )
  or exists (
    select
      1
    from
      app.unit_aliases a
    where
      a.alias = v_code
  ) then
    raise exception 'unit already exists'
      using errcode = '22023';
  end if;

  -- A label that is already a code or an alias is not registered. The unit
  -- is still created. The stored result reports the skip with alias null.
  if v_label = v_code
  or exists (
    select
      1
    from
      app.units u
    where
      u.code = v_label
  )
  or exists (
    select
      1
    from
      app.unit_aliases a
    where
      a.alias = v_label
  ) then
    v_alias := null;
  else
    v_alias := v_label;
  end if;

  v_result := app.insert_owner_costing_change (
    p_request_id,
    null,
    v_payload,
    jsonb_build_object('code', v_code, 'alias', v_alias)
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  insert into
    app.units (code, label_ar, dimension, metric_scale)
  values
    (v_code, v_label, 'custom', null);

  if v_alias is not null then
    insert into
      app.unit_aliases (alias, unit_code, created_change_id)
    values
      (v_alias, v_code, v_change_id);
  end if;

  return v_code;
end;
$$;

comment on function app.add_custom_unit (uuid, text, text) is 'Adds one custom unit. The code must not already be a code or an alias. A label that equals a code or an alias is skipped and reported as a null alias in the stored result. Owner only. The same request_id returns the stored code.';

create function app.create_stock_item (
  p_request_id uuid,
  p_name text,
  p_kind text,
  p_base_unit text,
  p_count_frequency text,
  p_parent_item_id uuid,
  p_loss_pct numeric,
  p_active boolean
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_name text;
  v_loss numeric(6, 5);
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_item_id uuid;
  v_change_id bigint;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  perform app.assert_ledger_write_allowed ();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  if p_active is null then
    raise exception 'active is required'
      using errcode = '22023';
  end if;

  v_name := btrim(p_name);

  if p_loss_pct is null then
    v_loss := null;
  else
    if p_loss_pct in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
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
  end if;

  v_payload := jsonb_build_object(
    'fn',
    'create_stock_item',
    'name',
    v_name,
    'kind',
    p_kind,
    'base_unit',
    p_base_unit,
    'count_frequency',
    p_count_frequency,
    'parent_item_id',
    p_parent_item_id,
    'loss_pct',
    v_loss,
    'active',
    p_active
  );
  v_replay := app.costing_replay_result (p_request_id, v_payload);

  if v_replay is not null then
    return (v_replay ->> 'item_id')::uuid;
  end if;

  v_item_id := pg_catalog.gen_random_uuid();
  v_result := app.insert_owner_costing_change (
    p_request_id,
    null,
    v_payload,
    jsonb_build_object('item_id', v_item_id)
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  -- Table checks and the parent trigger raise 23514 / 23505. loss_pct stays 0.
  insert into
    app.stock_items (
      id,
      name,
      kind,
      base_unit,
      count_frequency,
      parent_item_id,
      active
    )
  values
    (
      v_item_id,
      v_name,
      p_kind,
      p_base_unit,
      p_count_frequency,
      p_parent_item_id,
      p_active
    );

  if v_loss is not null then
    insert into
      app.item_loss_versions (effective_from, effective_to, created_change_id, item_id, loss_pct)
    values
      (
        pg_catalog.date_trunc('minute', pg_catalog.now()),
        null,
        v_change_id,
        v_item_id,
        v_loss
      );
  end if;

  return v_item_id;
end;
$$;

comment on function app.create_stock_item (
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  numeric,
  boolean
) is 'Creates one stock item, active or not, and, when loss_pct is not null, its first loss version from the current minute, date_trunc(''minute'', now()), in the same transaction. A null loss leaves the item unconfigured. Owner only. The same request_id returns the stored item id.';

-- ============================================================================
-- E. Legacy conversion writers cannot carry a schedule token. They refuse.
-- ============================================================================
create or replace function app.add_unit_conversion (
  p_item_id uuid,
  p_unit text,
  p_factor numeric,
  p_expected_base_unit text
) returns void language plpgsql security invoker
set
  search_path = '' as $$
begin
  raise exception 'use app.set_item_conversion'
    using errcode = '0A000';
end;
$$;

create or replace function app.update_unit_conversion (
  p_item_id uuid,
  p_unit text,
  p_expected_factor numeric,
  p_factor numeric,
  p_expected_base_unit text
) returns void language plpgsql security invoker
set
  search_path = '' as $$
begin
  raise exception 'use app.set_item_conversion'
    using errcode = '0A000';
end;
$$;

create or replace function app.delete_unit_conversion (
  p_item_id uuid,
  p_unit text,
  p_expected_factor numeric,
  p_expected_base_unit text
) returns void language plpgsql security invoker
set
  search_path = '' as $$
begin
  raise exception 'use app.set_item_conversion'
    using errcode = '0A000';
end;
$$;

comment on function app.add_unit_conversion (uuid, text, numeric, text) is 'Retired. Raises 0A000. Dated conversions go through app.set_item_conversion.';

comment on function app.update_unit_conversion (uuid, text, numeric, numeric, text) is 'Retired. Raises 0A000. Dated conversions go through app.set_item_conversion.';

comment on function app.delete_unit_conversion (uuid, text, numeric, text) is 'Retired. Raises 0A000. Dated conversions go through app.set_item_conversion.';

-- ============================================================================
-- F. Snapshot worker. The gated backfill calls it once. Tests call it directly
-- against fixtures. It does not take the ledger lock and does not write the
-- costing_changes row.
-- ============================================================================
create function app.legacy_costing_snapshot_work (p_at timestamptz, p_change_id bigint) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_name text;
  v_code text;
  v_count integer;
  v_is_new boolean;
  v_loss_ids uuid[] := '{}'::uuid[];
  v_conversion_ids uuid[] := '{}'::uuid[];
  v_alias_count integer := 0;
  v_merged integer := 0;
  v_dropped integer := 0;
  v_new_id uuid;
  v_custom jsonb;
  v_group record;
  v_item record;
  v_plan record;
  v_unit record;
  v_map record;
  -- Temp tables are invisible to plpgsql_check when search_path is empty.
  v_unit_map jsonb := '[]'::jsonb;
  v_conv_plan jsonb := '[]'::jsonb;
begin
  if p_at is null
  or not pg_catalog.isfinite(p_at) then
    raise exception 'p_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  if p_change_id is null then
    raise exception 'change_id is required'
      using errcode = '22023';
  end if;

  for v_name in
    select distinct
      pg_catalog.btrim(c.unit) as name
    from
      app.item_unit_conversions c
    order by
      1
  loop
    if v_name is null
    or length(v_name) < 1 then
      raise exception 'legacy unit name is blank and cannot become a unit code'
        using errcode = '22023';
    end if;

    if length(v_name) > 20 then
      raise exception 'legacy unit name "%" is longer than 20 characters and cannot become a unit code', v_name
        using errcode = '22023';
    end if;

    v_is_new := false;
    v_code := null;

    select
      u.code into v_code
    from
      app.units u
    where
      u.code = v_name;

    if v_code is null then
      select
        a.unit_code into v_code
      from
        app.unit_aliases a
      where
        a.alias = v_name;
    end if;

    if v_code is null then
      select
        count(*)::integer,
        min(u.code) into v_count,
        v_code
      from
        app.units u
      where
        u.label_ar = v_name;

      if v_count > 1 then
        raise exception 'legacy unit name "%" matches more than one unit label', v_name
          using errcode = '22023';
      elsif v_count = 0 then
        v_code := v_name;
        v_is_new := true;
      end if;
    end if;

    v_unit_map := v_unit_map || jsonb_build_array(
      jsonb_build_object(
        'raw_name',
        v_name,
        'unit_code',
        v_code,
        'is_new',
        v_is_new
      )
    );
  end loop;

  for v_group in
    select
      c.item_id,
      si.name as item_name,
      si.base_unit,
      m.unit_code,
      count(*)::integer as row_count,
      count(distinct c.factor_to_base)::integer as factor_count,
      bool_or(c.factor_to_base is distinct from 1) as any_not_one,
      min(c.factor_to_base) as factor,
      pg_catalog.string_agg(
        distinct pg_catalog.btrim(c.unit),
        ', '
        order by
          pg_catalog.btrim(c.unit)
      ) as names,
      pg_catalog.string_agg(
        distinct pg_catalog.trim_scale(c.factor_to_base)::text,
        ', '
        order by
          pg_catalog.trim_scale(c.factor_to_base)::text
      ) as factors
    from
      app.item_unit_conversions c
      join app.stock_items si on si.id = c.item_id
      join lateral (
        select
          map_elem.value ->> 'unit_code' as unit_code
        from
          pg_catalog.jsonb_array_elements(v_unit_map) as map_elem(value)
        where
          map_elem.value ->> 'raw_name' = pg_catalog.btrim(c.unit)
      ) m on true
    group by
      c.item_id,
      si.name,
      si.base_unit,
      m.unit_code
  loop
    if v_group.factor_count > 1 then
      raise exception 'legacy conversions for item % (%) collide on unit %: names %, factors %', v_group.item_id, v_group.item_name, v_group.unit_code, v_group.names, v_group.factors
        using errcode = '22023';
    end if;

    if v_group.unit_code = v_group.base_unit
    and v_group.any_not_one then
      raise exception 'legacy conversion for item % (%) maps unit % onto base unit % with a factor other than 1 (names %, factors %)', v_group.item_id, v_group.item_name, v_group.unit_code, v_group.base_unit, v_group.names, v_group.factors
        using errcode = '22023';
    end if;

    if v_group.unit_code = v_group.base_unit then
      v_dropped := v_dropped + v_group.row_count;
    else
      v_merged := v_merged + v_group.row_count - 1;

      v_conv_plan := v_conv_plan || jsonb_build_array(
        jsonb_build_object(
          'item_id',
          v_group.item_id,
          'unit_code',
          v_group.unit_code,
          'factor',
          v_group.factor
        )
      );
    end if;
  end loop;

  insert into
    app.units (code, label_ar, dimension, metric_scale)
  select
    map_elem.value ->> 'unit_code',
    map_elem.value ->> 'raw_name',
    'custom',
    null
  from
    pg_catalog.jsonb_array_elements(v_unit_map) as map_elem(value)
  where
    (map_elem.value ->> 'is_new')::boolean
  order by
    map_elem.value ->> 'unit_code';

  for v_unit in
    select
      u.code,
      pg_catalog.btrim(u.label_ar) as label_ar
    from
      app.units u
    order by
      u.code
  loop
    if v_unit.label_ar is null
    or length(v_unit.label_ar) < 1
    or length(v_unit.label_ar) > 40 then
      raise exception 'unit label "%" cannot be stored as an alias', v_unit.label_ar
        using errcode = '22023';
    end if;

    -- Same rule as add_custom_unit: a label that equals a code or an alias
    -- is left alone. That includes a label equal to the unit's own code.
    if not exists (
      select
        1
      from
        app.units u
      where
        u.code = v_unit.label_ar
    )
    and not exists (
      select
        1
      from
        app.unit_aliases a
      where
        a.alias = v_unit.label_ar
    ) then
      insert into
        app.unit_aliases (alias, unit_code, created_change_id)
      values
        (v_unit.label_ar, v_unit.code, p_change_id);

      v_alias_count := v_alias_count + 1;
    end if;
  end loop;

  for v_map in
    select
      map_elem.value ->> 'raw_name' as raw_name,
      map_elem.value ->> 'unit_code' as unit_code
    from
      pg_catalog.jsonb_array_elements(v_unit_map) as map_elem(value)
    order by
      1
  loop
    if not exists (
      select
        1
      from
        app.units u
      where
        u.code = v_map.raw_name
    )
    and not exists (
      select
        1
      from
        app.unit_aliases a
      where
        a.alias = v_map.raw_name
    ) then
      insert into
        app.unit_aliases (alias, unit_code, created_change_id)
      values
        (v_map.raw_name, v_map.unit_code, p_change_id);

      v_alias_count := v_alias_count + 1;
    end if;
  end loop;

  for v_item in
    select
      si.id,
      si.loss_pct
    from
      app.stock_items si
    order by
      si.id
  loop
    v_new_id := pg_catalog.gen_random_uuid();

    insert into
      app.item_loss_versions (id, effective_from, effective_to, created_change_id, item_id, loss_pct)
    values
      (
        v_new_id,
        p_at,
        null,
        p_change_id,
        v_item.id,
        v_item.loss_pct
      );

    v_loss_ids := pg_catalog.array_append(v_loss_ids, v_new_id);
  end loop;

  for v_plan in
    select
      (plan_elem.value ->> 'item_id')::uuid as item_id,
      plan_elem.value ->> 'unit_code' as unit_code,
      (plan_elem.value ->> 'factor')::numeric(18, 9) as factor
    from
      pg_catalog.jsonb_array_elements(v_conv_plan) as plan_elem(value)
    order by
      1,
      2
  loop
    v_new_id := pg_catalog.gen_random_uuid();

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
        v_new_id,
        p_at,
        null,
        p_change_id,
        v_plan.item_id,
        v_plan.unit_code,
        v_plan.factor
      );

    v_conversion_ids := pg_catalog.array_append(v_conversion_ids, v_new_id);
  end loop;

  select
    coalesce(
      jsonb_agg(
        map_elem.value ->> 'unit_code'
        order by
          map_elem.value ->> 'unit_code'
      ),
      '[]'::jsonb
    ) into v_custom
  from
    pg_catalog.jsonb_array_elements(v_unit_map) as map_elem(value)
  where
    (map_elem.value ->> 'is_new')::boolean;

  return jsonb_build_object(
    'loss_count',
    coalesce(pg_catalog.cardinality(v_loss_ids), 0),
    'loss_ids',
    pg_catalog.to_jsonb(v_loss_ids),
    'conversion_count',
    coalesce(pg_catalog.cardinality(v_conversion_ids), 0),
    'conversion_ids',
    pg_catalog.to_jsonb(v_conversion_ids),
    'custom_units',
    v_custom,
    'alias_count',
    v_alias_count,
    'merged_duplicate_count',
    v_merged,
    'dropped_base_count',
    v_dropped
  );
end;
$$;

comment on function app.legacy_costing_snapshot_work (timestamptz, bigint) is 'Copies legacy loss and conversions into dated versions citing p_change_id. Reads the legacy tables only. Raises when two names for one item collapse to different factors, or a name maps onto the base unit with a factor other than 1.';

create function app.backfill_legacy_costing (p_at timestamptz) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_existing jsonb;
  v_id bigint;
  v_result jsonb;
begin
  if p_at is null
  or not pg_catalog.isfinite(p_at) then
    raise exception 'p_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  select
    cc.result into v_existing
  from
    app.costing_changes cc
  where
    cc.kind = 'legacy'
    and cc.payload ->> 'fn' = 'backfill_legacy_costing'
  order by
    cc.id
  limit
    1;

  if found then
    return v_existing;
  end if;

  -- The migration role is not the owner and is not service_role, so this
  -- cannot call app.assert_ledger_write_allowed. The lock key matches it.
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  select
    cc.result into v_existing
  from
    app.costing_changes cc
  where
    cc.kind = 'legacy'
    and cc.payload ->> 'fn' = 'backfill_legacy_costing'
  order by
    cc.id
  limit
    1;

  if found then
    return v_existing;
  end if;

  v_id := pg_catalog.nextval(
    pg_catalog.pg_get_serial_sequence('app.costing_changes', 'id')::regclass
  );

  set constraints app.item_loss_versions_created_change_id_fkey,
  app.item_conversion_versions_created_change_id_fkey,
  app.unit_aliases_created_change_id_fkey deferred;

  v_result := app.legacy_costing_snapshot_work(p_at, v_id);

  insert into
    app.costing_changes (id, request_id, kind, actor_id, reason, payload, result)
  overriding system value
  values
    (
      v_id,
      pg_catalog.gen_random_uuid(),
      'legacy',
      null,
      'legacy snapshot at cutover',
      jsonb_build_object(
        'fn',
        'backfill_legacy_costing',
        'at',
        app.costing_timestamptz_text (p_at)
      ),
      v_result
    );

  set constraints app.item_loss_versions_created_change_id_fkey,
  app.item_conversion_versions_created_change_id_fkey,
  app.unit_aliases_created_change_id_fkey immediate;

  return v_result;
end;
$$;

comment on function app.backfill_legacy_costing (timestamptz) is 'One-shot cutover. A second call returns the stored legacy result and writes nothing. Not granted to API roles.';

-- ============================================================================
-- G. Ledger readers resolve a code or an alias, then the dated factor.
-- ============================================================================
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

  if not app.batch_is_forward (v_item_ids, v_times) then
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

  v_batch_id := app.post_movements (v_movements);

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

comment on function app.record_purchase (jsonb) is 'Posts one purchase and its lines in the caller transaction. Unit text is a unit code or an alias. The factor is app.item_factor_at at purchased_at. Request-id replay returns before any unit lookup.';

comment on function app.post_movements (jsonb) is 'Single server-side entry point to post opening, purchase, sale, waste, and count_adjustment movements. Unit text is a unit code or an alias, resolved at occurred_at.';

comment on function app.record_opening_stock (timestamptz, jsonb, uuid) is 'Posts one opening batch through app.post_movements. Unit text is a unit code or an alias. The factor is app.item_factor_at at occurred_at. Request-id replay returns before any unit lookup.';

-- ============================================================================
-- H. Read models.
-- ============================================================================
create view app.item_units_current
with
  (security_invoker = true) as
select
  si.id as item_id,
  si.base_unit as unit_code,
  bu.label_ar,
  1::numeric as factor_to_base,
  '1'::text as factor_text,
  'base'::text as source,
  null::uuid as version_id,
  null::timestamptz as effective_from
from
  app.stock_items si
  join app.units bu on bu.code = si.base_unit
where
  si.active
union all
select
  si.id as item_id,
  v.unit_code,
  u.label_ar,
  v.factor_to_base,
  pg_catalog.trim_scale (v.factor_to_base)::text as factor_text,
  'explicit'::text as source,
  v.id as version_id,
  v.effective_from
from
  app.stock_items si
  join app.item_conversion_versions v on v.item_id = si.id
  and v.superseded_change_id is null
  and v.valid_during @> pg_catalog.now ()
  join app.units u on u.code = v.unit_code
where
  si.active
union all
select
  si.id as item_id,
  u.code as unit_code,
  u.label_ar,
  u.metric_scale / bu.metric_scale as factor_to_base,
  pg_catalog.trim_scale (u.metric_scale / bu.metric_scale)::text as factor_text,
  'implicit'::text as source,
  null::uuid as version_id,
  null::timestamptz as effective_from
from
  app.stock_items si
  join app.units bu on bu.code = si.base_unit
  join app.units u on u.dimension = bu.dimension
  and u.dimension in ('mass', 'volume')
  and u.code <> bu.code
  and u.metric_scale is not null
  and bu.metric_scale is not null
where
  si.active
  and not exists (
    select
      1
    from
      app.item_conversion_versions v
    where
      v.item_id = si.id
      and v.unit_code = u.code
      and v.superseded_change_id is null
      and v.valid_during @> pg_catalog.now ()
  );

comment on view app.item_units_current is 'Usable units of each active item at now(): the base unit, explicit current conversions, and implicit metric units that are not already explicit. Owner rows come from the underlying RLS policies.';

create function app.item_units_at (p_item_ids uuid[], p_at timestamptz) returns table (
  item_id uuid,
  unit_code text,
  label_ar text,
  factor_to_base numeric,
  factor_text text,
  source text,
  version_id uuid,
  effective_from timestamptz
) language plpgsql stable security invoker
set
  search_path = '' as $$
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_item_ids is null then
    raise exception 'item_ids is required'
      using errcode = '22023';
  end if;

  if p_at is null
  or not pg_catalog.isfinite(p_at) then
    raise exception 'p_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  return query
  select
    si.id,
    si.base_unit,
    bu.label_ar,
    1::numeric,
    '1'::text,
    'base'::text,
    null::uuid,
    null::timestamptz
  from
    app.stock_items si
    join app.units bu on bu.code = si.base_unit
  where
    si.id = any (p_item_ids)
  union all
  select
    si.id,
    v.unit_code,
    u.label_ar,
    v.factor_to_base,
    pg_catalog.trim_scale(v.factor_to_base)::text,
    'explicit'::text,
    v.id,
    v.effective_from
  from
    app.stock_items si
    join app.item_conversion_versions v on v.item_id = si.id
    and v.superseded_change_id is null
    and v.valid_during @> p_at
    join app.units u on u.code = v.unit_code
  where
    si.id = any (p_item_ids)
  union all
  select
    si.id,
    u.code,
    u.label_ar,
    u.metric_scale / bu.metric_scale,
    pg_catalog.trim_scale(u.metric_scale / bu.metric_scale)::text,
    'implicit'::text,
    null::uuid,
    null::timestamptz
  from
    app.stock_items si
    join app.units bu on bu.code = si.base_unit
    join app.units u on u.dimension = bu.dimension
    and u.dimension in ('mass', 'volume')
    and u.code <> bu.code
    and u.metric_scale is not null
    and bu.metric_scale is not null
  where
    si.id = any (p_item_ids)
    and not exists (
      select
        1
      from
        app.item_conversion_versions v
      where
        v.item_id = si.id
        and v.unit_code = u.code
        and v.superseded_change_id is null
        and v.valid_during @> p_at
    );
end;
$$;

comment on function app.item_units_at (uuid[], timestamptz) is 'Same columns as item_units_current, resolved at p_at for the requested items, including inactive items. Owner only.';

create function app.current_shift_start () returns timestamptz language plpgsql stable security invoker
set
  search_path = '' as $$
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  return (
    select
      max(ps.opened_at)
    from
      app.pos_shifts ps
    where
      ps.closed_at is null
  );
end;
$$;

comment on function app.current_shift_start () is 'opened_at of the latest open POS shift, or null when every shift is closed. Owner only.';

create function app.costing_impact (
  p_from timestamptz,
  p_to timestamptz,
  p_item_id uuid default null
) returns jsonb language plpgsql stable security invoker
set
  search_path = '' as $$
declare
  v_to timestamptz;
  v_orders bigint;
  v_shifts bigint;
  v_movements bigint;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_from is null
  or not pg_catalog.isfinite(p_from) then
    raise exception 'p_from must be a finite timestamp'
      using errcode = '22023';
  end if;

  if p_to is not null
  and not pg_catalog.isfinite(p_to) then
    raise exception 'p_to must be a finite timestamp'
      using errcode = '22023';
  end if;

  v_to := coalesce(p_to, pg_catalog.now());

  select
    count(*)::bigint,
    count(distinct o.shift_id)::bigint into v_orders,
    v_shifts
  from
    app.pos_orders o
  where
    o.status = 'complete'
    and not o.missing_from_pos
    and o.ordered_at >= p_from
    and o.ordered_at < v_to;

  if p_item_id is not null then
    select
      count(*)::bigint into v_movements
    from
      app.stock_movements sm
    where
      sm.item_id = p_item_id
      and sm.occurred_at >= p_from
      and sm.occurred_at < v_to;
  end if;

  return jsonb_build_object(
    'orders',
    v_orders,
    'shifts',
    v_shifts,
    'movements',
    v_movements
  );
end;
$$;

comment on function app.costing_impact (timestamptz, timestamptz, uuid) is 'Counts complete POS orders and their shifts on [p_from, p_to), and that item''s movements when p_item_id is given. movements is null when the item is omitted. Owner only.';

-- ============================================================================
-- I. Grants. Writers match the PR 1 owner-only functions. Lookups that the
-- UI calls are authenticated only. Internal helpers stay revoked.
-- ============================================================================
alter table app.unit_aliases enable row level security;

create policy unit_aliases_select_owner on app.unit_aliases for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.unit_aliases
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.unit_aliases to authenticated,
  service_role;

revoke all on function app.trg_stock_items_loss_pct_frozen ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_item_unit_conversions_frozen ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_unit_aliases_immutable ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_units_code_namespace ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_unit_alias_namespace ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.resolve_unit_code (text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.legacy_costing_snapshot_work (timestamptz, bigint)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.backfill_legacy_costing (timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.add_custom_unit (uuid, text, text)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.add_custom_unit (uuid, text, text) to authenticated;

revoke all on function app.create_stock_item (
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  numeric,
  boolean
)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.create_stock_item (
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  numeric,
  boolean
) to authenticated;

revoke all on function app.item_units_at (uuid[], timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.item_units_at (uuid[], timestamptz) to authenticated;

revoke all on function app.current_shift_start ()
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.current_shift_start () to authenticated;

revoke all on function app.costing_impact (timestamptz, timestamptz, uuid)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.costing_impact (timestamptz, timestamptz, uuid) to authenticated;

revoke all on table app.item_units_current
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.item_units_current to authenticated,
  service_role;

-- One cutover instant. A later call returns this row and writes nothing.
select
  app.backfill_legacy_costing (pg_catalog.now ());
