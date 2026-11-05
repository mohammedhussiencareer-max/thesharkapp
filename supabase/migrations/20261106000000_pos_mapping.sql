-- POS mapping (phase 4, PR 6). Additive only.
--
-- A base subject is (pos_item_id, size_key). size_key is ["name", trimmed
-- size] or ["none"]. An option subject is a trimmed option value, global by
-- default, with an optional per-base-subject override. Option price is not
-- identity. Dated rows follow recipe versions: half-open intervals, supersede
-- plus fragments, btree_gist exclusion, one schedule token per subject, request
-- replay before the clock, and "now" for the current minute.
--
-- Decisions this migration settles:
-- * Stock start is the earliest opening_stocks.occurred_at. Coverage counts
--   complete, not-missing lines of shifts that opened in the window, at or
--   after that instant. No opening means nothing is eligible.
-- * A weight line (weighted_qty present) scales the base target by the weight
--   in kg and never applies loss. A fixed line scales by quantity. A fixed
--   direct target of kind seafood or fish_size applies net to raw with the
--   item loss at the order instant.
-- * A cooking recipe is only a target for an option on a weight line. A base
--   mapping that names one is refused, and resolution reports
--   target_kind_mismatch for a cooking base or a cooking option on a fixed
--   line. A dish on a weight line is allowed and scales by kg. Batch,
--   packaging and fish_mixed are never targets.
-- * none_expected rejects any option on the line and does not consult option
--   mappings. exactly_one needs one unambiguous value and no blank value.
--   additive accepts any count. A missing policy blocks the line.
-- * An explicit scoped unmapped or no_stock wins over the global mapping.
--   A scoped gap falls through to the global mapping. A global gap is unmapped.
-- * Exception and mapping intervals of one base subject cannot overlap.
-- * Requirements stay exact until resolve_line_requirements rounds once to 6.
--   Incomplete and exception results carry null requirements, never a zero cost.
-- * Coverage's covered count is ready plus exception. A line counts only when
--   its quantity or weighted quantity is positive. Free lines (zero total,
--   positive quantity) stay in the denominator. Canceled, open, missing and
--   pre-start lines do not.
-- ============================================================================
-- A. costing_changes.kind gains 'mapping' and keeps the kinds already allowed.
-- ============================================================================
do $$
declare
  v_name text;
begin
  select
    c.conname
  into v_name
  from
    pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  where
    n.nspname = 'app'
    and t.relname = 'costing_changes'
    and c.contype = 'c'
    and (
      pg_catalog.pg_get_constraintdef (c.oid) ilike '%kind in%'
      or pg_catalog.pg_get_constraintdef (c.oid) ilike '%kind = any%'
    );

  if v_name is null then
    raise exception 'costing_changes kind check was not found'
      using errcode = '55000';
  end if;

  execute pg_catalog.format(
    'alter table app.costing_changes drop constraint %I',
    v_name
  );
end;
$$;

alter table app.costing_changes
add constraint costing_changes_kind_chk check (kind in ('owner', 'import', 'legacy', 'mapping'));

-- ============================================================================
-- B. Subjects and dated versions.
-- ============================================================================
create table app.pos_map_subjects (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  pos_item_id text null,
  size_key jsonb null,
  option_scope text null,
  option_value text null,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  constraint pos_map_subjects_kind_chk check (kind in ('base', 'option')),
  constraint pos_map_subjects_item_chk check (
    pos_item_id is null
    or (
      pos_item_id = btrim(pos_item_id)
      and length(pos_item_id) between 1 and 200
    )
  ),
  constraint pos_map_subjects_scope_chk check (
    option_scope is null
    or option_scope in ('global', 'item')
  ),
  constraint pos_map_subjects_value_chk check (
    option_value is null
    or (
      option_value = btrim(option_value)
      and length(option_value) between 1 and 200
    )
  ),
  constraint pos_map_subjects_shape_chk check (
    (
      kind = 'base'
      and pos_item_id is not null
      and size_key is not null
      and option_scope is null
      and option_value is null
    )
    or (
      kind = 'option'
      and option_scope = 'global'
      and option_value is not null
      and pos_item_id is null
      and size_key is null
    )
    or (
      kind = 'option'
      and option_scope = 'item'
      and option_value is not null
      and pos_item_id is not null
      and size_key is not null
    )
  )
);

comment on table app.pos_map_subjects is 'Identity of one POS mapping subject. Base is item plus size key. Option is a trimmed value, global or overridden for one base subject. Created on the first dated write. Rows are immutable.';

create unique index pos_map_subjects_base_uidx on app.pos_map_subjects (pos_item_id, size_key)
where
  kind = 'base';

create unique index pos_map_subjects_option_global_uidx on app.pos_map_subjects (option_value)
where
  kind = 'option'
  and option_scope = 'global';

create unique index pos_map_subjects_option_item_uidx on app.pos_map_subjects (pos_item_id, size_key, option_value)
where
  kind = 'option'
  and option_scope = 'item';

create table app.pos_map_versions (
  id uuid primary key default gen_random_uuid(),
  effective_from timestamptz not null,
  effective_to timestamptz null,
  valid_during tstzrange generated always as (tstzrange (effective_from, effective_to, '[)')) stored,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  superseded_change_id bigint null references app.costing_changes (id) on delete restrict,
  subject_id uuid not null references app.pos_map_subjects (id) on delete restrict,
  family text not null,
  target_kind text null,
  recipe_id uuid null references app.recipes (id) on delete restrict,
  stock_item_id uuid null references app.stock_items (id) on delete restrict,
  quantity_per_basis numeric null,
  unit_code text null references app.units (code) on delete restrict,
  exception_reason text null,
  option_policy text null,
  constraint pos_map_versions_from_finite_chk check (pg_catalog.isfinite (effective_from)),
  constraint pos_map_versions_to_chk check (
    effective_to is null
    or (
      pg_catalog.isfinite (effective_to)
      and effective_to > effective_from
    )
  ),
  constraint pos_map_versions_family_chk check (
    family in ('mapping', 'exception', 'option_policy')
  ),
  constraint pos_map_versions_target_kind_chk check (
    target_kind is null
    or target_kind in ('recipe', 'stock', 'unmapped', 'no_stock')
  ),
  constraint pos_map_versions_policy_chk check (
    option_policy is null
    or option_policy in ('none_expected', 'exactly_one', 'additive')
  ),
  constraint pos_map_versions_qty_chk check (
    quantity_per_basis is null
    or (
      quantity_per_basis <> 'NaN'::numeric
      and quantity_per_basis <> 'Infinity'::numeric
      and quantity_per_basis <> '-Infinity'::numeric
      and quantity_per_basis > 0
    )
  ),
  constraint pos_map_versions_exception_chk check (
    exception_reason is null
    or (
      exception_reason = btrim(exception_reason)
      and length(exception_reason) between 1 and 500
    )
  ),
  constraint pos_map_versions_shape_chk check (
    (
      family = 'mapping'
      and option_policy is null
      and exception_reason is null
      and (
        (
          target_kind = 'recipe'
          and recipe_id is not null
          and stock_item_id is null
          and quantity_per_basis is null
          and unit_code is null
        )
        or (
          target_kind = 'stock'
          and stock_item_id is not null
          and recipe_id is null
          and quantity_per_basis is not null
          and unit_code is not null
        )
        or (
          target_kind in ('unmapped', 'no_stock')
          and recipe_id is null
          and stock_item_id is null
          and quantity_per_basis is null
          and unit_code is null
        )
      ) is true
    )
    or (
      family = 'exception'
      and exception_reason is not null
      and target_kind is null
      and recipe_id is null
      and stock_item_id is null
      and quantity_per_basis is null
      and unit_code is null
      and option_policy is null
    )
    or (
      family = 'option_policy'
      and option_policy is not null
      and target_kind is null
      and recipe_id is null
      and stock_item_id is null
      and quantity_per_basis is null
      and unit_code is null
      and exception_reason is null
    )
  ),
  constraint pos_map_versions_mapping_excl exclude using gist (
    subject_id extensions.gist_uuid_ops
    with
      =,
      valid_during
    with
      &&
  )
  where
    (
      superseded_change_id is null
      and family = 'mapping'
    ),
    constraint pos_map_versions_exception_excl exclude using gist (
      subject_id extensions.gist_uuid_ops
      with
        =,
        valid_during
      with
        &&
    )
  where
    (
      superseded_change_id is null
      and family = 'exception'
    ),
    constraint pos_map_versions_policy_excl exclude using gist (
      subject_id extensions.gist_uuid_ops
      with
        =,
        valid_during
      with
        &&
    )
  where
    (
      superseded_change_id is null
      and family = 'option_policy'
    )
);

comment on table app.pos_map_versions is 'Dated mapping, exception or option policy. Non-superseded intervals of one family do not overlap. A gap means nothing is in force. Exception intervals cannot overlap a mapping of the same base subject. Only superseded_change_id may change, and only once.';

create index pos_map_versions_subject_idx on app.pos_map_versions (subject_id, family, effective_from);

create index pos_map_versions_recipe_idx on app.pos_map_versions (recipe_id)
where
  recipe_id is not null
  and superseded_change_id is null;

create index pos_map_versions_stock_idx on app.pos_map_versions (stock_item_id)
where
  stock_item_id is not null
  and superseded_change_id is null;

create index pos_map_versions_created_change_idx on app.pos_map_versions (created_change_id);

create index pos_map_versions_superseded_change_idx on app.pos_map_versions (superseded_change_id)
where
  superseded_change_id is not null;

-- ============================================================================
-- C. Immutability. Version rows reuse the shared supersede trigger.
-- ============================================================================
create function app.trg_pos_map_subjects_immutable () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.pos_map_subjects is immutable; % is not allowed', tg_op
    using errcode = '55000';
end;
$$;

create trigger trg_pos_map_subjects_immutable
before update or delete on app.pos_map_subjects for each row
execute function app.trg_pos_map_subjects_immutable ();

create trigger trg_pos_map_subjects_no_truncate
before truncate on app.pos_map_subjects for each statement
execute function app.trg_pos_map_subjects_immutable ();

create trigger trg_pos_map_versions_supersede_only
before update or delete on app.pos_map_versions for each row
execute function app.trg_version_supersede_only ();

create trigger trg_pos_map_versions_no_truncate
before truncate on app.pos_map_versions for each statement
execute function app.trg_version_no_truncate ();

create function app.trg_pos_map_versions_subject () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_kind text;
begin
  select
    s.kind
  into v_kind
  from
    app.pos_map_subjects s
  where
    s.id = new.subject_id;

  if v_kind is null then
    raise exception 'unknown mapping subject'
      using errcode = '23503';
  end if;

  if new.family = 'mapping'
  and new.target_kind in ('unmapped', 'no_stock')
  and v_kind <> 'option' then
    raise exception 'only an option mapping can be unmapped or no_stock'
      using errcode = '23514';
  end if;

  if new.family in ('exception', 'option_policy')
  and v_kind <> 'base' then
    raise exception 'exceptions and option policies belong to a base subject'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_pos_map_versions_subject
before insert on app.pos_map_versions for each row
execute function app.trg_pos_map_versions_subject ();

create function app.trg_pos_map_versions_overlap () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  if new.superseded_change_id is not null
  or new.family not in ('mapping', 'exception') then
    return new;
  end if;

  if exists (
    select
      1
    from
      app.pos_map_versions other
      join app.pos_map_subjects s on s.id = new.subject_id
    where
      s.kind = 'base'
      and other.subject_id = new.subject_id
      and other.id <> new.id
      and other.superseded_change_id is null
      and other.family = case
        when new.family = 'mapping' then 'exception'
        else 'mapping'
      end
      and other.valid_during && new.valid_during
  ) then
    raise exception 'an exception overlaps a mapping for the same subject'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger trg_pos_map_versions_overlap
after insert on app.pos_map_versions for each row
execute function app.trg_pos_map_versions_overlap ();

-- ============================================================================
-- D. Pure keys. pos_size_key(text) is granted: the security-invoker list calls it.
-- ============================================================================
create function app.pos_size_key (p_size_name text) returns jsonb language sql immutable
set
  search_path = '' as $$
  select
    case
      when p_size_name is null
      or btrim(p_size_name) = '' then '["none"]'::jsonb
      else pg_catalog.jsonb_build_array('name', btrim(p_size_name))
    end;
$$;

comment on function app.pos_size_key (text) is 'Canonical size key for one stored POS size name. Blank becomes ["none"]. Granted to authenticated because the observed-subject view calls it.';

create function app.pos_size_key_normalize (p_key jsonb) returns jsonb language plpgsql stable
set
  search_path = '' as $$
declare
  v_name text;
begin
  if p_key is null
  or pg_catalog.jsonb_typeof (p_key) <> 'array'
  or pg_catalog.jsonb_array_length (p_key) not in (1, 2) then
    raise exception 'size_key must be ["none"] or ["name", size]'
      using errcode = '22023';
  end if;

  perform app.recipe_payload_assert_no_price_keys (p_key, 0);

  if pg_catalog.jsonb_array_length (p_key) = 1 then
    if p_key ->> 0 is distinct from 'none' then
      raise exception 'size_key must be ["none"] or ["name", size]'
        using errcode = '22023';
    end if;

    return '["none"]'::jsonb;
  end if;

  if p_key ->> 0 is distinct from 'name'
  or pg_catalog.jsonb_typeof (p_key -> 1) <> 'string' then
    raise exception 'size_key must be ["none"] or ["name", size]'
      using errcode = '22023';
  end if;

  v_name := btrim(p_key ->> 1);

  if v_name is null
  or length(v_name) not between 1 and 200 then
    raise exception 'size name must be 1 to 200 characters'
      using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_array('name', v_name);
end;
$$;

create function app.pos_name_key (p_text text) returns text language plpgsql immutable
set
  search_path = '' as $$
declare
  v text := coalesce(p_text, '');
begin
  -- Same folds as the workbook import: invisible characters, tatweel,
  -- diacritics, alef forms and alef maksura. Teh marbuta stays distinct from heh.
  v := pg_catalog.translate(
    v,
    chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207) || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238) || chr(8294) || chr(8295) || chr(8296) || chr(8297) || chr(65279),
    ''
  );
  v := pg_catalog.btrim(pg_catalog.regexp_replace(v, '\s+', ' ', 'g'));
  v := pg_catalog.replace(v, chr(1600), '');
  v := pg_catalog.regexp_replace(
    v,
    '[' || chr(1611) || '-' || chr(1631) || chr(1648) || ']',
    '',
    'g'
  );
  v := pg_catalog.translate(v, chr(1570) || chr(1571) || chr(1573) || chr(1649), 'اااا');
  v := pg_catalog.replace(v, 'ى', 'ي');
  return pg_catalog.btrim(pg_catalog.regexp_replace(v, '\s+', ' ', 'g'));
end;
$$;

comment on function app.pos_name_key (text) is 'Normalised suggestion key. Trim, collapse spaces, drop tatweel and diacritics, fold alef and alef maksura. Teh marbuta and heh stay distinct. Internal.';

create function app.pos_text_id (p_value text, p_what text) returns text language plpgsql immutable
set
  search_path = '' as $$
declare
  v text := btrim(p_value);
begin
  if v is null
  or length(v) not between 1 and 200 then
    raise exception '% must be 1 to 200 characters', p_what
      using errcode = '22023';
  end if;

  return v;
end;
$$;

create function app.pos_map_identity (
  p_kind text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_scope text,
  p_option_value text
) returns text language sql immutable
set
  search_path = '' as $$
  select
    case
      when p_kind = 'base' then 'base|' || p_pos_item_id || '|' || p_size_key::text || '|'
      when p_scope = 'global' then 'option|global|' || p_option_value || '|'
      else 'option|item|' || p_pos_item_id || '|' || p_size_key::text || '|' || p_option_value || '|'
    end;
$$;

create function app.pos_map_label (
  p_kind text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_scope text,
  p_option_value text
) returns text language sql immutable
set
  search_path = '' as $$
  select
    case
      when p_kind = 'base' then p_pos_item_id || ' / ' || p_size_key::text
      when p_scope = 'global' then 'option ' || p_option_value
      else 'option ' || p_option_value || ' @ ' || p_pos_item_id || ' / ' || p_size_key::text
    end;
$$;

create function app.pos_map_version_body (
  p_family text,
  p_target_kind text,
  p_recipe_id uuid,
  p_stock_item_id uuid,
  p_quantity numeric,
  p_unit text,
  p_exception_reason text,
  p_policy text
) returns text language sql immutable
set
  search_path = '' as $$
  select
    case p_family
      when 'mapping' then case p_target_kind
        when 'recipe' then 'recipe|' || p_recipe_id::text
        when 'stock' then 'stock|' || p_stock_item_id::text || '|' || pg_catalog.trim_scale (p_quantity)::text || '|' || p_unit
        when 'unmapped' then 'unmapped'
        else 'no_stock'
      end
      when 'exception' then 'exception|' || p_exception_reason
      else 'policy|' || p_policy
    end;
$$;

create function app.pos_map_schedule_line (
  p_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_family text,
  p_body text
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
    ) || '|' || p_family || '|' || p_body;
$$;

create function app.pos_map_subject_id (
  p_kind text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_scope text,
  p_option_value text
) returns uuid language sql stable security definer
set
  search_path = '' as $$
  select
    s.id
  from
    app.pos_map_subjects s
  where
    (
      p_kind = 'base'
      and s.kind = 'base'
      and s.pos_item_id = p_pos_item_id
      and s.size_key = p_size_key
    )
    or (
      p_kind = 'option'
      and s.kind = 'option'
      and s.option_scope = p_scope
      and s.option_value = p_option_value
      and (
        (
          p_scope = 'global'
          and s.pos_item_id is null
          and s.size_key is null
        )
        or (
          p_scope = 'item'
          and s.pos_item_id = p_pos_item_id
          and s.size_key = p_size_key
        )
      )
    );
$$;

create function app.pos_map_token (
  p_kind text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_scope text,
  p_option_value text
) returns text language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_identity text := app.pos_map_identity (
    p_kind,
    p_pos_item_id,
    p_size_key,
    p_scope,
    p_option_value
  );
  v_subject uuid := app.pos_map_subject_id (
    p_kind,
    p_pos_item_id,
    p_size_key,
    p_scope,
    p_option_value
  );
  v_body text;
begin
  select
    pg_catalog.string_agg(
      app.pos_map_schedule_line (
        v.id,
        v.effective_from,
        v.effective_to,
        v.family,
        app.pos_map_version_body (
          v.family,
          v.target_kind,
          v.recipe_id,
          v.stock_item_id,
          v.quantity_per_basis,
          v.unit_code,
          v.exception_reason,
          v.option_policy
        )
      ),
      ','
      order by
        v.effective_from,
        v.id
    )
  into v_body
  from
    app.pos_map_versions v
  where
    v.subject_id = v_subject
    and v.superseded_change_id is null;

  return pg_catalog.md5(v_identity || coalesce(v_body, ''));
end;
$$;

comment on function app.pos_map_token (text, text, jsonb, text, text) is 'md5 of the subject identity plus every non-superseded version line (id, interval, family, body). An empty schedule hashes the identity alone. Internal.';

-- ============================================================================
-- E. Target allowlist. Unknown keys and price-like keys fail at every level.
-- ============================================================================
create function app.pos_map_assert_keys (p_node jsonb) returns void language plpgsql immutable
set
  search_path = '' as $$
declare
  v_key text;
  v_value jsonb;
begin
  if p_node is null
  or pg_catalog.jsonb_typeof (p_node) = 'null' then
    return;
  end if;

  if pg_catalog.jsonb_typeof (p_node) = 'object' then
    for v_key,
    v_value in
    select
      e.key,
      e.value
    from
      pg_catalog.jsonb_each (p_node) as e
    loop
      if pg_catalog.lower(v_key) in ('price', 'cost', 'unit_cost', 'amount')
      or v_key ilike '%price%'
      or v_key ilike '%cost%' then
        raise exception 'price-like key "%" is not allowed in a mapping payload', v_key
          using errcode = '22023';
      end if;

      perform app.pos_map_assert_keys (v_value);
    end loop;
  elsif pg_catalog.jsonb_typeof (p_node) = 'array' then
    for v_value in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements (p_node) as e
    loop
      perform app.pos_map_assert_keys (v_value);
    end loop;
  end if;
end;
$$;

create function app.pos_map_target_normalize (p_target jsonb, p_allow_disposition boolean) returns jsonb language plpgsql stable
set
  search_path = '' as $$
declare
  v_keys text[];
  v_qty numeric;
  v_qty_text text;
  v_unit text;
  v_recipe uuid;
  v_item uuid;
begin
  if p_target is null
  or pg_catalog.jsonb_typeof (p_target) = 'null' then
    return null;
  end if;

  if pg_catalog.jsonb_typeof (p_target) <> 'object' then
    raise exception 'mapping target must be an object'
      using errcode = '22023';
  end if;

  perform app.pos_map_assert_keys (p_target);

  select
    pg_catalog.array_agg(
      e.key
      order by
        e.key
    )
  into v_keys
  from
    pg_catalog.jsonb_object_keys (p_target) as e (key);

  if v_keys = array['recipe_id']::text[] then
    if pg_catalog.jsonb_typeof (p_target -> 'recipe_id') <> 'string' then
      raise exception 'recipe_id must be a uuid'
        using errcode = '22023';
    end if;

    begin
      v_recipe := (p_target ->> 'recipe_id')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'recipe_id must be a uuid'
          using errcode = '22023';
    end;

    -- Existence and kind are mutable. pos_map_apply checks them after replay.
    return pg_catalog.jsonb_build_object('recipe_id', v_recipe);
  end if;

  if v_keys = array['disposition']::text[] then
    if not p_allow_disposition
    or pg_catalog.jsonb_typeof (p_target -> 'disposition') is distinct from 'string'
    or (p_target ->> 'disposition') not in ('unmapped', 'no_stock') then
      raise exception 'disposition must be unmapped or no_stock on an option mapping'
        using errcode = '22023';
    end if;

    return pg_catalog.jsonb_build_object('disposition', p_target ->> 'disposition');
  end if;

  if v_keys = array['quantity_per_basis', 'stock_item_id', 'unit']::text[] then
    if pg_catalog.jsonb_typeof (p_target -> 'stock_item_id') <> 'string'
    or pg_catalog.jsonb_typeof (p_target -> 'unit') <> 'string' then
      raise exception 'stock target fields must be scalars'
        using errcode = '22023';
    end if;

    begin
      v_item := (p_target ->> 'stock_item_id')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'stock_item_id must be a uuid'
          using errcode = '22023';
    end;

    v_qty_text := p_target ->> 'quantity_per_basis';

    if pg_catalog.jsonb_typeof (p_target -> 'quantity_per_basis') = 'string'
    and v_qty_text !~ '^[0-9]+(\.[0-9]+)?$' then
      raise exception 'quantity_per_basis must be a finite number greater than 0'
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof (p_target -> 'quantity_per_basis') not in ('number', 'string')
    or length(v_qty_text) > 40 then
      raise exception 'quantity_per_basis must be a finite number greater than 0'
        using errcode = '22023';
    end if;

    begin
      v_qty := v_qty_text::numeric;
    exception
      when invalid_text_representation then
        raise exception 'quantity_per_basis must be a finite number greater than 0'
          using errcode = '22023';
    end;

    if v_qty is null
    or v_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or v_qty <= 0 then
      raise exception 'quantity_per_basis must be a finite number greater than 0'
        using errcode = '22023';
    end if;

    v_qty := pg_catalog.trim_scale (v_qty);
    v_unit := btrim(p_target ->> 'unit');

    if v_unit is null
    or v_unit = '' then
      raise exception 'unit is required'
        using errcode = '22023';
    end if;

    -- The item kind and the unit code are mutable. pos_map_apply checks them
    -- after replay so a retry still returns the committed row.
    return pg_catalog.jsonb_build_object(
      'quantity_per_basis',
      pg_catalog.to_jsonb (v_qty),
      'stock_item_id',
      v_item,
      'unit',
      v_unit
    );
  end if;

  raise exception 'unknown key in mapping target'
    using errcode = '22023';
end;
$$;

comment on function app.pos_map_target_normalize (jsonb, boolean) is 'Canonical mapping target. A recipe id, a stock item with quantity and unit, or, on an option only, a non-null disposition unmapped or no_stock. Does not read recipes, stock items, or units; those checks run after replay. Unknown and price-like keys raise 22023. Null is a gap. Internal.';

-- ============================================================================
-- F. Publication. A mapping names its subject when a recipe under it breaks.
-- ============================================================================
create function app.pos_map_assert_recipe (
  p_recipe_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_label text
) returns void language plpgsql
set
  search_path = '' as $$
declare
  v_kind text;
  v_closure uuid[];
  v_instants timestamptz[];
  v_at timestamptz;
  v_walk jsonb;
  v_issue jsonb;
  v_other text;
  v_item text;
  v_detail text;
begin
  if p_to is not null
  and p_from >= p_to then
    return;
  end if;

  select
    r.kind
  into v_kind
  from
    app.recipes r
  where
    r.id = p_recipe_id;

  if v_kind is null then
    raise exception 'unknown recipe id: %', p_recipe_id
      using errcode = '22023';
  end if;

  if v_kind = 'batch' then
    raise exception 'mapping "%" cannot target a batch recipe', p_label
      using errcode = '22023';
  end if;

  with recursive
    below (id) as (
      select
        p_recipe_id
      union
      select
        l.child_recipe_id
      from
        below b
        join app.recipe_versions v on v.recipe_id = b.id
        and v.superseded_change_id is null
        join app.recipe_lines l on l.version_id = v.id
        and l.child_recipe_id is not null
    )
  select
    pg_catalog.array_agg(b.id)
  into v_closure
  from
    below b;

  select
    pg_catalog.array_agg(
      t.at
      order by
        t.at
    )
  into v_instants
  from
    (
      select
        p_from as at
      union
      select
        b.at
      from
        (
          select
            v.effective_from as at
          from
            app.recipe_versions v
          where
            v.recipe_id = any (v_closure)
            and v.superseded_change_id is null
          union
          select
            v.effective_to as at
          from
            app.recipe_versions v
          where
            v.recipe_id = any (v_closure)
            and v.superseded_change_id is null
            and v.effective_to is not null
        ) b
      where
        b.at > p_from
        and (
          p_to is null
          or b.at < p_to
        )
    ) t;

  foreach v_at in array v_instants loop
    v_walk := app.recipe_walk (p_recipe_id, v_at, 1, true);

    if pg_catalog.jsonb_array_length (v_walk -> 'issues') > 0 then
      v_issue := (v_walk -> 'issues') -> 0;
      v_detail := v_issue ->> 'code';

      select
        r.name
      into v_other
      from
        app.recipes r
      where
        r.id = (v_issue ->> 'recipe_id')::uuid;

      if v_other is not null then
        v_detail := v_detail || ' in recipe "' || v_other || '"';
      end if;

      select
        si.name
      into v_item
      from
        app.stock_items si
      where
        si.id = (v_issue ->> 'stock_item_id')::uuid;

      if v_item is not null then
        v_detail := v_detail || ' for item "' || v_item || '"';
      end if;

      raise exception 'mapping "%" would be invalid at %: %', p_label, app.costing_timestamptz_text (v_at), v_detail
        using errcode = '22023';
    end if;
  end loop;
end;
$$;

comment on function app.pos_map_assert_recipe (uuid, timestamptz, timestamptz, text) is 'Walks a mapping''s recipe at the interval start and at every descendant version boundary inside it. A missing version, a marine leaf in a cooking recipe, or a cycle raises 22023 naming the mapping subject. Internal.';

create or replace function app.recipe_validate_publication (
  p_recipe_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns void language plpgsql
set
  search_path = '' as $$
declare
  v_affected uuid[];
  v_closure uuid[];
  v_instants timestamptz[];
  v_recipe uuid;
  v_at timestamptz;
  v_walk jsonb;
  v_issue jsonb;
  v_name text;
  v_other text;
  v_item text;
  v_detail text;
  v_map record;
  v_label text;
  v_recipe_kind text;
  v_slice_from timestamptz;
  v_slice_to timestamptz;
begin
  with recursive
    ancestors (id) as (
      select
        p_recipe_id
      union
      select
        v.recipe_id
      from
        ancestors a
        join app.recipe_lines l on l.child_recipe_id = a.id
        join app.recipe_versions v on v.id = l.version_id
      where
        v.superseded_change_id is null
    )
  select
    pg_catalog.array_agg(
      a.id
      order by
        (a.id <> p_recipe_id),
        a.id
    )
  into v_affected
  from
    ancestors a;

  with recursive
    below (id) as (
      select
        u.id
      from
        pg_catalog.unnest(v_affected) as u (id)
      union
      select
        l.child_recipe_id
      from
        below b
        join app.recipe_versions v on v.recipe_id = b.id
        and v.superseded_change_id is null
        join app.recipe_lines l on l.version_id = v.id
        and l.child_recipe_id is not null
    )
  select
    pg_catalog.array_agg(b.id)
  into v_closure
  from
    below b;

  select
    pg_catalog.array_agg(
      t.at
      order by
        t.at
    )
  into v_instants
  from
    (
      select
        p_from as at
      union
      select
        b.at
      from
        (
          select
            v.effective_from as at
          from
            app.recipe_versions v
          where
            v.recipe_id = any (v_closure)
            and v.superseded_change_id is null
          union
          select
            v.effective_to as at
          from
            app.recipe_versions v
          where
            v.recipe_id = any (v_closure)
            and v.superseded_change_id is null
            and v.effective_to is not null
        ) b
      where
        b.at > p_from
        and (
          p_to is null
          or b.at < p_to
        )
    ) t;

  -- Mappings are ancestors of the recipes they target. A failure names the
  -- mapping subject before the recipe's own message, so the owner sees which
  -- sold item the recipe change would break.
  for v_map in
  select
    v.recipe_id,
    v.effective_from,
    v.effective_to,
    s.kind,
    s.pos_item_id,
    s.size_key,
    s.option_scope,
    s.option_value
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    v.family = 'mapping'
    and v.target_kind = 'recipe'
    and v.recipe_id = any (v_affected)
    and v.superseded_change_id is null
    and v.valid_during && pg_catalog.tstzrange (p_from, p_to, '[)')
  order by
    s.pos_item_id nulls last,
    v.id
  loop
    v_slice_from := greatest(v_map.effective_from, p_from);

    if p_to is null then
      v_slice_to := v_map.effective_to;
    elsif v_map.effective_to is null then
      v_slice_to := p_to;
    else
      v_slice_to := least(v_map.effective_to, p_to);
    end if;

    v_label := app.pos_map_label (
      v_map.kind,
      v_map.pos_item_id,
      v_map.size_key,
      v_map.option_scope,
      v_map.option_value
    );

    -- A cooking recipe is a weight-line option target. A base that already
    -- names one blocks publication of that recipe and names the subject.
    if v_map.kind = 'base' then
      select
        r.kind
      into v_recipe_kind
      from
        app.recipes r
      where
        r.id = v_map.recipe_id;

      if v_recipe_kind = 'cooking' then
        raise exception 'a base mapping cannot target a cooking recipe: %', v_label
          using errcode = '22023';
      end if;
    end if;

    perform app.pos_map_assert_recipe (v_map.recipe_id, v_slice_from, v_slice_to, v_label);
  end loop;

  foreach v_recipe in array v_affected loop
    foreach v_at in array v_instants loop
      if not exists (
        select
          1
        from
          app.recipe_versions v
        where
          v.recipe_id = v_recipe
          and v.superseded_change_id is null
          and v.valid_during @> v_at
      ) then
        continue;
      end if;

      v_walk := app.recipe_walk (v_recipe, v_at, 1, true);

      if pg_catalog.jsonb_array_length(v_walk -> 'issues') > 0 then
        v_issue := (v_walk -> 'issues') -> 0;

        select
          r.name
        into v_name
        from
          app.recipes r
        where
          r.id = v_recipe;

        v_detail := v_issue ->> 'code';

        select
          r.name
        into v_other
        from
          app.recipes r
        where
          r.id = (v_issue ->> 'recipe_id')::uuid;

        if v_other is not null then
          v_detail := v_detail || ' in recipe "' || v_other || '"';
        end if;

        select
          si.name
        into v_item
        from
          app.stock_items si
        where
          si.id = (v_issue ->> 'stock_item_id')::uuid;

        if v_item is not null then
          v_detail := v_detail || ' for item "' || v_item || '"';
        end if;

        raise exception 'recipe "%" would be invalid at %: %', v_name, app.costing_timestamptz_text (v_at), v_detail
          using errcode = '22023';
      end if;
    end loop;
  end loop;
end;
$$;

comment on function app.recipe_validate_publication (uuid, timestamptz, timestamptz) is 'Run after a recipe change is written. Walks the changed recipe and every ancestor, then every in-force mapping of those recipes, at the interval start and at each version boundary inside it. A mapping failure names the mapping subject. A recipe with no version in force is skipped: its own gap is not an error. Loss and item conversions are not publication rules.';

-- ============================================================================
-- G. Writer. One apply path for mapping, policy and exception.
-- ============================================================================
create function app.insert_mapping_costing_change (
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
  v_result := p_result || pg_catalog.jsonb_build_object('change_id', v_id);

  insert into
    app.costing_changes (id, request_id, kind, actor_id, reason, payload, result)
  overriding system value
  values
    (
      v_id,
      p_request_id,
      'mapping',
      auth.uid (),
      p_reason,
      p_payload,
      v_result
    );

  return v_result;
end;
$$;

create function app.pos_map_apply (
  p_fn text,
  p_request_id uuid,
  p_kind text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_scope text,
  p_option_value text,
  p_family text,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_gap boolean,
  p_target jsonb,
  p_target_kind text,
  p_recipe_id uuid,
  p_stock_item_id uuid,
  p_quantity numeric,
  p_unit text,
  p_exception_reason text,
  p_policy text,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_reason text;
  v_from_is_now boolean;
  v_effective_from timestamptz;
  v_payload jsonb;
  v_replay jsonb;
  v_identity text;
  v_subject uuid;
  v_token text;
  v_new_token text;
  v_canonical_to timestamptz;
  v_label text;
  v_result jsonb;
  v_change_id bigint;
  v_superseded uuid[] := '{}'::uuid[];
  v_new_ids uuid[] := '{}'::uuid[];
  v_new_froms timestamptz[] := '{}'::timestamptz[];
  v_new_tos timestamptz[] := '{}'::timestamptz[];
  v_new_kinds text[] := '{}'::text[];
  v_new_recipes uuid[] := '{}'::uuid[];
  v_new_items uuid[] := '{}'::uuid[];
  v_new_qtys numeric[] := '{}'::numeric[];
  v_new_units text[] := '{}'::text[];
  v_new_exc text[] := '{}'::text[];
  v_new_pol text[] := '{}'::text[];
  v_row record;
  v_unit text;
  v_recipe_kind text;
  v_item_kind text;
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

  if p_expected_token is null then
    raise exception 'expected_token is required'
      using errcode = '22023';
  end if;

  if p_effective_from is null then
    v_from_is_now := true;
  elsif not pg_catalog.isfinite (p_effective_from) then
    raise exception 'effective_from must be a finite timestamp'
      using errcode = '22023';
  else
    v_from_is_now := false;
  end if;

  if p_effective_to is not null
  and not pg_catalog.isfinite (p_effective_to) then
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

  v_payload := pg_catalog.jsonb_build_object(
    'effective_from',
    case
      when v_from_is_now then 'now'
      else app.costing_timestamptz_text (p_effective_from)
    end,
    'effective_to',
    app.costing_timestamptz_text (p_effective_to),
    'exception_reason',
    p_exception_reason,
    'expected_token',
    p_expected_token,
    'family',
    p_family,
    'fn',
    p_fn,
    'gap',
    p_gap,
    'option_value',
    p_option_value,
    'policy',
    p_policy,
    'pos_item_id',
    p_pos_item_id,
    'reason',
    v_reason,
    'scope',
    p_scope,
    'size_key',
    p_size_key,
    'target',
    p_target
  );
  v_replay := app.costing_replay_result (p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  if v_from_is_now then
    v_effective_from := pg_catalog.date_trunc ('minute', pg_catalog.now ());
  else
    v_effective_from := p_effective_from;
  end if;

  if p_effective_to is not null
  and p_effective_to <= v_effective_from then
    raise exception 'effective_to must be a finite timestamp after effective_from'
      using errcode = '22023';
  end if;

  v_identity := app.pos_map_identity (
    p_kind,
    p_pos_item_id,
    p_size_key,
    p_scope,
    p_option_value
  );
  v_label := app.pos_map_label (
    p_kind,
    p_pos_item_id,
    p_size_key,
    p_scope,
    p_option_value
  );
  v_subject := app.pos_map_subject_id (
    p_kind,
    p_pos_item_id,
    p_size_key,
    p_scope,
    p_option_value
  );

  if v_subject is not null then
    perform 1
    from
      app.pos_map_subjects s
    where
      s.id = v_subject
    for update;
  end if;

  v_token := app.pos_map_token (
    p_kind,
    p_pos_item_id,
    p_size_key,
    p_scope,
    p_option_value
  );

  if v_token is distinct from p_expected_token then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  -- Replay already returned. Catalog kind and unit codes can change after a
  -- committed request, so a retry must not be rejected by their current state.
  v_unit := p_unit;

  if not p_gap
  and p_family = 'mapping' then
    if p_target_kind = 'recipe' then
      select
        r.kind
      into v_recipe_kind
      from
        app.recipes r
      where
        r.id = p_recipe_id;

      if v_recipe_kind is null then
        raise exception 'unknown recipe id: %', p_recipe_id
          using errcode = '22023';
      end if;

      if v_recipe_kind = 'batch' then
        raise exception 'a mapping cannot target a batch recipe'
          using errcode = '22023';
      end if;

      if v_recipe_kind = 'cooking'
      and p_kind is distinct from 'option' then
        raise exception 'a base mapping cannot target a cooking recipe: %', v_label
          using errcode = '22023';
      end if;
    elsif p_target_kind = 'stock' then
      select
        si.kind
      into v_item_kind
      from
        app.stock_items si
      where
        si.id = p_stock_item_id;

      if v_item_kind is null then
        raise exception 'unknown stock_item id: %', p_stock_item_id
          using errcode = '22023';
      end if;

      if v_item_kind in ('packaging', 'fish_mixed') then
        raise exception 'packaging and fish_mixed cannot be mapping targets'
          using errcode = '22023';
      end if;

      v_unit := app.resolve_unit_code (p_unit);

      if v_unit is null then
        raise exception 'unknown unit "%"', p_unit
          using errcode = '22023';
      end if;
    elsif p_target_kind in ('unmapped', 'no_stock')
    and p_kind is distinct from 'option' then
      raise exception 'disposition must be unmapped or no_stock on an option mapping'
        using errcode = '22023';
    end if;
  end if;

  select
    case
      when exists (
        select
          1
        from
          app.pos_map_versions v
        where
          v.subject_id = v_subject
          and v.family = p_family
          and v.superseded_change_id is null
          and v.effective_from <= v_effective_from
          and (
            v.effective_to is null
            or v_effective_from < v.effective_to
          )
      ) then (
        select
          v.effective_to
        from
          app.pos_map_versions v
        where
          v.subject_id = v_subject
          and v.family = p_family
          and v.superseded_change_id is null
          and v.effective_from <= v_effective_from
          and (
            v.effective_to is null
            or v_effective_from < v.effective_to
          )
        order by
          v.effective_from desc
        limit
          1
      )
      else (
        select
          min(v.effective_from)
        from
          app.pos_map_versions v
        where
          v.subject_id = v_subject
          and v.family = p_family
          and v.superseded_change_id is null
          and v.effective_from > v_effective_from
      )
    end
  into v_canonical_to;

  if v_from_is_now
  and v_canonical_to is not null
  and (
    p_effective_to is null
    or p_effective_to > v_canonical_to
  ) then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  if not v_from_is_now
  and v_effective_from < pg_catalog.now ()
  and v_reason is null then
    raise exception 'reason is required for a backdated change'
      using errcode = '22023';
  end if;

  if not p_gap
  and p_family in ('mapping', 'exception')
  and v_subject is not null
  and exists (
    select
      1
    from
      app.pos_map_versions v
    where
      v.subject_id = v_subject
      and v.superseded_change_id is null
      and v.family = case
        when p_family = 'mapping' then 'exception'
        else 'mapping'
      end
      and v.valid_during && pg_catalog.tstzrange (v_effective_from, p_effective_to, '[)')
  ) then
    raise exception 'an exception overlaps a mapping for the same subject'
      using errcode = '22023';
  end if;

  for v_row in
  select
    v.id,
    v.effective_from,
    v.effective_to,
    v.target_kind,
    v.recipe_id,
    v.stock_item_id,
    v.quantity_per_basis,
    v.unit_code,
    v.exception_reason,
    v.option_policy
  from
    app.pos_map_versions v
  where
    v.subject_id = v_subject
    and v.family = p_family
    and v.superseded_change_id is null
    and v.valid_during && pg_catalog.tstzrange (v_effective_from, p_effective_to, '[)')
  order by
    v.effective_from,
    v.id
  for update
  loop
    v_superseded := pg_catalog.array_append(v_superseded, v_row.id);

    if v_row.effective_from < v_effective_from then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid ());
      v_new_froms := pg_catalog.array_append(v_new_froms, v_row.effective_from);
      v_new_tos := pg_catalog.array_append(v_new_tos, v_effective_from);
      v_new_kinds := pg_catalog.array_append(v_new_kinds, v_row.target_kind);
      v_new_recipes := pg_catalog.array_append(v_new_recipes, v_row.recipe_id);
      v_new_items := pg_catalog.array_append(v_new_items, v_row.stock_item_id);
      v_new_qtys := pg_catalog.array_append(v_new_qtys, v_row.quantity_per_basis);
      v_new_units := pg_catalog.array_append(v_new_units, v_row.unit_code);
      v_new_exc := pg_catalog.array_append(v_new_exc, v_row.exception_reason);
      v_new_pol := pg_catalog.array_append(v_new_pol, v_row.option_policy);
    end if;

    if p_effective_to is not null
    and (
      v_row.effective_to is null
      or v_row.effective_to > p_effective_to
    ) then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid ());
      v_new_froms := pg_catalog.array_append(v_new_froms, p_effective_to);
      v_new_tos := pg_catalog.array_append(v_new_tos, v_row.effective_to);
      v_new_kinds := pg_catalog.array_append(v_new_kinds, v_row.target_kind);
      v_new_recipes := pg_catalog.array_append(v_new_recipes, v_row.recipe_id);
      v_new_items := pg_catalog.array_append(v_new_items, v_row.stock_item_id);
      v_new_qtys := pg_catalog.array_append(v_new_qtys, v_row.quantity_per_basis);
      v_new_units := pg_catalog.array_append(v_new_units, v_row.unit_code);
      v_new_exc := pg_catalog.array_append(v_new_exc, v_row.exception_reason);
      v_new_pol := pg_catalog.array_append(v_new_pol, v_row.option_policy);
    end if;
  end loop;

  if not p_gap then
    v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid ());
    v_new_froms := pg_catalog.array_append(v_new_froms, v_effective_from);
    v_new_tos := pg_catalog.array_append(v_new_tos, p_effective_to);
    v_new_kinds := pg_catalog.array_append(v_new_kinds, p_target_kind);
    v_new_recipes := pg_catalog.array_append(v_new_recipes, p_recipe_id);
    v_new_items := pg_catalog.array_append(v_new_items, p_stock_item_id);
    v_new_qtys := pg_catalog.array_append(v_new_qtys, p_quantity);
    v_new_units := pg_catalog.array_append(v_new_units, v_unit);
    v_new_exc := pg_catalog.array_append(v_new_exc, p_exception_reason);
    v_new_pol := pg_catalog.array_append(v_new_pol, p_policy);
  end if;

  select
    pg_catalog.md5(
      v_identity || coalesce(
        pg_catalog.string_agg(
          s.line,
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
        app.pos_map_schedule_line (
          v.id,
          v.effective_from,
          v.effective_to,
          v.family,
          app.pos_map_version_body (
            v.family,
            v.target_kind,
            v.recipe_id,
            v.stock_item_id,
            v.quantity_per_basis,
            v.unit_code,
            v.exception_reason,
            v.option_policy
          )
        ) as line
      from
        app.pos_map_versions v
      where
        v.subject_id = v_subject
        and v.superseded_change_id is null
        and not (v.id = any (v_superseded))
      union all
      select
        v_new_ids[g.i],
        v_new_froms[g.i],
        app.pos_map_schedule_line (
          v_new_ids[g.i],
          v_new_froms[g.i],
          v_new_tos[g.i],
          p_family,
          app.pos_map_version_body (
            p_family,
            v_new_kinds[g.i],
            v_new_recipes[g.i],
            v_new_items[g.i],
            v_new_qtys[g.i],
            v_new_units[g.i],
            v_new_exc[g.i],
            v_new_pol[g.i]
          )
        )
      from
        pg_catalog.generate_series(1, coalesce(pg_catalog.cardinality (v_new_ids), 0)) as g (i)
    ) s;

  v_result := app.insert_mapping_costing_change (
    p_request_id,
    v_reason,
    v_payload,
    pg_catalog.jsonb_build_object(
      'inserted',
      pg_catalog.to_jsonb (v_new_ids),
      'superseded',
      pg_catalog.to_jsonb (v_superseded),
      'token',
      v_new_token
    )
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  if v_subject is null then
    insert into
      app.pos_map_subjects (
        kind,
        pos_item_id,
        size_key,
        option_scope,
        option_value,
        created_change_id
      )
    values
      (
        p_kind,
        p_pos_item_id,
        p_size_key,
        p_scope,
        p_option_value,
        v_change_id
      )
    returning
      id
    into v_subject;
  end if;

  v_result := v_result || pg_catalog.jsonb_build_object('subject_id', v_subject);

  if pg_catalog.cardinality (v_superseded) > 0 then
    update app.pos_map_versions
    set
      superseded_change_id = v_change_id
    where
      id = any (v_superseded);
  end if;

  if coalesce(pg_catalog.cardinality (v_new_ids), 0) > 0 then
    for v_i in 1..pg_catalog.cardinality (v_new_ids) loop
      insert into
        app.pos_map_versions (
          id,
          effective_from,
          effective_to,
          created_change_id,
          subject_id,
          family,
          target_kind,
          recipe_id,
          stock_item_id,
          quantity_per_basis,
          unit_code,
          exception_reason,
          option_policy
        )
      values
        (
          v_new_ids[v_i],
          v_new_froms[v_i],
          v_new_tos[v_i],
          v_change_id,
          v_subject,
          p_family,
          v_new_kinds[v_i],
          v_new_recipes[v_i],
          v_new_items[v_i],
          v_new_qtys[v_i],
          v_new_units[v_i],
          v_new_exc[v_i],
          v_new_pol[v_i]
        );
    end loop;
  end if;

  if not p_gap
  and p_target_kind = 'recipe' then
    perform app.pos_map_assert_recipe (p_recipe_id, v_effective_from, p_effective_to, v_label);
  end if;

  if app.pos_map_token (
    p_kind,
    p_pos_item_id,
    p_size_key,
    p_scope,
    p_option_value
  ) is distinct from v_new_token then
    raise exception 'internal mapping token mismatch'
      using errcode = '55000';
  end if;

  -- The stored audit row was written before subject_id existed. Keep that
  -- replay result stable: callers read subject_id from the returned value of
  -- this transaction, and a retry returns the stored result without it only
  -- when the first call committed. Put subject_id into the stored result by
  -- failing closed if a retry would disagree — the insert already included
  -- token, superseded and inserted. subject_id is derived, so a retry that
  -- returns the stored result is enough when the client kept it. Overwrite
  -- is impossible because costing_changes is append-only. Return subject_id
  -- alongside the stored fields for this first call.
  return v_result;
end;
$$;

-- The first call returns subject_id. The sealed audit row does not, because
-- the subject is inserted after the change. pos_map_with_subject puts the id
-- back on a replay so both calls return the same jsonb.
comment on function app.pos_map_apply (
  text,
  uuid,
  text,
  text,
  jsonb,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  boolean,
  jsonb,
  text,
  uuid,
  uuid,
  numeric,
  text,
  text,
  text,
  text,
  text
) is 'Replaces one family of a mapping subject on [effective_from, effective_to). Null effective_from is the current minute and is stored as now. An earlier instant needs a reason. Takes advisory lock 7342750000000000001 first. Owner only. Internal.';

-- ============================================================================
-- H. Owner writers. Each one canonicalises the payload, then apply replays
-- before it checks the current recipe or stock item. Replay stores the
-- normalised payload, so a retry of the same arguments returns the same
-- result. subject_id is added for the caller; the sealed audit row stays
-- without it.
-- ============================================================================
create function app.pos_map_with_subject (
  p_result jsonb,
  p_kind text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_scope text,
  p_option_value text
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
begin
  if pg_catalog.jsonb_exists (p_result, 'subject_id') then
    return p_result;
  end if;

  return p_result || pg_catalog.jsonb_build_object(
    'subject_id',
    app.pos_map_subject_id (
      p_kind,
      p_pos_item_id,
      p_size_key,
      p_scope,
      p_option_value
    )
  );
end;
$$;

create function app.set_pos_base_mapping (
  p_request_id uuid,
  p_pos_item_id text,
  p_size_key jsonb,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_target jsonb,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_target jsonb;
  v_gap boolean;
  v_kind text;
  v_recipe uuid;
  v_stock uuid;
  v_qty numeric;
  v_unit text;
  v_result jsonb;
begin
  perform app.assert_ledger_write_allowed ();
  v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
  v_key := app.pos_size_key_normalize (p_size_key);
  v_target := app.pos_map_target_normalize (p_target, false);
  v_gap := v_target is null;

  if not v_gap then
    if pg_catalog.jsonb_exists (v_target, 'recipe_id') then
      v_kind := 'recipe';
      v_recipe := (v_target ->> 'recipe_id')::uuid;
    else
      v_kind := 'stock';
      v_stock := (v_target ->> 'stock_item_id')::uuid;
      v_qty := (v_target ->> 'quantity_per_basis')::numeric;
      v_unit := v_target ->> 'unit';
    end if;
  end if;

  v_result := app.pos_map_apply (
    'set_pos_base_mapping',
    p_request_id,
    'base',
    v_item,
    v_key,
    null,
    null,
    'mapping',
    p_effective_from,
    p_effective_to,
    v_gap,
    v_target,
    v_kind,
    v_recipe,
    v_stock,
    v_qty,
    v_unit,
    null,
    null,
    p_expected_token,
    p_reason
  );
  return app.pos_map_with_subject (v_result, 'base', v_item, v_key, null, null);
end;
$$;

comment on function app.set_pos_base_mapping (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
) is 'Dates the base mapping of one POS item and size. Null target leaves a gap. The target is a dish recipe or a stock item with quantity and unit. A cooking recipe is refused. Takes advisory lock 7342750000000000001 first. Owner only.';

create function app.set_pos_option_policy (
  p_request_id uuid,
  p_pos_item_id text,
  p_size_key jsonb,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_policy text,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_policy text;
  v_result jsonb;
begin
  perform app.assert_ledger_write_allowed ();
  v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
  v_key := app.pos_size_key_normalize (p_size_key);
  v_policy := nullif(btrim(p_policy), '');

  if v_policy is not null
  and v_policy not in ('none_expected', 'exactly_one', 'additive') then
    raise exception 'option policy must be none_expected, exactly_one, or additive'
      using errcode = '22023';
  end if;

  v_result := app.pos_map_apply (
    'set_pos_option_policy',
    p_request_id,
    'base',
    v_item,
    v_key,
    null,
    null,
    'option_policy',
    p_effective_from,
    p_effective_to,
    v_policy is null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    v_policy,
    p_expected_token,
    p_reason
  );
  return app.pos_map_with_subject (v_result, 'base', v_item, v_key, null, null);
end;
$$;

comment on function app.set_pos_option_policy (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  text,
  text,
  text
) is 'Dates the option policy of one base subject: none_expected, exactly_one, or additive. Null clears it. Shares the base subject token with the mapping and the exception. Owner only.';

create function app.set_pos_exception (
  p_request_id uuid,
  p_pos_item_id text,
  p_size_key jsonb,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_exception_reason text,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_exception text;
  v_result jsonb;
begin
  perform app.assert_ledger_write_allowed ();
  v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
  v_key := app.pos_size_key_normalize (p_size_key);

  if p_exception_reason is null
  or btrim(p_exception_reason) = '' then
    v_exception := null;
  else
    v_exception := btrim(p_exception_reason);

    if pg_catalog.length (v_exception) > 500 then
      raise exception 'exception reason must be at most 500 characters'
        using errcode = '22023';
    end if;
  end if;

  v_result := app.pos_map_apply (
    'set_pos_exception',
    p_request_id,
    'base',
    v_item,
    v_key,
    null,
    null,
    'exception',
    p_effective_from,
    p_effective_to,
    v_exception is null,
    null,
    null,
    null,
    null,
    null,
    null,
    v_exception,
    null,
    p_expected_token,
    p_reason
  );
  return app.pos_map_with_subject (v_result, 'base', v_item, v_key, null, null);
end;
$$;

comment on function app.set_pos_exception (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  text,
  text,
  text
) is 'Dates an exception: the owner confirms this base subject has no stock. The exception reason is not the backdating reason. Null clears it. An exception cannot overlap a mapping. Owner only.';

create function app.set_pos_option_mapping (
  p_request_id uuid,
  p_scope text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_option_value text,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_target jsonb,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_value text;
  v_target jsonb;
  v_gap boolean;
  v_kind text;
  v_recipe uuid;
  v_stock uuid;
  v_qty numeric;
  v_unit text;
  v_result jsonb;
begin
  perform app.assert_ledger_write_allowed ();

  if p_scope is null
  or p_scope not in ('global', 'item') then
    raise exception 'scope must be global or item'
      using errcode = '22023';
  end if;

  v_value := app.pos_text_id (p_option_value, 'option value');

  if p_scope = 'global' then
    if nullif(btrim(p_pos_item_id), '') is not null
    or (
      p_size_key is not null
      and pg_catalog.jsonb_typeof (p_size_key) is distinct from 'null'
    ) then
      raise exception 'a global option mapping has no item or size'
        using errcode = '22023';
    end if;

    v_item := null;
    v_key := null;
  else
    v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
    v_key := app.pos_size_key_normalize (p_size_key);
  end if;

  v_target := app.pos_map_target_normalize (p_target, true);
  v_gap := v_target is null;

  if not v_gap then
    if pg_catalog.jsonb_exists (v_target, 'recipe_id') then
      v_kind := 'recipe';
      v_recipe := (v_target ->> 'recipe_id')::uuid;
    elsif pg_catalog.jsonb_exists (v_target, 'disposition') then
      v_kind := v_target ->> 'disposition';
    else
      v_kind := 'stock';
      v_stock := (v_target ->> 'stock_item_id')::uuid;
      v_qty := (v_target ->> 'quantity_per_basis')::numeric;
      v_unit := v_target ->> 'unit';
    end if;
  end if;

  v_result := app.pos_map_apply (
    'set_pos_option_mapping',
    p_request_id,
    'option',
    v_item,
    v_key,
    p_scope,
    v_value,
    'mapping',
    p_effective_from,
    p_effective_to,
    v_gap,
    v_target,
    v_kind,
    v_recipe,
    v_stock,
    v_qty,
    v_unit,
    null,
    null,
    p_expected_token,
    p_reason
  );
  return app.pos_map_with_subject (v_result, 'option', v_item, v_key, p_scope, v_value);
end;
$$;

comment on function app.set_pos_option_mapping (
  uuid,
  text,
  text,
  jsonb,
  text,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
) is 'Dates one option mapping. Global has no item or size. Item scope overrides that base subject. Disposition unmapped or no_stock is an explicit row and blocks the global fallback. Null target is a gap and does fall through. Owner only.';

-- ============================================================================
-- I. Schedules. One token covers every family of the subject. A missing
-- subject still returns the empty-schedule token so the first save can match.
-- ============================================================================
create function app.pos_base_schedule (p_pos_item_id text, p_size_key jsonb) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_identity text;
  v_subject uuid;
  v_versions jsonb;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
  v_key := app.pos_size_key_normalize (p_size_key);
  v_identity := app.pos_map_identity ('base', v_item, v_key, null, null);
  v_subject := app.pos_map_subject_id ('base', v_item, v_key, null, null);

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',
          v.id,
          'family',
          v.family,
          'effective_from',
          v.effective_from,
          'effective_to',
          v.effective_to,
          'target_kind',
          v.target_kind,
          'recipe_id',
          v.recipe_id,
          'stock_item_id',
          v.stock_item_id,
          'quantity_per_basis',
          pg_catalog.to_jsonb (pg_catalog.trim_scale (v.quantity_per_basis)::text),
          'unit_code',
          v.unit_code,
          'exception_reason',
          v.exception_reason,
          'option_policy',
          v.option_policy
        )
        order by
          v.effective_from,
          v.id
      ),
      '[]'::jsonb
    )
  into v_versions
  from
    app.pos_map_versions v
  where
    v.subject_id = v_subject
    and v.superseded_change_id is null;

  return pg_catalog.jsonb_build_object(
    'subject_id',
    v_subject,
    'identity',
    v_identity,
    'token',
    app.pos_map_token ('base', v_item, v_key, null, null),
    'empty_token',
    pg_catalog.md5 (v_identity),
    'versions',
    v_versions
  );
end;
$$;

comment on function app.pos_base_schedule (text, jsonb) is 'Owner read of one base subject: identity, concurrency token, empty-schedule token, and every non-superseded mapping, policy and exception.';

create function app.pos_option_schedule (
  p_scope text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_option_value text
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_value text;
  v_identity text;
  v_subject uuid;
  v_versions jsonb;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_scope is null
  or p_scope not in ('global', 'item') then
    raise exception 'scope must be global or item'
      using errcode = '22023';
  end if;

  v_value := app.pos_text_id (p_option_value, 'option value');

  if p_scope = 'global' then
    if nullif(btrim(p_pos_item_id), '') is not null
    or (
      p_size_key is not null
      and pg_catalog.jsonb_typeof (p_size_key) is distinct from 'null'
    ) then
      raise exception 'a global option mapping has no item or size'
        using errcode = '22023';
    end if;

    v_item := null;
    v_key := null;
  else
    v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
    v_key := app.pos_size_key_normalize (p_size_key);
  end if;

  v_identity := app.pos_map_identity ('option', v_item, v_key, p_scope, v_value);
  v_subject := app.pos_map_subject_id ('option', v_item, v_key, p_scope, v_value);

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',
          v.id,
          'family',
          v.family,
          'effective_from',
          v.effective_from,
          'effective_to',
          v.effective_to,
          'target_kind',
          v.target_kind,
          'recipe_id',
          v.recipe_id,
          'stock_item_id',
          v.stock_item_id,
          'quantity_per_basis',
          pg_catalog.to_jsonb (pg_catalog.trim_scale (v.quantity_per_basis)::text),
          'unit_code',
          v.unit_code,
          'exception_reason',
          v.exception_reason,
          'option_policy',
          v.option_policy
        )
        order by
          v.effective_from,
          v.id
      ),
      '[]'::jsonb
    )
  into v_versions
  from
    app.pos_map_versions v
  where
    v.subject_id = v_subject
    and v.superseded_change_id is null;

  return pg_catalog.jsonb_build_object(
    'subject_id',
    v_subject,
    'identity',
    v_identity,
    'token',
    app.pos_map_token ('option', v_item, v_key, p_scope, v_value),
    'empty_token',
    pg_catalog.md5 (v_identity),
    'versions',
    v_versions
  );
end;
$$;

comment on function app.pos_option_schedule (text, text, jsonb, text) is 'Owner read of one option subject, global or scoped to a base subject. The token is the empty-schedule token until the first version.';

-- ============================================================================
-- J. Line requirements. Fractions stay exact in the internal result so a later
-- order total can sum lines before the one rounding. The owner wrapper rounds
-- once to 6 places and is the only place that emits below_precision.
-- ============================================================================
create function app.pos_map_merge_req (p_dst jsonb, p_src jsonb) returns jsonb language plpgsql stable
set
  search_path = '' as $$
declare
  v_out jsonb := coalesce(p_dst, '[]'::jsonb);
  v_src jsonb;
  v_next jsonb;
  v_row jsonb;
  v_num numeric;
  v_den numeric;
  v_hit boolean;
begin
  if p_src is null then
    return v_out;
  end if;

  for v_src in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements (p_src) as e
  loop
    v_next := '[]'::jsonb;
    v_hit := false;

    for v_row in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements (v_out) as e
    loop
      if v_row ->> 'stock_item_id' = v_src ->> 'stock_item_id' then
        if (v_row ->> 'base_unit') is distinct from (v_src ->> 'base_unit') then
          raise exception 'stock item % has two base units on one line', v_src ->> 'stock_item_id'
            using errcode = '55000';
        end if;

        v_num := (v_row ->> 'numerator')::numeric * (v_src ->> 'denominator')::numeric + (v_src ->> 'numerator')::numeric * (v_row ->> 'denominator')::numeric;
        v_den := (v_row ->> 'denominator')::numeric * (v_src ->> 'denominator')::numeric;
        v_next := v_next || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'stock_item_id',
            v_src ->> 'stock_item_id',
            'base_unit',
            v_src ->> 'base_unit',
            'numerator',
            v_num,
            'denominator',
            v_den
          )
        );
        v_hit := true;
      else
        v_next := v_next || pg_catalog.jsonb_build_array(v_row);
      end if;
    end loop;

    if not v_hit then
      v_next := v_next || pg_catalog.jsonb_build_array(v_src);
    end if;

    v_out := v_next;
  end loop;

  return v_out;
end;
$$;

create function app.pos_map_expand_target (
  p_target_kind text,
  p_recipe_id uuid,
  p_stock_item_id uuid,
  p_quantity numeric,
  p_unit text,
  p_at timestamptz,
  p_weighted boolean,
  p_role text,
  p_scale_num numeric,
  p_scale_den numeric
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_recipe_kind text;
  v_item_kind text;
  v_base text;
  v_walk jsonb;
  v_exact jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_reqs jsonb := '[]'::jsonb;
  v_versions jsonb := '[]'::jsonb;
  v_factor numeric;
  v_loss numeric;
  v_apply_loss boolean := false;
  v_num numeric;
  v_den numeric;
begin
  if p_scale_num is null
  or p_scale_den is null
  or p_scale_num < 0
  or p_scale_den <= 0
  or p_scale_num in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_scale_den in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'scale must be finite and at least 0'
      using errcode = '22023';
  end if;

  if p_target_kind = 'recipe' then
    select
      r.kind
    into v_recipe_kind
    from
      app.recipes r
    where
      r.id = p_recipe_id;

    if v_recipe_kind is null then
      raise exception 'unknown recipe id: %', p_recipe_id
        using errcode = '22023';
    end if;

    if v_recipe_kind = 'batch'
    or (
      v_recipe_kind = 'cooking'
      and (
        p_role is distinct from 'option'
        or not p_weighted
      )
    ) then
      v_issues := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'target_kind_mismatch',
          'recipe_id',
          p_recipe_id,
          'recipe_kind',
          v_recipe_kind
        )
      );
    elsif p_scale_num = 0 then
      v_walk := app.recipe_walk (p_recipe_id, p_at, 1, true, 1);
      v_versions := coalesce(v_walk -> 'versions', '[]'::jsonb);

      if pg_catalog.jsonb_array_length (v_walk -> 'issues') > 0 then
        v_issues := pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'blocked_recipe',
            'recipe_id',
            p_recipe_id,
            'expand_issue',
            (v_walk -> 'issues') -> 0 ->> 'code',
            'expand_issues',
            v_walk -> 'issues'
          )
        );
      end if;
    else
      v_exact := app.recipe_expand_exact (p_recipe_id, p_at, p_scale_num, p_scale_den);
      v_versions := coalesce(v_exact -> 'provenance' -> 'versions', '[]'::jsonb);

      if v_exact ->> 'status' is distinct from 'ready' then
        v_issues := pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'blocked_recipe',
            'recipe_id',
            p_recipe_id,
            'expand_issue',
            (v_exact -> 'issues') -> 0 ->> 'code',
            'expand_issues',
            v_exact -> 'issues'
          )
        );
      else
        v_reqs := coalesce(v_exact -> 'requirements', '[]'::jsonb);
      end if;
    end if;
  elsif p_target_kind = 'stock' then
    select
      si.kind,
      si.base_unit
    into v_item_kind,
      v_base
    from
      app.stock_items si
    where
      si.id = p_stock_item_id;

    if v_item_kind is null then
      raise exception 'unknown stock_item id: %', p_stock_item_id
        using errcode = '22023';
    end if;

    begin
      v_factor := app.item_factor_at (p_stock_item_id, p_unit, p_at);
    exception
      when sqlstate '22023' then
        v_factor := null;
    end;

    if v_factor is null then
      v_issues := v_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'unit_not_convertible',
          'stock_item_id',
          p_stock_item_id,
          'unit',
          p_unit
        )
      );
    end if;

    v_apply_loss := (not p_weighted)
    and v_item_kind in ('seafood', 'fish_size');

    if v_apply_loss then
      v_loss := app.item_loss_at (p_stock_item_id, p_at);

      if v_loss is null then
        v_issues := v_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'loss_not_set',
            'stock_item_id',
            p_stock_item_id
          )
        );
      end if;
    end if;

    if pg_catalog.jsonb_array_length (v_issues) = 0
    and p_scale_num > 0 then
      v_num := p_scale_num * p_quantity * v_factor;
      v_den := p_scale_den;

      if v_apply_loss then
        v_den := v_den * (1 - v_loss);
      end if;

      v_reqs := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          p_stock_item_id,
          'base_unit',
          v_base,
          'numerator',
          v_num,
          'denominator',
          v_den
        )
      );
    end if;
  else
    raise exception 'internal mapping target %', p_target_kind
      using errcode = '55000';
  end if;

  if pg_catalog.jsonb_array_length (v_issues) > 0 then
    v_reqs := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'issues',
    v_issues,
    'requirements',
    v_reqs,
    'recipe_versions',
    v_versions
  );
end;
$$;

create function app.pos_map_option_at (
  p_pos_item_id text,
  p_size_key jsonb,
  p_value text,
  p_at timestamptz,
  p_weighted boolean,
  p_scale_num numeric,
  p_scale_den numeric
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_id uuid;
  v_kind text;
  v_recipe uuid;
  v_stock uuid;
  v_qty numeric;
  v_unit text;
  v_scope text;
  v_expanded jsonb;
  v_state text;
  v_issues jsonb := '[]'::jsonb;
begin
  select
    v.id,
    v.target_kind,
    v.recipe_id,
    v.stock_item_id,
    v.quantity_per_basis,
    v.unit_code
  into v_id,
    v_kind,
    v_recipe,
    v_stock,
    v_qty,
    v_unit
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'option'
    and s.option_scope = 'item'
    and s.pos_item_id = p_pos_item_id
    and s.size_key = p_size_key
    and s.option_value = p_value
    and v.family = 'mapping'
    and v.superseded_change_id is null
    and v.valid_during @> p_at
  limit
    1;

  if found then
    v_scope := 'item';
  else
    select
      v.id,
      v.target_kind,
      v.recipe_id,
      v.stock_item_id,
      v.quantity_per_basis,
      v.unit_code
    into v_id,
      v_kind,
      v_recipe,
      v_stock,
      v_qty,
      v_unit
    from
      app.pos_map_versions v
      join app.pos_map_subjects s on s.id = v.subject_id
    where
      s.kind = 'option'
      and s.option_scope = 'global'
      and s.option_value = p_value
      and s.pos_item_id is null
      and s.size_key is null
      and v.family = 'mapping'
      and v.superseded_change_id is null
      and v.valid_during @> p_at
    limit
      1;

    if found
    and v_kind is distinct from 'unmapped' then
      v_scope := 'global';
    else
      if found then
        v_scope := 'global';
      end if;

      return pg_catalog.jsonb_strip_nulls (
        pg_catalog.jsonb_build_object(
          'role',
          'option',
          'pos_item_id',
          p_pos_item_id,
          'size_key',
          p_size_key,
          'option_value',
          p_value,
          'scope',
          v_scope,
          'state',
          'unmapped',
          'mapping_version_id',
          v_id,
          'issues',
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_strip_nulls (
              pg_catalog.jsonb_build_object(
                'code',
                'unmapped_option',
                'role',
                'option',
                'option_value',
                p_value,
                'scope',
                v_scope
              )
            )
          ),
          'requirements',
          null,
          'recipe_versions',
          '[]'::jsonb
        )
      );
    end if;
  end if;

  if v_kind = 'unmapped' then
    v_state := 'unmapped';
    v_issues := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'unmapped_option',
        'role',
        'option',
        'option_value',
        p_value,
        'scope',
        v_scope
      )
    );
  elsif v_kind = 'no_stock' then
    v_state := 'no_stock';
  else
    v_expanded := app.pos_map_expand_target (
      v_kind,
      v_recipe,
      v_stock,
      v_qty,
      v_unit,
      p_at,
      p_weighted,
      'option',
      p_scale_num,
      p_scale_den
    );
    v_issues := v_expanded -> 'issues';
    v_state := case
      when pg_catalog.jsonb_array_length (v_issues) = 0 then 'mapped'
      else 'blocked'
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'role',
    'option',
    'pos_item_id',
    p_pos_item_id,
    'size_key',
    p_size_key,
    'option_value',
    p_value,
    'scope',
    v_scope,
    'state',
    v_state,
    'mapping_version_id',
    v_id,
    'issues',
    v_issues,
    'requirements',
    case
      when v_kind = 'no_stock' then '[]'::jsonb
      when v_expanded is null then null
      else v_expanded -> 'requirements'
    end,
    'recipe_versions',
    coalesce(v_expanded -> 'recipe_versions', '[]'::jsonb)
  );
end;
$$;

create function app.resolve_line_requirements_exact (p_order_id text, p_line_id text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_name text;
  v_ordered timestamptz;
  v_qty numeric;
  v_weighted numeric;
  v_weighted_unit text;
  v_options jsonb;
  v_key jsonb;
  v_map_id uuid;
  v_map_kind text;
  v_map_recipe uuid;
  v_map_stock uuid;
  v_map_qty numeric;
  v_map_unit text;
  v_exc_id uuid;
  v_policy text;
  v_policy_id uuid;
  v_weighted_line boolean;
  v_scale_num numeric;
  v_scale_den numeric;
  v_unit_code text;
  v_ratio_num numeric;
  v_ratio_den numeric;
  v_stop boolean := false;
  v_base_state text;
  v_base_issues jsonb := '[]'::jsonb;
  v_option_issues jsonb := '[]'::jsonb;
  v_option_subjects jsonb := '[]'::jsonb;
  v_reqs jsonb := '[]'::jsonb;
  v_map_versions jsonb := '[]'::jsonb;
  v_recipe_versions jsonb := '[]'::jsonb;
  v_expanded jsonb;
  v_piece jsonb;
  v_elem jsonb;
  v_values text[] := '{}'::text[];
  v_unresolved integer := 0;
  v_once integer := 0;
  v_distinct integer := 0;
  v_dup boolean := false;
  v_opt record;
  v_status text;
  v_sorted jsonb;
begin
  select
    l.item_id,
    l.item_name,
    o.ordered_at,
    l.quantity,
    l.weighted_qty,
    l.weighted_unit,
    l.options
  into v_item,
    v_name,
    v_ordered,
    v_qty,
    v_weighted,
    v_weighted_unit,
    v_options
  from
    app.pos_order_lines l
    join app.pos_orders o on o.id = l.order_id
  where
    l.order_id = p_order_id
    and l.line_id = p_line_id;

  if not found then
    raise exception 'unknown order line'
      using errcode = '22023';
  end if;

  v_key := app.pos_size_key (
    (
      select
        l.size_name
      from
        app.pos_order_lines l
      where
        l.order_id = p_order_id
        and l.line_id = p_line_id
    )
  );

  select
    v.id,
    v.target_kind,
    v.recipe_id,
    v.stock_item_id,
    v.quantity_per_basis,
    v.unit_code
  into v_map_id,
    v_map_kind,
    v_map_recipe,
    v_map_stock,
    v_map_qty,
    v_map_unit
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'mapping'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  select
    v.id
  into v_exc_id
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'exception'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  select
    v.id,
    v.option_policy
  into v_policy_id,
    v_policy
  from
    app.pos_map_versions v
    join app.pos_map_subjects s on s.id = v.subject_id
  where
    s.kind = 'base'
    and s.pos_item_id = v_item
    and s.size_key = v_key
    and v.family = 'option_policy'
    and v.superseded_change_id is null
    and v.valid_during @> v_ordered
  limit
    1;

  if v_map_id is not null
  and v_exc_id is not null then
    v_base_state := 'blocked';
    v_base_issues := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'exception_overlap',
        'role',
        'base',
        'pos_item_id',
        v_item,
        'size_key',
        v_key
      )
    );
    v_map_versions := pg_catalog.jsonb_build_array(v_map_id, v_exc_id);
    v_stop := true;
    v_status := 'incomplete';
  elsif v_exc_id is not null then
    v_base_state := 'exception';
    v_map_versions := pg_catalog.jsonb_build_array(v_exc_id);
    v_stop := true;
    v_status := 'exception';
  end if;

  v_weighted_line := v_weighted is not null;

  if not v_stop then
    if v_weighted_line then
      v_unit_code := app.resolve_unit_code (v_weighted_unit);

      if v_unit_code is null then
        v_scale_num := null;
      else
        select
          r.ratio_num,
          r.ratio_den
        into v_ratio_num,
          v_ratio_den
        from
          app.recipe_unit_ratio (v_unit_code, 'kg') r;

        if not found then
          v_scale_num := null;
        else
          v_scale_num := v_weighted * v_ratio_num;
          v_scale_den := v_ratio_den;
        end if;
      end if;

      if v_scale_num is null then
        v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'weighted_unit_invalid',
            'role',
            'base',
            'pos_item_id',
            v_item,
            'size_key',
            v_key
          )
        );

        if v_map_id is not null then
          v_map_versions := v_map_versions || pg_catalog.jsonb_build_array(v_map_id);
        end if;

        v_stop := true;
        v_base_state := 'blocked';
      end if;
    else
      v_scale_num := v_qty;
      v_scale_den := 1;
    end if;
  end if;

  if not v_stop
  and v_map_id is null then
    v_base_state := 'gap';
    v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'unmapped_base',
        'role',
        'base',
        'pos_item_id',
        v_item,
        'size_key',
        v_key
      )
    );
  elsif not v_stop then
    v_map_versions := v_map_versions || pg_catalog.jsonb_build_array(v_map_id);
    v_expanded := app.pos_map_expand_target (
      v_map_kind,
      v_map_recipe,
      v_map_stock,
      v_map_qty,
      v_map_unit,
      v_ordered,
      v_weighted_line,
      'base',
      v_scale_num,
      v_scale_den
    );
    v_base_issues := v_base_issues || coalesce(v_expanded -> 'issues', '[]'::jsonb);
    v_recipe_versions := v_recipe_versions || coalesce(v_expanded -> 'recipe_versions', '[]'::jsonb);

    if pg_catalog.jsonb_array_length (coalesce(v_expanded -> 'issues', '[]'::jsonb)) = 0 then
      v_base_state := 'mapped';
      v_reqs := app.pos_map_merge_req (v_reqs, v_expanded -> 'requirements');
    else
      v_base_state := 'blocked';
    end if;
  end if;

  if v_stop
  and v_map_id is null
  and v_status is distinct from 'exception'
  and v_status is distinct from 'incomplete' then
    v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code',
        'unmapped_base',
        'role',
        'base',
        'pos_item_id',
        v_item,
        'size_key',
        v_key
      )
    );
  end if;

  if not v_stop then
    if v_policy_id is null then
      v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'option_policy_missing',
          'role',
          'base',
          'pos_item_id',
          v_item,
          'size_key',
          v_key
        )
      );
    else
      v_map_versions := v_map_versions || pg_catalog.jsonb_build_array(v_policy_id);
    end if;

    for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements (v_options) as e
    loop
      if pg_catalog.jsonb_typeof (v_elem) is distinct from 'object'
      or nullif(btrim(v_elem ->> 'value'), '') is null then
        v_unresolved := v_unresolved + 1;
      else
        v_values := pg_catalog.array_append(v_values, btrim(v_elem ->> 'value'));
      end if;
    end loop;

    select
      count(*) filter (
        where
          n = 1
      ),
      count(*),
      bool_or(n > 1)
    into v_once,
      v_distinct,
      v_dup
    from
      (
        select
          count(*) as n
        from
          pg_catalog.unnest (v_values) as u (val)
        group by
          val
      ) c;

    v_once := coalesce(v_once, 0);
    v_distinct := coalesce(v_distinct, 0);
    v_dup := coalesce(v_dup, false);

    if v_policy = 'none_expected' then
      if v_unresolved > 0
      or coalesce(pg_catalog.cardinality (v_values), 0) > 0 then
        v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'option_policy_violation',
            'role',
            'base',
            'policy',
            v_policy
          )
        );
      end if;
    elsif v_policy = 'exactly_one' then
      if v_once <> 1
      or v_unresolved > 0
      or v_dup then
        v_base_issues := v_base_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'option_policy_violation',
            'role',
            'base',
            'policy',
            v_policy
          )
        );
      end if;
    end if;

    if v_unresolved > 0
    and v_policy is distinct from 'none_expected' then
      v_option_issues := v_option_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'unresolved_option',
          'role',
          'option'
        )
      );
      v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'role',
          'option',
          'pos_item_id',
          v_item,
          'size_key',
          v_key,
          'state',
          'unresolved',
          'issues',
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'code',
              'unresolved_option',
              'role',
              'option'
            )
          )
        )
      );
    elsif v_unresolved > 0 then
      v_option_issues := v_option_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'unresolved_option',
          'role',
          'option'
        )
      );
    end if;

    for v_opt in
    select
      u.val,
      count(*) as n
    from
      pg_catalog.unnest (v_values) with ordinality as u (val, ord)
    group by
      u.val
    order by
      min(u.ord)
    loop
      if v_opt.n > 1 then
        v_option_issues := v_option_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'ambiguous_option',
            'role',
            'option',
            'option_value',
            v_opt.val
          )
        );
        v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'role',
            'option',
            'pos_item_id',
            v_item,
            'size_key',
            v_key,
            'option_value',
            v_opt.val,
            'state',
            'ambiguous',
            'issues',
            pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'code',
                'ambiguous_option',
                'role',
                'option',
                'option_value',
                v_opt.val
              )
            )
          )
        );
      elsif v_policy = 'none_expected' then
        v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'role',
            'option',
            'pos_item_id',
            v_item,
            'size_key',
            v_key,
            'option_value',
            v_opt.val,
            'state',
            'ignored',
            'issues',
            '[]'::jsonb
          )
        );
      else
        v_piece := app.pos_map_option_at (
          v_item,
          v_key,
          v_opt.val,
          v_ordered,
          v_weighted_line,
          v_scale_num,
          v_scale_den
        );
        v_option_issues := v_option_issues || coalesce(v_piece -> 'issues', '[]'::jsonb);
        v_recipe_versions := v_recipe_versions || coalesce(v_piece -> 'recipe_versions', '[]'::jsonb);

        if v_piece ->> 'mapping_version_id' is not null then
          v_map_versions := v_map_versions || pg_catalog.jsonb_build_array((v_piece ->> 'mapping_version_id')::uuid);
        end if;

        if pg_catalog.jsonb_array_length (coalesce(v_piece -> 'issues', '[]'::jsonb)) = 0
        and v_piece -> 'requirements' is not null
        and pg_catalog.jsonb_typeof (v_piece -> 'requirements') = 'array' then
          v_reqs := app.pos_map_merge_req (v_reqs, v_piece -> 'requirements');
        end if;

        v_option_subjects := v_option_subjects || pg_catalog.jsonb_build_array(v_piece - 'requirements' - 'recipe_versions');
      end if;
    end loop;
  end if;

  if v_status is null then
    if pg_catalog.jsonb_array_length (v_base_issues || v_option_issues) > 0 then
      v_status := 'incomplete';
    else
      v_status := 'ready';
    end if;
  end if;

  if v_status = 'ready' then
    select
      coalesce(
        pg_catalog.jsonb_agg(
          e.value
          order by
            e.value ->> 'stock_item_id'
        ),
        '[]'::jsonb
      )
    into v_sorted
    from
      pg_catalog.jsonb_array_elements (v_reqs) as e;
  else
    v_sorted := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    v_status,
    'requirements',
    v_sorted,
    'subjects',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_strip_nulls (
        pg_catalog.jsonb_build_object(
          'role',
          'base',
          'pos_item_id',
          v_item,
          'size_key',
          v_key,
          'item_name',
          v_name,
          'state',
          v_base_state,
          'mapping_version_id',
          v_map_id,
          'policy',
          v_policy,
          'policy_version_id',
          v_policy_id,
          'issues',
          v_base_issues
        )
      )
    ) || v_option_subjects,
    'issues',
    v_base_issues || v_option_issues,
    'provenance',
    pg_catalog.jsonb_build_object(
      'at',
      app.costing_timestamptz_text (v_ordered),
      'algorithm_version',
      1,
      'mapping_versions',
      v_map_versions,
      'recipe_versions',
      v_recipe_versions
    )
  );
end;
$$;

comment on function app.resolve_line_requirements_exact (text, text) is 'Internal line lookup. Requirements are exact fractions in the stock base unit, or null when the line is incomplete or an exception. Nothing is rounded. PR 7 aggregates these fractions before rounding. Revoked from API roles.';

create function app.resolve_line_requirements (p_order_id text, p_line_id text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_exact jsonb;
  v_requirements jsonb;
  v_below jsonb;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_exact := app.resolve_line_requirements_exact (p_order_id, p_line_id);

  if v_exact ->> 'status' is distinct from 'ready' then
    return v_exact;
  end if;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          e.value ->> 'stock_item_id',
          'base_unit',
          e.value ->> 'base_unit',
          'quantity',
          (
            pg_catalog.div(
              2 * (e.value ->> 'numerator')::numeric * 1000000 + (e.value ->> 'denominator')::numeric,
              2 * (e.value ->> 'denominator')::numeric
            ) * 0.000001
          )::numeric(20, 6)
        )
        order by
          e.value ->> 'stock_item_id'
      ),
      '[]'::jsonb
    )
  into v_requirements
  from
    pg_catalog.jsonb_array_elements (v_exact -> 'requirements') as e;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'code',
          'below_precision',
          'stock_item_id',
          e.value ->> 'stock_item_id'
        )
        order by
          e.value ->> 'stock_item_id'
      ),
      '[]'::jsonb
    )
  into v_below
  from
    pg_catalog.jsonb_array_elements (v_exact -> 'requirements') as e
  where
    (e.value ->> 'numerator')::numeric > 0
    and pg_catalog.div(
      2 * (e.value ->> 'numerator')::numeric * 1000000 + (e.value ->> 'denominator')::numeric,
      2 * (e.value ->> 'denominator')::numeric
    ) = 0;

  if pg_catalog.jsonb_array_length (v_below) > 0 then
    return pg_catalog.jsonb_build_object(
      'status',
      'incomplete',
      'requirements',
      null,
      'subjects',
      v_exact -> 'subjects',
      'issues',
      (v_exact -> 'issues') || v_below,
      'provenance',
      v_exact -> 'provenance'
    );
  end if;

  return v_exact || pg_catalog.jsonb_build_object('requirements', v_requirements);
end;
$$;

comment on function app.resolve_line_requirements (text, text) is 'Owner lookup of one POS line at its ordered_at. status is ready, incomplete, or exception. Requirements are raw stock quantities rounded once to 6 places, or null when the line is not ready. A positive total that rounds to 0 is below_precision and incomplete.';

-- ============================================================================
-- K. Coverage. The period is the shifts that opened in it. A line counts only
-- when its quantity or weighted quantity is positive. Eligible lines are
-- complete, not missing, and at or after the earliest opening. Exceptions
-- count as covered. An empty eligible set has a null ratio.
-- ============================================================================
create function app.pos_mapping_coverage (p_from timestamptz, p_to timestamptz) returns jsonb language plpgsql stable security definer
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

  select
    min(o.occurred_at)
  into v_start
  from
    app.opening_stocks o;

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
    coalesce(v_subjects, '[]'::jsonb)
  );
end;
$$;

comment on function app.pos_mapping_coverage (timestamptz, timestamptz) is 'Owner coverage for shifts that opened in [p_from, p_to). A line counts only when its quantity or weighted quantity is positive. Eligible lines are complete, not missing, and at or after the first opening. Covered lines are ready plus exception. The ratio is null when nothing is eligible. Canceled, open, missing and pre-start lines are causes, not part of the ratio.';

-- ============================================================================
-- L. Suggestions. Name folding matches the workbook import. Nothing is saved.
-- ============================================================================
create function app.suggest_pos_mappings (p_name text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_key text;
  v_rows jsonb;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_key := app.pos_name_key (p_name);

  if v_key = '' then
    return '[]'::jsonb;
  end if;

  with
    name_hits as (
      select
        r.id,
        r.name,
        'name'::text as via
      from
        app.recipes r
      where
        app.pos_name_key (r.name) = v_key
    ),
    binding_hits as (
      select
        r.id,
        r.name,
        'binding'::text as via
      from
        (
          select distinct
            on (b.source_name) b.recipe_id
          from
            app.recipe_import_bindings b
          where
            b.source_name = v_key
            and b.recipe_id is not null
          order by
            b.source_name,
            b.created_at desc,
            b.id desc
        ) latest
        join app.recipes r on r.id = latest.recipe_id
    )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recipe_id',
          d.id,
          'name',
          d.name,
          'via',
          d.via
        )
        order by
          d.name,
          d.id
      ),
      '[]'::jsonb
    )
  into v_rows
  from
    (
      select
        u.id,
        u.name,
        case
          when bool_or(u.via = 'name') then 'name'
          else 'binding'
        end as via
      from
        (
          select
            *
          from
            name_hits
          union all
          select
            *
          from
            binding_hits
        ) u
      group by
        u.id,
        u.name
    ) d;

  return v_rows;
end;
$$;

comment on function app.suggest_pos_mappings (text) is 'Suggests recipes whose normalised name matches, or whose latest import binding uses that source name. Teh marbuta stays distinct from heh. Nothing is written. Owner only.';

-- ============================================================================
-- M. Observed subjects. Sale counts include every stored line. List status is
-- how the latest line resolves, so a gap or a broken recipe shows incomplete.
-- ============================================================================
create view app.pos_observed_bases
with
  (security_invoker = true) as
select
  g.pos_item_id,
  g.size_key,
  g.size_key::text as size_key_text,
  g.item_name,
  g.sale_count,
  g.last_ordered_at,
  g.latest_order_id,
  g.latest_line_id,
  app.resolve_line_requirements (g.latest_order_id, g.latest_line_id) ->> 'status' as map_status
from
  (
    select
      l.item_id as pos_item_id,
      app.pos_size_key (l.size_name) as size_key,
      (
        pg_catalog.array_agg (
          l.item_name
          order by
            o.ordered_at desc,
            o.id desc,
            l.line_id desc
        )
      ) [1] as item_name,
      count(*)::bigint as sale_count,
      max(o.ordered_at) as last_ordered_at,
      (
        pg_catalog.array_agg (
          l.order_id
          order by
            o.ordered_at desc,
            o.id desc,
            l.line_id desc
        )
      ) [1] as latest_order_id,
      (
        pg_catalog.array_agg (
          l.line_id
          order by
            o.ordered_at desc,
            o.id desc,
            l.line_id desc
        )
      ) [1] as latest_line_id
    from
      app.pos_order_lines l
      join app.pos_orders o on o.id = l.order_id
    group by
      l.item_id,
      app.pos_size_key (l.size_name)
  ) g;

comment on view app.pos_observed_bases is 'Base subjects seen on stored POS lines. sale_count is every line. map_status is the latest line: ready, incomplete, or exception. Security invoker.';

create view app.pos_observed_options
with
  (security_invoker = true) as
select
  l.item_id as pos_item_id,
  app.pos_size_key (l.size_name) as size_key,
  app.pos_size_key (l.size_name)::text as size_key_text,
  coalesce(nullif(btrim(e.value ->> 'value'), ''), '') as option_value,
  count(*)::bigint as seen_count
from
  app.pos_order_lines l
  cross join lateral pg_catalog.jsonb_array_elements (l.options) as e (value)
group by
  l.item_id,
  app.pos_size_key (l.size_name),
  coalesce(nullif(btrim(e.value ->> 'value'), ''), '');

comment on view app.pos_observed_options is 'Option values seen on stored lines of one base subject. A blank value is the empty string and is unresolved. Security invoker.';

-- ============================================================================
-- N. A direct mapping freezes stock identity the same way a recipe line does.
-- ============================================================================
create or replace function app.trg_stock_items_freeze_configured_identity () returns trigger language plpgsql security definer
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
  )
  or exists (
    select
      1
    from
      app.recipe_lines l
      join app.recipe_versions rv on rv.id = l.version_id
    where
      l.stock_item_id = old.id
      and rv.superseded_change_id is null
  )
  or exists (
    select
      1
    from
      app.pos_map_versions v
    where
      v.stock_item_id = old.id
      and v.family = 'mapping'
      and v.target_kind = 'stock'
      and v.superseded_change_id is null
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

comment on function app.trg_stock_items_freeze_configured_identity () is 'Rejects a base_unit, kind or parent_item_id change while the item has movements, a current loss, conversion or opening price, a line of a non-superseded recipe version, or a non-superseded direct POS mapping. Runs after trg_stock_items_configured_identity_lock, which holds the ledger lock.';

-- ============================================================================
-- O. RLS and grants. API roles can read as the owner. They cannot write.
-- Internal helpers stay revoked. pos_size_key is granted because the
-- security-invoker views call it as the owner.
-- ============================================================================
alter table app.pos_map_subjects enable row level security;

alter table app.pos_map_versions enable row level security;

create policy pos_map_subjects_select_owner on app.pos_map_subjects for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy pos_map_versions_select_owner on app.pos_map_versions for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.pos_map_subjects
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_map_versions
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.pos_map_subjects,
  app.pos_map_versions to authenticated,
  service_role;

revoke all on table app.pos_observed_bases
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_observed_options
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.pos_observed_bases,
  app.pos_observed_options to authenticated,
  service_role;

do $$
declare
  r record;
begin
  for r in
  select
    p.oid::regprocedure as sig
  from
    pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where
    n.nspname = 'app'
    and p.proname = any (
      array[
        'trg_pos_map_subjects_immutable',
        'trg_pos_map_versions_subject',
        'trg_pos_map_versions_overlap',
        'pos_size_key',
        'pos_size_key_normalize',
        'pos_name_key',
        'pos_text_id',
        'pos_map_identity',
        'pos_map_label',
        'pos_map_version_body',
        'pos_map_schedule_line',
        'pos_map_subject_id',
        'pos_map_token',
        'pos_map_assert_keys',
        'pos_map_target_normalize',
        'pos_map_assert_recipe',
        'insert_mapping_costing_change',
        'pos_map_apply',
        'pos_map_with_subject',
        'pos_map_merge_req',
        'pos_map_expand_target',
        'pos_map_option_at',
        'resolve_line_requirements_exact',
        'set_pos_base_mapping',
        'set_pos_option_policy',
        'set_pos_exception',
        'set_pos_option_mapping',
        'pos_base_schedule',
        'pos_option_schedule',
        'resolve_line_requirements',
        'pos_mapping_coverage',
        'suggest_pos_mappings'
      ]
    )
  loop
    execute pg_catalog.format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      r.sig
    );
  end loop;
end;
$$;

grant
execute on function app.pos_size_key (text) to authenticated;

grant
execute on function app.set_pos_base_mapping (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
),
app.set_pos_option_policy (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  text,
  text,
  text
),
app.set_pos_exception (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  text,
  text,
  text
),
app.set_pos_option_mapping (
  uuid,
  text,
  text,
  jsonb,
  text,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
),
app.pos_base_schedule (text, jsonb),
app.pos_option_schedule (text, text, jsonb, text),
app.resolve_line_requirements (text, text),
app.pos_mapping_coverage (timestamptz, timestamptz),
app.suggest_pos_mappings (text) to authenticated;
