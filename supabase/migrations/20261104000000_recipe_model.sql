-- Recipe model (phase 4, PR 3). Additive, plus the stock item identity freeze.
--
-- Recipes have a stable identity and dated versions. Three kinds: a dish
-- (one portion), a cooking recipe (per 1 kg of scale weight of the sold fish),
-- and a batch (an intermediate preparation, never stock). Lines state a NET
-- quantity of a raw stock item, or a quantity of a child batch. Loss lives only
-- on the raw item and is applied once, at the leaf. Nothing here writes the
-- stock ledger and nothing here prices a recipe.
--
-- Writers take advisory lock 7342750000000000001 before any recipe or item
-- row lock, the same key as posting and the other costing writers.
-- ============================================================================
-- A. Tables. Version rows follow the costing_foundation shape: half-open
-- [effective_from, effective_to), non-overlapping while not superseded.
-- ============================================================================
create table app.recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null,
  active boolean not null default true,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  constraint recipes_name_key unique (name),
  constraint recipes_name_chk check (
    name = btrim(name)
    and length(name) between 1 and 120
  ),
  constraint recipes_kind_chk check (kind in ('dish', 'cooking', 'batch'))
);

comment on table app.recipes is 'Recipe identity. kind is part of the identity and never changes. name and active are editable by the owner and are not dated.';

create index recipes_created_change_idx on app.recipes (created_change_id);

create table app.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  effective_from timestamptz not null,
  effective_to timestamptz null,
  valid_during tstzrange generated always as (tstzrange (effective_from, effective_to, '[)')) stored,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  superseded_change_id bigint null references app.costing_changes (id) on delete restrict,
  recipe_id uuid not null references app.recipes (id) on delete restrict,
  batch_qty numeric null,
  batch_unit text null references app.units (code) on delete restrict,
  constraint recipe_versions_effective_from_finite_chk check (pg_catalog.isfinite (effective_from)),
  constraint recipe_versions_effective_to_chk check (
    effective_to is null
    or (
      pg_catalog.isfinite (effective_to)
      and effective_to > effective_from
    )
  ),
  constraint recipe_versions_batch_qty_chk check (
    batch_qty is null
    or (
      batch_qty <> 'NaN'::numeric
      and batch_qty <> 'Infinity'::numeric
      and batch_qty <> '-Infinity'::numeric
      and batch_qty > 0
    )
  ),
  constraint recipe_versions_batch_pair_chk check ((batch_qty is null) = (batch_unit is null)),
  constraint recipe_versions_no_overlap exclude using gist (
    recipe_id extensions.gist_uuid_ops
    with
      =,
      valid_during
    with
      &&
  )
  where
    (superseded_change_id is null)
);

comment on table app.recipe_versions is 'Dated version of one recipe. Non-superseded intervals do not overlap. A gap means nothing is in force: callers must block, never cost it as zero. batch_qty and batch_unit are set exactly when the recipe kind is batch.';

create index recipe_versions_recipe_from_idx on app.recipe_versions (recipe_id, effective_from);

create index recipe_versions_created_change_idx on app.recipe_versions (created_change_id);

create index recipe_versions_superseded_change_idx on app.recipe_versions (superseded_change_id)
where
  superseded_change_id is not null;

create table app.recipe_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references app.recipe_versions (id) on delete restrict,
  line_no integer not null,
  stock_item_id uuid null references app.stock_items (id) on delete restrict,
  child_recipe_id uuid null references app.recipes (id) on delete restrict,
  quantity numeric not null,
  unit text not null references app.units (code) on delete restrict,
  constraint recipe_lines_line_no_chk check (line_no >= 1),
  constraint recipe_lines_version_line_key unique (version_id, line_no),
  constraint recipe_lines_one_target_chk check (
    (stock_item_id is null) <> (child_recipe_id is null)
  ),
  constraint recipe_lines_quantity_chk check (
    quantity <> 'NaN'::numeric
    and quantity <> 'Infinity'::numeric
    and quantity <> '-Infinity'::numeric
    and quantity > 0
  )
);

comment on table app.recipe_lines is 'Immutable line of one recipe version. Exactly one target: a raw stock item (quantity is NET of loss, in unit) or a child batch recipe (quantity in the batch unit or a same-dimension metric unit). unit is a resolved unit code.';

create index recipe_lines_stock_item_idx on app.recipe_lines (stock_item_id)
where
  stock_item_id is not null;

create index recipe_lines_child_recipe_idx on app.recipe_lines (child_recipe_id)
where
  child_recipe_id is not null;

-- ============================================================================
-- B. Immutability and defence triggers. Rows are written only by the recipe
-- writers, which have already validated them; these triggers back that up.
-- ============================================================================
create function app.trg_recipes_guard () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'app.recipes rows are immutable; DELETE is not allowed'
      using errcode = '55000';
  end if;

  if new.id is distinct from old.id
  or new.kind is distinct from old.kind
  or new.created_change_id is distinct from old.created_change_id then
    raise exception 'app.recipes id, kind, and created_change_id are immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger trg_recipes_guard
before update or delete on app.recipes for each row
execute function app.trg_recipes_guard ();

create trigger trg_recipes_no_truncate
before truncate on app.recipes for each statement
execute function app.trg_version_no_truncate ();

create function app.trg_recipe_versions_batch_fields () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_kind text;
begin
  select
    r.kind
  into v_kind
  from
    app.recipes r
  where
    r.id = new.recipe_id;

  if v_kind = 'batch'
  and new.batch_qty is null then
    raise exception 'a batch recipe version requires batch_qty and batch_unit'
      using errcode = '23514';
  end if;

  if v_kind is distinct from 'batch'
  and new.batch_qty is not null then
    raise exception 'only a batch recipe version carries batch_qty and batch_unit'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_recipe_versions_batch_fields
before insert on app.recipe_versions for each row
execute function app.trg_recipe_versions_batch_fields ();

create trigger trg_recipe_versions_supersede_only
before update or delete on app.recipe_versions for each row
execute function app.trg_version_supersede_only ();

create trigger trg_recipe_versions_no_truncate
before truncate on app.recipe_versions for each statement
execute function app.trg_version_no_truncate ();

create function app.trg_recipe_lines_target () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_kind text;
begin
  if new.stock_item_id is not null then
    select
      si.kind
    into v_kind
    from
      app.stock_items si
    where
      si.id = new.stock_item_id;

    if v_kind in ('packaging', 'fish_mixed') then
      raise exception 'packaging and fish_mixed items cannot be recipe leaves'
        using errcode = '23514';
    end if;
  else
    select
      r.kind
    into v_kind
    from
      app.recipes r
    where
      r.id = new.child_recipe_id;

    if v_kind is distinct from 'batch' then
      raise exception 'only a batch recipe can be a child of a recipe line'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_recipe_lines_target
before insert on app.recipe_lines for each row
execute function app.trg_recipe_lines_target ();

create function app.trg_recipe_lines_immutable () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.recipe_lines is immutable; % is not allowed', tg_op
    using errcode = '55000';
end;
$$;

create trigger trg_recipe_lines_immutable
before update or delete on app.recipe_lines for each row
execute function app.trg_recipe_lines_immutable ();

create trigger trg_recipe_lines_no_truncate
before truncate on app.recipe_lines for each statement
execute function app.trg_version_no_truncate ();

-- ============================================================================
-- C. Small helpers. The schedule token line is id|UTC from|UTC to|batch_qty|
-- batch_unit. Lines are immutable per version id, so the id already commits
-- to them. recipe_schedule inlines the same line because it is security
-- invoker and cannot call these helpers.
-- ============================================================================
create function app.recipe_schedule_line (
  p_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_batch_qty numeric,
  p_batch_unit text
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
    ) || '|' || coalesce(pg_catalog.trim_scale(p_batch_qty)::text, '') || '|' || coalesce(p_batch_unit, '');
$$;

comment on function app.recipe_schedule_line (uuid, timestamptz, timestamptz, numeric, text) is 'One token line of a recipe schedule: id, UTC interval, batch quantity and batch unit. Internal.';

-- The recipe identity is its kind: kind|. An empty schedule still hashes it.
create function app.recipe_schedule_token (p_recipe_id uuid) returns text language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_identity text;
  v_token text;
begin
  select
    r.kind || '|'
  into v_identity
  from
    app.recipes r
  where
    r.id = p_recipe_id;

  if not found then
    raise exception 'unknown recipe id: %', p_recipe_id
      using errcode = '22023';
  end if;

  select
    pg_catalog.md5(
      v_identity || coalesce(
        string_agg(
          app.recipe_schedule_line (v.id, v.effective_from, v.effective_to, v.batch_qty, v.batch_unit),
          ','
          order by
            v.effective_from,
            v.id
        ),
        ''
      )
    )
  into v_token
  from
    app.recipe_versions v
  where
    v.recipe_id = p_recipe_id
    and v.superseded_change_id is null;

  return v_token;
end;
$$;

comment on function app.recipe_schedule_token (uuid) is 'md5 of kind| plus the ordered non-superseded version lines of one recipe. An empty schedule hashes the identity prefix alone. A missing recipe raises 22023. Internal.';

-- Factor from one unit to another: 1 for the same code, from.metric_scale /
-- to.metric_scale inside one mass or volume dimension, null for anything else.
create function app.recipe_unit_factor (p_from_unit text, p_to_unit text) returns numeric language sql stable security definer
set
  search_path = '' as $$
  select
    case
      when p_from_unit = p_to_unit then 1::numeric
      else (
        select
          f.metric_scale / t.metric_scale
        from
          app.units f
          join app.units t on t.code = p_to_unit
          and t.dimension = f.dimension
        where
          f.code = p_from_unit
          and f.dimension in ('mass', 'volume')
          and f.metric_scale is not null
          and t.metric_scale is not null
      )
    end;
$$;

comment on function app.recipe_unit_factor (text, text) is 'Implicit factor between two unit codes: 1 for the same code, the metric_scale ratio inside mass or volume, otherwise null. Internal.';

-- ============================================================================
-- D. Strict payload allowlist. Price-like keys are refused at any depth, then
-- every line must be an object with only the four known keys and scalar values.
-- ============================================================================
create function app.recipe_payload_assert_no_price_keys (p_node jsonb, p_depth integer) returns void language plpgsql stable
set
  search_path = '' as $$
declare
  v_key text;
  v_value jsonb;
begin
  if p_depth > 6 then
    raise exception 'recipe payload is nested too deeply'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_node) = 'object' then
    for v_key,
    v_value in
    select
      e.key,
      e.value
    from
      pg_catalog.jsonb_each(p_node) as e
    loop
      if pg_catalog.lower(v_key) in ('price', 'cost', 'unit_cost', 'amount')
      or v_key ilike '%price%'
      or v_key ilike '%cost%' then
        raise exception 'price-like key "%" is not allowed in a recipe payload', v_key
          using errcode = '22023';
      end if;

      perform app.recipe_payload_assert_no_price_keys (v_value, p_depth + 1);
    end loop;
  elsif pg_catalog.jsonb_typeof(p_node) = 'array' then
    for v_value in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_node) as e
    loop
      perform app.recipe_payload_assert_no_price_keys (v_value, p_depth + 1);
    end loop;
  end if;
end;
$$;

comment on function app.recipe_payload_assert_no_price_keys (jsonb, integer) is 'Raises 22023 when any object key at any depth is price, cost, unit_cost, amount, or contains price or cost (case-insensitive). Internal.';

-- Returns the canonical lines array stored in the replay payload:
-- [{stock_item_id, child_recipe_id, quantity, unit}], with the unit text as
-- sent. Units, targets and kinds are resolved later, after the replay check.
create function app.recipe_lines_normalize (p_lines jsonb) returns jsonb language plpgsql stable
set
  search_path = '' as $$
declare
  v_elem jsonb;
  v_key text;
  v_n integer := 0;
  v_out jsonb := '[]'::jsonb;
  v_stock_node jsonb;
  v_child_node jsonb;
  v_qty_node jsonb;
  v_unit_node jsonb;
  v_stock_id uuid;
  v_child_id uuid;
  v_qty numeric;
  v_unit text;
begin
  perform app.recipe_payload_assert_no_price_keys (p_lines, 0);

  if pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'lines must be a json array'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception 'lines must not be empty; send null to leave a gap'
      using errcode = '22023';
  end if;

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(p_lines) as e
  loop
    v_n := v_n + 1;

    if pg_catalog.jsonb_typeof(v_elem) is distinct from 'object' then
      raise exception 'line % must be a json object', v_n
        using errcode = '22023';
    end if;

    for v_key in
    select
      pg_catalog.jsonb_object_keys(v_elem)
    loop
      if v_key not in ('stock_item_id', 'child_recipe_id', 'quantity', 'unit') then
        raise exception 'unknown key "%" in line %', v_key, v_n
          using errcode = '22023';
      end if;
    end loop;

    v_stock_node := v_elem -> 'stock_item_id';
    v_child_node := v_elem -> 'child_recipe_id';
    v_qty_node := v_elem -> 'quantity';
    v_unit_node := v_elem -> 'unit';
    v_stock_id := null;
    v_child_id := null;

    if v_stock_node is not null
    and pg_catalog.jsonb_typeof(v_stock_node) <> 'null' then
      if pg_catalog.jsonb_typeof(v_stock_node) <> 'string' then
        raise exception 'stock_item_id in line % must be a uuid string', v_n
          using errcode = '22023';
      end if;

      begin
        v_stock_id := (v_stock_node #>> '{}')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'stock_item_id in line % must be a uuid string', v_n
            using errcode = '22023';
      end;
    end if;

    if v_child_node is not null
    and pg_catalog.jsonb_typeof(v_child_node) <> 'null' then
      if pg_catalog.jsonb_typeof(v_child_node) <> 'string' then
        raise exception 'child_recipe_id in line % must be a uuid string', v_n
          using errcode = '22023';
      end if;

      begin
        v_child_id := (v_child_node #>> '{}')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'child_recipe_id in line % must be a uuid string', v_n
            using errcode = '22023';
      end;
    end if;

    if (v_stock_id is null) = (v_child_id is null) then
      raise exception 'line % needs exactly one of stock_item_id and child_recipe_id', v_n
        using errcode = '22023';
    end if;

    if v_qty_node is null
    or pg_catalog.jsonb_typeof(v_qty_node) not in ('number', 'string') then
      raise exception 'quantity in line % must be a number', v_n
        using errcode = '22023';
    end if;

    begin
      v_qty := pg_catalog.btrim(v_qty_node #>> '{}')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'quantity in line % must be a number', v_n
          using errcode = '22023';
    end;

    if v_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or v_qty <= 0 then
      raise exception 'quantity in line % must be finite and greater than 0', v_n
        using errcode = '22023';
    end if;

    if v_unit_node is null
    or pg_catalog.jsonb_typeof(v_unit_node) <> 'string' then
      raise exception 'unit in line % must be text', v_n
        using errcode = '22023';
    end if;

    v_unit := pg_catalog.btrim(v_unit_node #>> '{}');

    if length(v_unit) not between 1 and 40 then
      raise exception 'unit in line % must be 1 to 40 characters', v_n
        using errcode = '22023';
    end if;

    v_out := v_out || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'stock_item_id',
        v_stock_id,
        'child_recipe_id',
        v_child_id,
        'quantity',
        pg_catalog.trim_scale(v_qty),
        'unit',
        v_unit
      )
    );
  end loop;

  return v_out;
end;
$$;

comment on function app.recipe_lines_normalize (jsonb) is 'Strict allowlist for recipe lines: a non-empty array of objects with only stock_item_id, child_recipe_id, quantity and unit, scalar values, exactly one target, a finite quantity above 0. Unknown and price-like keys raise 22023 at every level. Returns the canonical array. Internal.';

-- ============================================================================
-- E. The walk and the exact expansion. One walk serves two jobs:
-- p_validate = false costs the tree (loss at the leaf, unit conversion) and
-- reports loss_not_set / unit_not_convertible; p_validate = true checks the
-- publication rules only (cooking recipes never reach a marine leaf).
-- Cycles, depth above 8, a child with no version in force, and a batch line
-- in an unusable unit are issues in both modes. Nothing is truncated or rounded.
-- ============================================================================
create function app.recipe_walk (
  p_recipe_id uuid,
  p_at timestamptz,
  p_scale numeric,
  p_validate boolean
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  c_max_depth constant integer := 8;
  v_root_kind text;
  v_root_version uuid;
  v_versions uuid[] := '{}'::uuid[];
  v_versions_json jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_leaves jsonb := '[]'::jsonb;
  s_recipe uuid[] := '{}'::uuid[];
  s_version uuid[] := '{}'::uuid[];
  s_scale numeric[] := '{}'::numeric[];
  s_path jsonb[] := '{}'::jsonb[];
  s_depth integer[] := '{}'::integer[];
  v_n integer;
  v_recipe uuid;
  v_version uuid;
  v_scale numeric;
  v_path jsonb;
  v_depth integer;
  v_line record;
  v_item_kind text;
  v_item_base text;
  v_child_version uuid;
  v_child_qty numeric;
  v_child_unit text;
  v_unit_factor numeric;
  v_loss numeric;
  v_factor numeric;
  v_bad boolean;
begin
  select
    r.kind
  into v_root_kind
  from
    app.recipes r
  where
    r.id = p_recipe_id;

  if not found then
    raise exception 'unknown recipe id: %', p_recipe_id
      using errcode = '22023';
  end if;

  select
    v.id
  into v_root_version
  from
    app.recipe_versions v
  where
    v.recipe_id = p_recipe_id
    and v.superseded_change_id is null
    and v.valid_during @> p_at;

  if not found then
    return pg_catalog.jsonb_build_object(
      'leaves',
      '[]'::jsonb,
      'issues',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code',
          'no_version_in_force',
          'recipe_id',
          p_recipe_id,
          'path',
          pg_catalog.jsonb_build_array(p_recipe_id)
        )
      ),
      'versions',
      '[]'::jsonb
    );
  end if;

  s_recipe := pg_catalog.array_append(s_recipe, p_recipe_id);
  s_version := pg_catalog.array_append(s_version, v_root_version);
  s_scale := pg_catalog.array_append(s_scale, p_scale);
  s_path := pg_catalog.array_append(s_path, pg_catalog.jsonb_build_array(p_recipe_id));
  s_depth := pg_catalog.array_append(s_depth, 0);

  while pg_catalog.cardinality(s_recipe) > 0 loop
    v_n := pg_catalog.cardinality(s_recipe);
    v_recipe := s_recipe[v_n];
    v_version := s_version[v_n];
    v_scale := s_scale[v_n];
    v_path := s_path[v_n];
    v_depth := s_depth[v_n];
    s_recipe := s_recipe[1:v_n - 1];
    s_version := s_version[1:v_n - 1];
    s_scale := s_scale[1:v_n - 1];
    s_path := s_path[1:v_n - 1];
    s_depth := s_depth[1:v_n - 1];
    v_versions := pg_catalog.array_append(v_versions, v_version);

    for v_line in
    select
      l.id,
      l.stock_item_id,
      l.child_recipe_id,
      l.quantity,
      l.unit
    from
      app.recipe_lines l
    where
      l.version_id = v_version
    order by
      l.line_no
    loop
      if v_line.stock_item_id is not null then
        select
          si.kind,
          si.base_unit
        into v_item_kind,
          v_item_base
        from
          app.stock_items si
        where
          si.id = v_line.stock_item_id;

        if p_validate then
          if v_root_kind = 'cooking'
          and v_item_kind in ('seafood', 'fish_size', 'fish_mixed') then
            v_issues := v_issues || pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'code',
                'cooking_marine',
                'recipe_id',
                v_recipe,
                'stock_item_id',
                v_line.stock_item_id,
                'path',
                v_path
              )
            );
          end if;
        else
          v_bad := false;
          v_loss := app.item_loss_at (v_line.stock_item_id, p_at);

          if v_loss is null then
            v_bad := true;
            v_issues := v_issues || pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'code',
                'loss_not_set',
                'recipe_id',
                v_recipe,
                'stock_item_id',
                v_line.stock_item_id,
                'path',
                v_path
              )
            );
          end if;

          begin
            v_factor := app.item_factor_at (v_line.stock_item_id, v_line.unit, p_at);
          exception
            when sqlstate '22023' then
              v_factor := null;
          end;

          if v_factor is null then
            v_bad := true;
            v_issues := v_issues || pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'code',
                'unit_not_convertible',
                'recipe_id',
                v_recipe,
                'stock_item_id',
                v_line.stock_item_id,
                'unit',
                v_line.unit,
                'path',
                v_path
              )
            );
          end if;

          if not v_bad then
            v_leaves := v_leaves || pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'stock_item_id',
                v_line.stock_item_id,
                'base_unit',
                v_item_base,
                'line_id',
                v_line.id,
                'path',
                v_path,
                'quantity',
                v_scale * v_line.quantity * v_factor / (1 - v_loss)
              )
            );
          end if;
        end if;
      elsif v_path @> pg_catalog.to_jsonb(v_line.child_recipe_id) then
        v_issues := v_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'cycle',
            'recipe_id',
            v_line.child_recipe_id,
            'path',
            v_path || pg_catalog.to_jsonb(v_line.child_recipe_id)
          )
        );
      elsif v_depth + 1 > c_max_depth then
        v_issues := v_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'code',
            'depth_exceeded',
            'recipe_id',
            v_line.child_recipe_id,
            'path',
            v_path || pg_catalog.to_jsonb(v_line.child_recipe_id)
          )
        );
      else
        select
          cv.id,
          cv.batch_qty,
          cv.batch_unit
        into v_child_version,
          v_child_qty,
          v_child_unit
        from
          app.recipe_versions cv
        where
          cv.recipe_id = v_line.child_recipe_id
          and cv.superseded_change_id is null
          and cv.valid_during @> p_at;

        if not found then
          v_issues := v_issues || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'code',
              'no_version_in_force',
              'recipe_id',
              v_line.child_recipe_id,
              'path',
              v_path || pg_catalog.to_jsonb(v_line.child_recipe_id)
            )
          );
        else
          v_unit_factor := app.recipe_unit_factor (v_line.unit, v_child_unit);

          if v_unit_factor is null then
            v_issues := v_issues || pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'code',
                'unit_not_convertible',
                'recipe_id',
                v_line.child_recipe_id,
                'unit',
                v_line.unit,
                'path',
                v_path || pg_catalog.to_jsonb(v_line.child_recipe_id)
              )
            );
          else
            s_recipe := pg_catalog.array_append(s_recipe, v_line.child_recipe_id);
            s_version := pg_catalog.array_append(s_version, v_child_version);
            s_scale := pg_catalog.array_append(s_scale, v_scale * v_line.quantity * v_unit_factor / v_child_qty);
            s_path := pg_catalog.array_append(s_path, v_path || pg_catalog.to_jsonb(v_line.child_recipe_id));
            s_depth := pg_catalog.array_append(s_depth, v_depth + 1);
          end if;
        end if;
      end if;
    end loop;
  end loop;

  select
    coalesce(
      pg_catalog.jsonb_agg(
        distinct u.v
        order by
          u.v
      ),
      '[]'::jsonb
    )
  into v_versions_json
  from
    pg_catalog.unnest(v_versions) as u (v);

  return pg_catalog.jsonb_build_object(
    'leaves',
    v_leaves,
    'issues',
    v_issues,
    'versions',
    v_versions_json
  );
end;
$$;

comment on function app.recipe_walk (uuid, timestamptz, numeric, boolean) is 'Walks one recipe at one instant. Each leaf is scale x net quantity x item factor / (1 - loss), unrounded. Issues carry code, recipe_id, optional stock_item_id and unit, and the recipe path. p_validate = true skips costing and adds cooking_marine. A cycle, depth above 8, a missing child version or an unusable batch unit is an issue, never truncation. Internal.';

-- Unrounded per-stock-item aggregates and provenance. p_scale is the number of
-- portions (dish), kg of scale weight (cooking) or batches (batch) of output.
create function app.recipe_expand_exact (
  p_recipe_id uuid,
  p_at timestamptz,
  p_scale numeric
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_walk jsonb;
  v_requirements jsonb := null;
  v_paths jsonb;
  v_status text;
begin
  if p_at is null
  or not pg_catalog.isfinite(p_at) then
    raise exception 'p_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  if p_scale is null
  or p_scale in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_scale <= 0 then
    raise exception 'scale must be finite and greater than 0'
      using errcode = '22023';
  end if;

  v_walk := app.recipe_walk (p_recipe_id, p_at, p_scale, false);

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          e.value ->> 'stock_item_id',
          'line_id',
          e.value ->> 'line_id',
          'path',
          e.value -> 'path'
        )
        order by
          e.value ->> 'stock_item_id',
          e.value ->> 'line_id',
          (e.value -> 'path')::text
      ),
      '[]'::jsonb
    )
  into v_paths
  from
    pg_catalog.jsonb_array_elements(v_walk -> 'leaves') as e;

  if pg_catalog.jsonb_array_length(v_walk -> 'issues') = 0 then
    v_status := 'ready';

    select
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'stock_item_id',
            a.stock_item_id,
            'base_unit',
            a.base_unit,
            'quantity',
            a.quantity
          )
          order by
            a.stock_item_id
        ),
        '[]'::jsonb
      )
    into v_requirements
    from
      (
        select
          e.value ->> 'stock_item_id' as stock_item_id,
          e.value ->> 'base_unit' as base_unit,
          sum((e.value ->> 'quantity')::numeric) as quantity
        from
          pg_catalog.jsonb_array_elements(v_walk -> 'leaves') as e
        group by
          e.value ->> 'stock_item_id',
          e.value ->> 'base_unit'
      ) a;
  else
    v_status := 'blocked';
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    v_status,
    'requirements',
    v_requirements,
    'issues',
    v_walk -> 'issues',
    'provenance',
    pg_catalog.jsonb_build_object(
      'at',
      app.costing_timestamptz_text (p_at),
      'algorithm_version',
      1,
      'versions',
      v_walk -> 'versions',
      'paths',
      v_paths
    )
  );
end;
$$;

comment on function app.recipe_expand_exact (uuid, timestamptz, numeric) is 'Expands one recipe at p_at into unrounded per-stock-item requirements in the item base unit, plus issues and provenance. requirements is null when blocked, never an empty list. Callers round once, after aggregation. Internal.';

-- ============================================================================
-- F. Publication validation (B2). After a change is written, every affected
-- recipe (the changed one and all its ancestors, transitively) is walked at
-- the start of the changed interval and at every version boundary inside it
-- that any recipe under those ancestors has. A recipe with no version in force
-- at an instant is skipped: its own gap is not an error.
-- ============================================================================
create function app.recipe_validate_publication (
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

comment on function app.recipe_validate_publication (uuid, timestamptz, timestamptz) is 'Run after a recipe change is written. Walks the changed recipe and every ancestor at the interval start and at each version boundary inside [p_from, p_to), and raises 22023 naming the first recipe that would be invalid. Loss and item conversions are not publication rules. Internal.';

-- ============================================================================
-- G. Writers. Owner only. The ledger lock comes first, then the replay check,
-- then every check that depends on the current minute or on stored state.
-- ============================================================================
create function app.create_recipe (p_request_id uuid, p_name text, p_kind text) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_name text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_recipe_id uuid;
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

  v_name := btrim(p_name);

  if v_name is null
  or length(v_name) not between 1 and 120 then
    raise exception 'name must be 1 to 120 characters'
      using errcode = '22023';
  end if;

  if p_kind is null
  or p_kind not in ('dish', 'cooking', 'batch') then
    raise exception 'kind must be dish, cooking, or batch'
      using errcode = '22023';
  end if;

  v_payload := jsonb_build_object('fn', 'create_recipe', 'name', v_name, 'kind', p_kind);
  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  v_recipe_id := pg_catalog.gen_random_uuid();
  v_result := app.insert_owner_costing_change(
    p_request_id,
    null,
    v_payload,
    jsonb_build_object('recipe_id', v_recipe_id)
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  -- A duplicate name raises 23505 from recipes_name_key.
  insert into
    app.recipes (id, name, kind, active, created_change_id)
  values
    (v_recipe_id, v_name, p_kind, true, v_change_id);

  return v_result;
end;
$$;

comment on function app.create_recipe (uuid, text, text) is 'Creates one active recipe of kind dish, cooking or batch, with no version. Takes advisory lock 7342750000000000001. Owner only. The same request_id and payload return the stored result, which carries recipe_id.';

create function app.update_recipe (
  p_request_id uuid,
  p_recipe_id uuid,
  p_name text,
  p_active boolean,
  p_expected_name text,
  p_expected_active boolean
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_name text;
  v_expected_name text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_current_name text;
  v_current_active boolean;
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

  if p_recipe_id is null then
    raise exception 'recipe_id is required'
      using errcode = '22023';
  end if;

  if p_active is null
  or p_expected_active is null then
    raise exception 'active and expected_active are required'
      using errcode = '22023';
  end if;

  v_name := btrim(p_name);
  v_expected_name := btrim(p_expected_name);

  if v_name is null
  or length(v_name) not between 1 and 120 then
    raise exception 'name must be 1 to 120 characters'
      using errcode = '22023';
  end if;

  if v_expected_name is null then
    raise exception 'expected_name is required'
      using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'fn',
    'update_recipe',
    'recipe_id',
    p_recipe_id,
    'name',
    v_name,
    'active',
    p_active,
    'expected_name',
    v_expected_name,
    'expected_active',
    p_expected_active
  );
  v_replay := app.costing_replay_result(p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  select
    r.name,
    r.active
  into v_current_name,
    v_current_active
  from
    app.recipes r
  where
    r.id = p_recipe_id
  for update;

  if not found then
    raise exception 'unknown recipe id: %', p_recipe_id
      using errcode = '22023';
  end if;

  if v_current_name is distinct from v_expected_name
  or v_current_active is distinct from p_expected_active then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  v_result := app.insert_owner_costing_change(
    p_request_id,
    null,
    v_payload,
    jsonb_build_object('recipe_id', p_recipe_id, 'name', v_name, 'active', p_active)
  );

  -- A duplicate name raises 23505 from recipes_name_key.
  update app.recipes
  set
    name = v_name,
    active = p_active
  where
    id = p_recipe_id;

  return v_result;
end;
$$;

comment on function app.update_recipe (uuid, uuid, text, boolean, text, boolean) is 'Renames a recipe or sets its active flag when the stored name and active still equal the expected values, else 40001. Neither is dated. kind never changes. Takes advisory lock 7342750000000000001 before locking the recipe. Owner only.';

create function app.set_recipe_version (
  p_request_id uuid,
  p_recipe_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_batch_qty numeric,
  p_batch_unit text,
  p_lines jsonb,
  p_reason text,
  p_expected_token text
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_reason text;
  v_from_is_now boolean;
  v_effective_from timestamptz;
  v_batch_qty numeric;
  v_batch_unit text;
  v_batch_code text;
  v_lines jsonb;
  v_kind text;
  v_identity text;
  v_payload jsonb;
  v_replay jsonb;
  v_token text;
  v_new_token text;
  v_canonical_to timestamptz;
  v_result jsonb;
  v_change_id bigint;
  v_elem jsonb;
  v_stock_id uuid;
  v_child_id uuid;
  v_code text;
  v_target_kind text;
  v_line_stock uuid[] := '{}'::uuid[];
  v_line_child uuid[] := '{}'::uuid[];
  v_line_qty numeric[] := '{}'::numeric[];
  v_line_unit text[] := '{}'::text[];
  v_superseded uuid[] := '{}'::uuid[];
  v_new_ids uuid[] := '{}'::uuid[];
  v_new_froms timestamptz[] := '{}'::timestamptz[];
  v_new_tos timestamptz[] := '{}'::timestamptz[];
  v_new_bqs numeric[] := '{}'::numeric[];
  v_new_bus text[] := '{}'::text[];
  v_new_srcs uuid[] := '{}'::uuid[];
  v_row record;
begin
  if coalesce(app.is_owner(), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Ledger lock before the recipe row lock. Same key as every posting path.
  perform app.assert_ledger_write_allowed();

  if p_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  if p_recipe_id is null then
    raise exception 'recipe_id is required'
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

  v_batch_qty := p_batch_qty;

  if v_batch_qty is not null
  and (
    v_batch_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or v_batch_qty <= 0
  ) then
    raise exception 'batch_qty must be finite and greater than 0'
      using errcode = '22023';
  end if;

  v_batch_unit := nullif(btrim(p_batch_unit), '');

  if v_batch_unit is not null
  and length(v_batch_unit) > 40 then
    raise exception 'batch_unit must be at most 40 characters'
      using errcode = '22023';
  end if;

  if p_lines is null then
    v_lines := null;

    if v_batch_qty is not null
    or v_batch_unit is not null then
      raise exception 'batch_qty and batch_unit must be null when lines is null'
        using errcode = '22023';
    end if;
  else
    v_lines := app.recipe_lines_normalize(p_lines);
  end if;

  v_payload := jsonb_build_object(
    'fn',
    'set_recipe_version',
    'recipe_id',
    p_recipe_id,
    'effective_from',
    case
      when v_from_is_now then 'now'
      else app.costing_timestamptz_text (p_effective_from)
    end,
    'effective_to',
    app.costing_timestamptz_text (p_effective_to),
    'batch_qty',
    pg_catalog.trim_scale(v_batch_qty),
    'batch_unit',
    v_batch_unit,
    'lines',
    v_lines,
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
    r.kind,
    r.kind || '|'
  into v_kind,
    v_identity
  from
    app.recipes r
  where
    r.id = p_recipe_id
  for update;

  if not found then
    raise exception 'unknown recipe id: %', p_recipe_id
      using errcode = '22023';
  end if;

  v_token := app.recipe_schedule_token(p_recipe_id);

  if v_token is distinct from p_expected_token then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  -- The end is the covering version's own end, or the next start when the
  -- resolved instant is in a gap. A client that computed the end from a
  -- different instant must not fill a gap it did not see.
  select
    case
      when exists (
        select
          1
        from
          app.recipe_versions v
        where
          v.recipe_id = p_recipe_id
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
          app.recipe_versions v
        where
          v.recipe_id = p_recipe_id
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
          app.recipe_versions v
        where
          v.recipe_id = p_recipe_id
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

  -- Only a null effective_from is the server's current minute and needs no
  -- reason. An explicit timestamp earlier than the actual clock does.
  if not v_from_is_now
  and v_effective_from < pg_catalog.now()
  and v_reason is null then
    raise exception 'reason is required for a backdated change'
      using errcode = '22023';
  end if;

  if v_lines is not null then
    if v_kind = 'batch' then
      if v_batch_qty is null
      or v_batch_unit is null then
        raise exception 'a batch recipe version requires batch_qty and batch_unit'
          using errcode = '22023';
      end if;

      v_batch_code := app.resolve_unit_code(v_batch_unit);

      if v_batch_code is null then
        raise exception 'unknown unit "%" for batch_unit', v_batch_unit
          using errcode = '22023';
      end if;
    elsif v_batch_qty is not null
    or v_batch_unit is not null then
      raise exception 'batch_qty and batch_unit are only for batch recipes'
        using errcode = '22023';
    end if;

    for v_i in 1..pg_catalog.jsonb_array_length(v_lines) loop
      v_elem := v_lines -> (v_i - 1);
      v_stock_id := (v_elem ->> 'stock_item_id')::uuid;
      v_child_id := (v_elem ->> 'child_recipe_id')::uuid;
      v_code := app.resolve_unit_code(v_elem ->> 'unit');

      if v_code is null then
        raise exception 'unknown unit "%" in line %', v_elem ->> 'unit', v_i
          using errcode = '22023';
      end if;

      if v_stock_id is not null then
        select
          si.kind
        into v_target_kind
        from
          app.stock_items si
        where
          si.id = v_stock_id;

        if not found then
          raise exception 'unknown stock_item id: % in line %', v_stock_id, v_i
            using errcode = '22023';
        end if;

        if v_target_kind in ('packaging', 'fish_mixed') then
          raise exception 'line %: a % item cannot be a recipe leaf', v_i, v_target_kind
            using errcode = '22023';
        end if;
      else
        select
          r.kind
        into v_target_kind
        from
          app.recipes r
        where
          r.id = v_child_id;

        if not found then
          raise exception 'unknown recipe id: % in line %', v_child_id, v_i
            using errcode = '22023';
        end if;

        if v_target_kind <> 'batch' then
          raise exception 'line %: only a batch recipe can be a child', v_i
            using errcode = '22023';
        end if;
      end if;

      v_line_stock := pg_catalog.array_append(v_line_stock, v_stock_id);
      v_line_child := pg_catalog.array_append(v_line_child, v_child_id);
      v_line_qty := pg_catalog.array_append(v_line_qty, (v_elem ->> 'quantity')::numeric);
      v_line_unit := pg_catalog.array_append(v_line_unit, v_code);
    end loop;
  end if;

  for v_row in
    select
      v.id,
      v.effective_from,
      v.effective_to,
      v.batch_qty,
      v.batch_unit
    from
      app.recipe_versions v
    where
      v.recipe_id = p_recipe_id
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
      v_new_bqs := pg_catalog.array_append(v_new_bqs, v_row.batch_qty);
      v_new_bus := pg_catalog.array_append(v_new_bus, v_row.batch_unit);
      v_new_srcs := pg_catalog.array_append(v_new_srcs, v_row.id);
    end if;

    if p_effective_to is not null
    and (
      v_row.effective_to is null
      or v_row.effective_to > p_effective_to
    ) then
      v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
      v_new_froms := pg_catalog.array_append(v_new_froms, p_effective_to);
      v_new_tos := pg_catalog.array_append(v_new_tos, v_row.effective_to);
      v_new_bqs := pg_catalog.array_append(v_new_bqs, v_row.batch_qty);
      v_new_bus := pg_catalog.array_append(v_new_bus, v_row.batch_unit);
      v_new_srcs := pg_catalog.array_append(v_new_srcs, v_row.id);
    end if;
  end loop;

  -- Null lines remove coverage for the interval. Fragments outside it stay.
  if v_lines is not null then
    v_new_ids := pg_catalog.array_append(v_new_ids, pg_catalog.gen_random_uuid());
    v_new_froms := pg_catalog.array_append(v_new_froms, v_effective_from);
    v_new_tos := pg_catalog.array_append(v_new_tos, p_effective_to);
    v_new_bqs := pg_catalog.array_append(v_new_bqs, v_batch_qty);
    v_new_bus := pg_catalog.array_append(v_new_bus, v_batch_code);
    v_new_srcs := pg_catalog.array_append(v_new_srcs, null::uuid);
  end if;

  select
    pg_catalog.md5(
      v_identity || coalesce(
        string_agg(
          app.recipe_schedule_line (s.id, s.effective_from, s.effective_to, s.batch_qty, s.batch_unit),
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
        v.batch_qty,
        v.batch_unit
      from
        app.recipe_versions v
      where
        v.recipe_id = p_recipe_id
        and v.superseded_change_id is null
        and not (v.id = any (v_superseded))
      union all
      select
        v_new_ids[g.i],
        v_new_froms[g.i],
        v_new_tos[g.i],
        v_new_bqs[g.i],
        v_new_bus[g.i]
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
    update app.recipe_versions
    set
      superseded_change_id = v_change_id
    where
      id = any (v_superseded);
  end if;

  if coalesce(pg_catalog.cardinality(v_new_ids), 0) > 0 then
    for v_i in 1..pg_catalog.cardinality(v_new_ids) loop
      insert into
        app.recipe_versions (
          id,
          effective_from,
          effective_to,
          created_change_id,
          recipe_id,
          batch_qty,
          batch_unit
        )
      values
        (
          v_new_ids[v_i],
          v_new_froms[v_i],
          v_new_tos[v_i],
          v_change_id,
          p_recipe_id,
          v_new_bqs[v_i],
          v_new_bus[v_i]
        );

      if v_new_srcs[v_i] is not null then
        insert into
          app.recipe_lines (version_id, line_no, stock_item_id, child_recipe_id, quantity, unit)
        select
          v_new_ids[v_i],
          l.line_no,
          l.stock_item_id,
          l.child_recipe_id,
          l.quantity,
          l.unit
        from
          app.recipe_lines l
        where
          l.version_id = v_new_srcs[v_i]
        order by
          l.line_no;
      else
        for v_j in 1..pg_catalog.cardinality(v_line_unit) loop
          insert into
            app.recipe_lines (version_id, line_no, stock_item_id, child_recipe_id, quantity, unit)
          values
            (
              v_new_ids[v_i],
              v_j,
              v_line_stock[v_j],
              v_line_child[v_j],
              v_line_qty[v_j],
              v_line_unit[v_j]
            );
        end loop;
      end if;
    end loop;
  end if;

  if app.recipe_schedule_token(p_recipe_id) is distinct from v_new_token then
    raise exception 'internal costing token mismatch'
      using errcode = '55000';
  end if;

  perform app.recipe_validate_publication(p_recipe_id, v_effective_from, p_effective_to);

  return v_result;
end;
$$;

comment on function app.set_recipe_version (
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  numeric,
  text,
  jsonb,
  text,
  text
) is 'Replaces the recipe schedule on [effective_from, effective_to) with one version of the given lines, or with a gap when lines is null. Null effective_from means the current minute and is stored as the text now. An earlier instant requires a reason. Superseded versions keep their rows; the parts outside the interval are re-inserted with copies of their lines. After writing, the recipe and all its ancestors are validated, and a failure rolls everything back with 22023. Takes advisory lock 7342750000000000001 before locking the recipe. Owner only.';

-- ============================================================================
-- H. Readers. recipe_schedule is security invoker: the owner reads through RLS.
-- expand_recipe is security definer because it calls the revoked internals;
-- it checks the owner itself and is the only place that rounds.
-- ============================================================================
create function app.recipe_schedule (p_recipe_id uuid) returns jsonb language plpgsql stable security invoker
set
  search_path = '' as $$
declare
  v_identity text;
  v_empty_token text;
  v_token text;
  v_versions jsonb;
begin
  if coalesce(app.is_owner(), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_recipe_id is null then
    raise exception 'recipe_id is required'
      using errcode = '22023';
  end if;

  select
    r.kind || '|'
  into v_identity
  from
    app.recipes r
  where
    r.id = p_recipe_id;

  if not found then
    raise exception 'unknown recipe id: %', p_recipe_id
      using errcode = '22023';
  end if;

  v_empty_token := pg_catalog.md5(v_identity);

  select
    pg_catalog.md5(
      v_identity || coalesce(
        string_agg(
          v.id::text || '|' || pg_catalog.to_char(v.effective_from at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '|' || coalesce(
            pg_catalog.to_char(v.effective_to at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'),
            ''
          ) || '|' || coalesce(pg_catalog.trim_scale(v.batch_qty)::text, '') || '|' || coalesce(v.batch_unit, ''),
          ','
          order by
            v.effective_from,
            v.id
        ),
        ''
      )
    )
  into v_token
  from
    app.recipe_versions v
  where
    v.recipe_id = p_recipe_id
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
          'batch_qty',
          v.batch_qty,
          'batch_unit',
          v.batch_unit,
          'lines',
          (
            select
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'id',
                    l.id,
                    'line_no',
                    l.line_no,
                    'stock_item_id',
                    l.stock_item_id,
                    'child_recipe_id',
                    l.child_recipe_id,
                    'quantity',
                    l.quantity,
                    'unit',
                    l.unit
                  )
                  order by
                    l.line_no
                ),
                '[]'::jsonb
              )
            from
              app.recipe_lines l
            where
              l.version_id = v.id
          )
        )
        order by
          v.effective_from,
          v.id
      ),
      '[]'::jsonb
    )
  into v_versions
  from
    app.recipe_versions v
  where
    v.recipe_id = p_recipe_id
    and v.superseded_change_id is null;

  return jsonb_build_object(
    'identity',
    v_identity,
    'token',
    v_token,
    'empty_token',
    v_empty_token,
    'versions',
    v_versions
  );
end;
$$;

comment on function app.recipe_schedule (uuid) is 'Owner read of the current schedule of one recipe: identity (kind|), the concurrency token, the empty-schedule token, and every non-superseded version with its lines. The token is md5 of the identity plus the ordered version lines.';

create function app.expand_recipe (
  p_recipe_id uuid,
  p_output_qty numeric,
  p_output_unit text,
  p_at timestamptz
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_kind text;
  v_unit text;
  v_code text;
  v_scale numeric;
  v_factor numeric;
  v_batch_qty numeric;
  v_batch_unit text;
  v_exact jsonb;
  v_requirements jsonb;
  v_below jsonb;
begin
  if coalesce(app.is_owner(), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  if p_recipe_id is null then
    raise exception 'recipe_id is required'
      using errcode = '22023';
  end if;

  if p_output_qty is null
  or p_output_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_output_qty <= 0 then
    raise exception 'output_qty must be finite and greater than 0'
      using errcode = '22023';
  end if;

  if p_at is null
  or not pg_catalog.isfinite(p_at) then
    raise exception 'p_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  select
    r.kind
  into v_kind
  from
    app.recipes r
  where
    r.id = p_recipe_id;

  if not found then
    raise exception 'unknown recipe id: %', p_recipe_id
      using errcode = '22023';
  end if;

  v_unit := nullif(btrim(p_output_unit), '');
  v_scale := null;

  if v_kind = 'dish' then
    if v_unit = 'portion' then
      v_scale := p_output_qty;
    end if;
  elsif v_kind = 'cooking' then
    v_factor := app.recipe_unit_factor(app.resolve_unit_code(v_unit), 'kg');

    if v_factor is not null then
      v_scale := p_output_qty * v_factor;
    end if;
  else
    select
      v.batch_qty,
      v.batch_unit
    into v_batch_qty,
      v_batch_unit
    from
      app.recipe_versions v
    where
      v.recipe_id = p_recipe_id
      and v.superseded_change_id is null
      and v.valid_during @> p_at;

    if not found then
      -- The walk reports the missing version.
      v_scale := 1;
    else
      v_code := app.resolve_unit_code(v_unit);
      v_factor := app.recipe_unit_factor(v_code, v_batch_unit);

      if v_factor is not null then
        v_scale := p_output_qty * v_factor / v_batch_qty;
      end if;
    end if;
  end if;

  if v_scale is null then
    return jsonb_build_object(
      'status',
      'blocked',
      'requirements',
      null,
      'issues',
      jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'code',
            'invalid_output_unit',
            'recipe_id',
            p_recipe_id,
            'unit',
            v_unit,
            'path',
            jsonb_build_array(p_recipe_id)
          )
        )
      ),
      'provenance',
      jsonb_build_object(
        'at',
        app.costing_timestamptz_text(p_at),
        'algorithm_version',
        1,
        'versions',
        '[]'::jsonb,
        'paths',
        '[]'::jsonb
      )
    );
  end if;

  v_exact := app.recipe_expand_exact(p_recipe_id, p_at, v_scale);

  if v_exact ->> 'status' <> 'ready' then
    return v_exact;
  end if;

  -- The only rounding: once per stock item, after every path is summed.
  select
    jsonb_agg(
      jsonb_build_object(
        'stock_item_id',
        e.value ->> 'stock_item_id',
        'base_unit',
        e.value ->> 'base_unit',
        'quantity',
        pg_catalog.round((e.value ->> 'quantity')::numeric, 6)
      )
      order by
        e.value ->> 'stock_item_id'
    )
  into v_requirements
  from
    jsonb_array_elements(v_exact -> 'requirements') as e;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'code',
          'below_precision',
          'recipe_id',
          p_recipe_id,
          'stock_item_id',
          e.value ->> 'stock_item_id',
          'path',
          jsonb_build_array(p_recipe_id)
        )
        order by
          e.value ->> 'stock_item_id'
      ),
      '[]'::jsonb
    )
  into v_below
  from
    jsonb_array_elements(v_exact -> 'requirements') as e
  where
    (e.value ->> 'quantity')::numeric > 0
    and pg_catalog.round((e.value ->> 'quantity')::numeric, 6) = 0;

  if jsonb_array_length(v_below) > 0 then
    return jsonb_build_object(
      'status',
      'blocked',
      'requirements',
      null,
      'issues',
      v_below,
      'provenance',
      v_exact -> 'provenance'
    );
  end if;

  return v_exact || jsonb_build_object('requirements', v_requirements);
end;
$$;

comment on function app.expand_recipe (uuid, numeric, text, timestamptz) is 'Editor preview. Expands a recipe at p_at for an output quantity: p_output_unit is portion for a dish, a mass unit for cooking (scaled to kg), and the batch unit or a same-dimension metric unit for a batch. Sums every path per stock item, rounds once to 6 places, and blocks when a positive total rounds to 0. requirements is null when blocked. Owner only.';

-- ============================================================================
-- I. Stock item identity freeze. A current recipe line now freezes base_unit,
-- kind and parent_item_id, like a loss, conversion, opening price or movement.
-- The statement trigger still takes the ledger lock first. Messages are kept.
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

comment on function app.trg_stock_items_freeze_configured_identity () is 'Rejects a base_unit, kind or parent_item_id change while the item has movements, a current loss, conversion or opening price, or a line of a non-superseded recipe version. Runs after trg_stock_items_configured_identity_lock, which holds the ledger lock.';

-- ============================================================================
-- J. RLS, grants. Writers are owner-only. API roles cannot write the tables.
-- ============================================================================
alter table app.recipes enable row level security;

alter table app.recipe_versions enable row level security;

alter table app.recipe_lines enable row level security;

create policy recipes_select_owner on app.recipes for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy recipe_versions_select_owner on app.recipe_versions for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy recipe_lines_select_owner on app.recipe_lines for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.recipes
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.recipe_versions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.recipe_lines
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.recipes,
  app.recipe_versions,
  app.recipe_lines to authenticated,
  service_role;

revoke all on function app.create_recipe (uuid, text, text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.update_recipe (uuid, uuid, text, boolean, text, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.set_recipe_version (
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  numeric,
  text,
  jsonb,
  text,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_schedule (uuid)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.expand_recipe (uuid, numeric, text, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.create_recipe (uuid, text, text),
app.update_recipe (uuid, uuid, text, boolean, text, boolean),
app.set_recipe_version (
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  numeric,
  text,
  jsonb,
  text,
  text
),
app.recipe_schedule (uuid),
app.expand_recipe (uuid, numeric, text, timestamptz) to authenticated;

revoke all on function app.recipe_schedule_line (uuid, timestamptz, timestamptz, numeric, text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_schedule_token (uuid)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_unit_factor (text, text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_payload_assert_no_price_keys (jsonb, integer)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_lines_normalize (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_walk (uuid, timestamptz, numeric, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_expand_exact (uuid, timestamptz, numeric)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_validate_publication (uuid, timestamptz, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_recipes_guard ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_recipe_versions_batch_fields ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_recipe_lines_target ()
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.trg_recipe_lines_immutable ()
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
