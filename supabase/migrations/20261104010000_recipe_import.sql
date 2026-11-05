-- Recipe import (phase 4, PR 5). Additive.
--
-- The owner reviews a workbook in the browser, then sends ONE commit. The
-- commit creates the approved new stock items and recipes, publishes recipe
-- versions through the shared body of set_recipe_version and then validates
-- the affected graph once, sets approved loss ratios through
-- set_item_loss, applies owner-typed opening prices through
-- set_item_opening_price, and records which source names were bound to what.
-- Everything runs in one transaction under the ledger lock, so any refusal
-- leaves nothing behind.
--
-- Workbook prices never reach the database. The workbook-derived sections of
-- the payload pass the price-key check and a strict allowlist at every level.
-- Only the separate manual_opening_prices section may carry unit_cost, and
-- those are values the owner typed.
-- ============================================================================
-- A. Tables. Append-only; written only by commit_recipe_import.
-- ============================================================================
create table app.recipe_imports (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  structural_hash text not null,
  created_change_id bigint not null unique references app.costing_changes (id) on delete restrict,
  counts jsonb not null,
  summary jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint recipe_imports_hash_chk check (structural_hash ~ '^[0-9a-f]{64}$'),
  constraint recipe_imports_counts_chk check (pg_catalog.jsonb_typeof (counts) = 'object'),
  constraint recipe_imports_summary_chk check (pg_catalog.jsonb_typeof (summary) = 'object')
);

comment on table app.recipe_imports is 'Receipt of one committed workbook import. structural_hash is an opaque client SHA-256 of names, kinds, lines, quantities, units and batch quantities; it carries no prices and no cell positions. Append-only.';

create index recipe_imports_hash_idx on app.recipe_imports (structural_hash);

create table app.recipe_import_bindings (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references app.recipe_imports (id) on delete restrict,
  source_name text not null,
  recipe_id uuid null references app.recipes (id) on delete restrict,
  stock_item_id uuid null references app.stock_items (id) on delete restrict,
  is_block boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  constraint recipe_import_bindings_source_name_chk check (
    source_name = btrim(source_name)
    and length(source_name) between 1 and 200
  ),
  constraint recipe_import_bindings_one_target_chk check ((recipe_id is null) <> (stock_item_id is null)),
  constraint recipe_import_bindings_block_chk check (
    not is_block
    or recipe_id is not null
  ),
  constraint recipe_import_bindings_import_source_key unique (import_id, source_name)
);

comment on table app.recipe_import_bindings is 'Which recipe or stock item a normalised workbook source name was bound to, per import. is_block marks a source name that was a recipe block title in the file, as opposed to an ingredient line, so a later file that no longer has the block can be told apart from one that never used the name. The latest row per source_name is the current binding. Append-only.';

create index recipe_import_bindings_source_idx on app.recipe_import_bindings (source_name, created_at);

create index recipe_import_bindings_recipe_idx on app.recipe_import_bindings (recipe_id)
where
  recipe_id is not null;

create index recipe_import_bindings_item_idx on app.recipe_import_bindings (stock_item_id)
where
  stock_item_id is not null;

create trigger trg_recipe_imports_no_update_delete
before update or delete on app.recipe_imports for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_recipe_imports_no_truncate
before truncate on app.recipe_imports for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_recipe_import_bindings_no_update_delete
before update or delete on app.recipe_import_bindings for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_recipe_import_bindings_no_truncate
before truncate on app.recipe_import_bindings for each statement
execute function app.prevent_append_only_mutation ();

-- ============================================================================
-- B. Payload readers. Each raises 22023 with a message that names the field.
-- ============================================================================
create function app.import_assert_keys (p_node jsonb, p_allowed text[], p_what text) returns void language plpgsql immutable
set
  search_path = '' as $$
declare
  v_key text;
begin
  if pg_catalog.jsonb_typeof(p_node) is distinct from 'object' then
    raise exception '% must be a json object', p_what
      using errcode = '22023';
  end if;

  for v_key in
  select
    pg_catalog.jsonb_object_keys(p_node)
  loop
    if not (v_key = any (p_allowed)) then
      raise exception 'unknown key "%" in %', v_key, p_what
        using errcode = '22023';
    end if;
  end loop;
end;
$$;

create function app.import_array (p_node jsonb, p_key text, p_max integer) returns jsonb language plpgsql immutable
set
  search_path = '' as $$
declare
  v_node jsonb;
begin
  v_node := p_node -> p_key;

  if v_node is null
  or pg_catalog.jsonb_typeof(v_node) = 'null' then
    return '[]'::jsonb;
  end if;

  if pg_catalog.jsonb_typeof(v_node) <> 'array' then
    raise exception '% must be a json array', p_key
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(v_node) > p_max then
    raise exception '% has too many entries', p_key
      using errcode = '22023';
  end if;

  return v_node;
end;
$$;

create function app.import_text (
  p_node jsonb,
  p_key text,
  p_what text,
  p_min integer,
  p_max integer,
  p_required boolean
) returns text language plpgsql immutable
set
  search_path = '' as $$
declare
  v_node jsonb;
  v_text text;
begin
  v_node := p_node -> p_key;

  if v_node is not null
  and pg_catalog.jsonb_typeof(v_node) not in ('null', 'string') then
    raise exception '% in % must be text', p_key, p_what
      using errcode = '22023';
  end if;

  if v_node is not null
  and pg_catalog.jsonb_typeof(v_node) = 'string' then
    v_text := pg_catalog.btrim(v_node #>> '{}');
  end if;

  if v_text is null
  or v_text = '' then
    if p_required then
      raise exception '% in % is required', p_key, p_what
        using errcode = '22023';
    end if;

    return null;
  end if;

  if pg_catalog.length(v_text) not between p_min and p_max then
    raise exception '% in % must be % to % characters', p_key, p_what, p_min, p_max
      using errcode = '22023';
  end if;

  return v_text;
end;
$$;

create function app.import_uuid (p_node jsonb, p_key text, p_what text) returns uuid language plpgsql immutable
set
  search_path = '' as $$
declare
  v_node jsonb;
begin
  v_node := p_node -> p_key;

  if v_node is null
  or pg_catalog.jsonb_typeof(v_node) = 'null' then
    return null;
  end if;

  if pg_catalog.jsonb_typeof(v_node) <> 'string' then
    raise exception '% in % must be a uuid string', p_key, p_what
      using errcode = '22023';
  end if;

  begin
    return (v_node #>> '{}')::uuid;
  exception
    when invalid_text_representation then
      raise exception '% in % must be a uuid string', p_key, p_what
        using errcode = '22023';
  end;
end;
$$;

create function app.import_numeric (p_node jsonb, p_key text, p_what text) returns numeric language plpgsql immutable
set
  search_path = '' as $$
declare
  v_node jsonb;
  v_num numeric;
begin
  v_node := p_node -> p_key;

  if v_node is null
  or pg_catalog.jsonb_typeof(v_node) = 'null' then
    return null;
  end if;

  if pg_catalog.jsonb_typeof(v_node) not in ('number', 'string') then
    raise exception '% in % must be a number', p_key, p_what
      using errcode = '22023';
  end if;

  begin
    v_num := pg_catalog.btrim(v_node #>> '{}')::numeric;
  exception
    when invalid_text_representation
    or numeric_value_out_of_range then
      raise exception '% in % must be a number', p_key, p_what
        using errcode = '22023';
  end;

  if v_num in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception '% in % must be a finite number', p_key, p_what
      using errcode = '22023';
  end if;

  return v_num;
end;
$$;

-- ============================================================================
-- C. Structural validation. Pure: no table is read. Returns the canonical
-- payload that is stored for replay, so an identical retry compares equal.
-- Price-like keys are refused anywhere outside manual_opening_prices, then
-- every object at every level must use only its allowed keys.
-- ============================================================================
create function app.import_normalize_payload (p_payload jsonb) returns jsonb language plpgsql stable
set
  search_path = '' as $$
declare
  v_hash text;
  v_from_node jsonb;
  v_from_text text;
  v_from timestamptz;
  v_reason text;
  v_elem jsonb;
  v_line jsonb;
  v_lines jsonb;
  v_n integer;
  v_m integer;
  v_what text;
  v_key text;
  v_name text;
  v_kind text;
  v_base text;
  v_freq text;
  v_id uuid;
  v_sid uuid;
  v_cid uuid;
  v_ikey text;
  v_rkey text;
  v_is_block boolean;
  v_token text;
  v_text text;
  v_qty numeric;
  v_num numeric;
  v_unit text;
  v_items jsonb := '[]'::jsonb;
  v_recipes jsonb := '[]'::jsonb;
  v_losses jsonb := '[]'::jsonb;
  v_prices jsonb := '[]'::jsonb;
  v_bindings jsonb := '[]'::jsonb;
  v_item_keys text[] := '{}'::text[];
  v_item_names text[] := '{}'::text[];
  v_recipe_keys text[] := '{}'::text[];
  v_recipe_ids uuid[] := '{}'::uuid[];
  v_recipe_refs text[] := '{}'::text[];
  v_targets text[] := '{}'::text[];
begin
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'payload must be a json object'
      using errcode = '22023';
  end if;

  perform app.recipe_payload_assert_no_price_keys (p_payload - 'manual_opening_prices', 0);

  perform app.import_assert_keys (
    p_payload,
    array[
      'structural_hash',
      'effective_from',
      'reason',
      'items',
      'recipes',
      'losses',
      'manual_opening_prices',
      'bindings'
    ],
    'payload'
  );

  v_hash := app.import_text (p_payload, 'structural_hash', 'payload', 1, 200, true);

  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'structural_hash must be 64 lowercase hex characters'
      using errcode = '22023';
  end if;

  v_from_node := p_payload -> 'effective_from';

  if v_from_node is null
  or pg_catalog.jsonb_typeof(v_from_node) = 'null' then
    v_from_text := 'now';
  elsif pg_catalog.jsonb_typeof(v_from_node) <> 'string'
  or (v_from_node #>> '{}') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then
    raise exception 'effective_from must be a timestamp or null'
      using errcode = '22023';
  else
    begin
      v_from := (v_from_node #>> '{}')::timestamptz;
    exception
      when invalid_datetime_format
      or datetime_field_overflow then
        raise exception 'effective_from must be a timestamp or null'
          using errcode = '22023';
    end;

    if not pg_catalog.isfinite(v_from) then
      raise exception 'effective_from must be a finite timestamp'
        using errcode = '22023';
    end if;

    v_from_text := app.costing_timestamptz_text (v_from);
  end if;

  v_reason := app.import_text (p_payload, 'reason', 'payload', 1, 500, false);

  -- New stock items.
  v_n := 0;

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(app.import_array (p_payload, 'items', 2000)) as e
  loop
    v_n := v_n + 1;
    v_what := 'item ' || v_n;

    perform app.import_assert_keys (
      v_elem,
      array['key', 'name', 'kind', 'base_unit', 'count_frequency'],
      v_what
    );

    v_key := app.import_text (v_elem, 'key', v_what, 1, 40, true);
    v_name := app.import_text (v_elem, 'name', v_what, 1, 120, true);
    v_kind := app.import_text (v_elem, 'kind', v_what, 1, 40, true);
    v_base := app.import_text (v_elem, 'base_unit', v_what, 1, 40, true);
    v_freq := app.import_text (v_elem, 'count_frequency', v_what, 1, 40, true);

    if v_kind not in ('ingredient', 'seafood') then
      raise exception '%: kind must be ingredient or seafood', v_what
        using errcode = '22023';
    end if;

    if v_base not in ('kg', 'piece', 'liter') then
      raise exception '%: base_unit must be kg, piece or liter', v_what
        using errcode = '22023';
    end if;

    if v_freq not in ('daily', 'weekly') then
      raise exception '%: count_frequency must be daily or weekly', v_what
        using errcode = '22023';
    end if;

    if v_key = any (v_item_keys) then
      raise exception 'duplicate item key "%"', v_key
        using errcode = '22023';
    end if;

    if v_name = any (v_item_names) then
      raise exception 'duplicate item name "%"', v_name
        using errcode = '22023';
    end if;

    v_item_keys := pg_catalog.array_append(v_item_keys, v_key);
    v_item_names := pg_catalog.array_append(v_item_names, v_name);
    v_items := v_items || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'key',
        v_key,
        'name',
        v_name,
        'kind',
        v_kind,
        'base_unit',
        v_base,
        'count_frequency',
        v_freq
      )
    );
  end loop;

  -- Recipes, new or existing, with their lines.
  v_n := 0;

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(app.import_array (p_payload, 'recipes', 500)) as e
  loop
    v_n := v_n + 1;
    v_what := 'recipe ' || v_n;

    perform app.import_assert_keys (
      v_elem,
      array[
        'key',
        'name',
        'kind',
        'recipe_id',
        'expected_token',
        'batch_qty',
        'batch_unit',
        'lines'
      ],
      v_what
    );

    v_key := app.import_text (v_elem, 'key', v_what, 1, 40, true);
    v_kind := app.import_text (v_elem, 'kind', v_what, 1, 40, true);
    v_name := app.import_text (v_elem, 'name', v_what, 1, 120, false);
    v_id := app.import_uuid (v_elem, 'recipe_id', v_what);
    v_token := app.import_text (v_elem, 'expected_token', v_what, 1, 100, false);

    if v_kind = 'cooking' then
      raise exception '%: cooking recipes are never imported', v_what
        using errcode = '22023';
    end if;

    if v_kind not in ('dish', 'batch') then
      raise exception '%: kind must be dish or batch', v_what
        using errcode = '22023';
    end if;

    if v_key = any (v_recipe_keys) then
      raise exception 'duplicate recipe key "%"', v_key
        using errcode = '22023';
    end if;

    if v_id is null then
      if v_name is null then
        raise exception '%: name is required for a new recipe', v_what
          using errcode = '22023';
      end if;

      if v_token is not null then
        raise exception '%: expected_token is only for an existing recipe', v_what
          using errcode = '22023';
      end if;
    else
      if v_name is not null then
        raise exception '%: name must be omitted for an existing recipe', v_what
          using errcode = '22023';
      end if;

      if v_token is null then
        raise exception '%: expected_token is required for an existing recipe', v_what
          using errcode = '22023';
      end if;

      if v_id = any (v_recipe_ids) then
        raise exception '%: the same recipe appears twice', v_what
          using errcode = '22023';
      end if;

      v_recipe_ids := pg_catalog.array_append(v_recipe_ids, v_id);
    end if;

    v_qty := app.import_numeric (v_elem, 'batch_qty', v_what);
    v_unit := app.import_text (v_elem, 'batch_unit', v_what, 1, 40, false);

    if v_kind = 'batch' then
      if v_qty is null
      or v_unit is null then
        raise exception '%: a batch needs batch_qty and batch_unit', v_what
          using errcode = '22023';
      end if;

      if v_qty <= 0 then
        raise exception '%: batch_qty must be greater than 0', v_what
          using errcode = '22023';
      end if;
    elsif v_qty is not null
    or v_unit is not null then
      raise exception '%: batch_qty and batch_unit are only for a batch', v_what
        using errcode = '22023';
    end if;

    v_lines := '[]'::jsonb;
    v_m := 0;

    if pg_catalog.jsonb_typeof(v_elem -> 'lines') is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_elem -> 'lines') = 0 then
      raise exception '%: lines must be a non-empty array', v_what
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_array_length(v_elem -> 'lines') > 300 then
      raise exception '%: too many lines', v_what
        using errcode = '22023';
    end if;

    for v_line in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(v_elem -> 'lines') as e
    loop
      v_m := v_m + 1;

      perform app.import_assert_keys (
        v_line,
        array[
          'stock_item_id',
          'item_key',
          'child_recipe_id',
          'recipe_key',
          'quantity',
          'unit'
        ],
        v_what || ' line ' || v_m
      );

      v_sid := app.import_uuid (v_line, 'stock_item_id', v_what || ' line ' || v_m);
      v_ikey := app.import_text (v_line, 'item_key', v_what || ' line ' || v_m, 1, 40, false);
      v_cid := app.import_uuid (v_line, 'child_recipe_id', v_what || ' line ' || v_m);
      v_rkey := app.import_text (v_line, 'recipe_key', v_what || ' line ' || v_m, 1, 40, false);

      if pg_catalog.num_nonnulls(v_sid, v_ikey, v_cid, v_rkey) <> 1 then
        raise exception '% line %: needs exactly one target', v_what, v_m
          using errcode = '22023';
      end if;

      if v_ikey is not null
      and not (v_ikey = any (v_item_keys)) then
        raise exception '% line %: unknown item_key "%"', v_what, v_m, v_ikey
          using errcode = '22023';
      end if;

      if v_rkey is not null then
        v_recipe_refs := pg_catalog.array_append(v_recipe_refs, v_rkey);
      end if;

      v_num := app.import_numeric (v_line, 'quantity', v_what || ' line ' || v_m);

      if v_num is null
      or v_num <= 0 then
        raise exception '% line %: quantity must be greater than 0', v_what, v_m
          using errcode = '22023';
      end if;

      v_text := app.import_text (v_line, 'unit', v_what || ' line ' || v_m, 1, 40, true);
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          v_sid,
          'item_key',
          v_ikey,
          'child_recipe_id',
          v_cid,
          'recipe_key',
          v_rkey,
          'quantity',
          pg_catalog.trim_scale(v_num),
          'unit',
          v_text
        )
      );
    end loop;

    v_recipe_keys := pg_catalog.array_append(v_recipe_keys, v_key);
    v_recipes := v_recipes || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'key',
        v_key,
        'name',
        v_name,
        'kind',
        v_kind,
        'recipe_id',
        v_id,
        'expected_token',
        v_token,
        'batch_qty',
        pg_catalog.trim_scale(v_qty),
        'batch_unit',
        v_unit,
        'lines',
        v_lines
      )
    );
  end loop;

  if pg_catalog.jsonb_array_length(v_recipes) = 0 then
    raise exception 'recipes must not be empty'
      using errcode = '22023';
  end if;

  -- Approved loss ratios. A fraction in [0, 1), never a price.
  v_n := 0;
  v_targets := '{}'::text[];

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(app.import_array (p_payload, 'losses', 2000)) as e
  loop
    v_n := v_n + 1;
    v_what := 'loss ' || v_n;

    perform app.import_assert_keys (
      v_elem,
      array['stock_item_id', 'item_key', 'loss_pct', 'expected_token'],
      v_what
    );

    v_sid := app.import_uuid (v_elem, 'stock_item_id', v_what);
    v_ikey := app.import_text (v_elem, 'item_key', v_what, 1, 40, false);
    v_token := app.import_text (v_elem, 'expected_token', v_what, 1, 100, false);

    if pg_catalog.num_nonnulls(v_sid, v_ikey) <> 1 then
      raise exception '%: needs exactly one of stock_item_id and item_key', v_what
        using errcode = '22023';
    end if;

    if v_ikey is not null then
      if not (v_ikey = any (v_item_keys)) then
        raise exception '%: unknown item_key "%"', v_what, v_ikey
          using errcode = '22023';
      end if;

      if v_token is not null then
        raise exception '%: expected_token is only for an existing item', v_what
          using errcode = '22023';
      end if;
    elsif v_token is null then
      raise exception '%: expected_token is required for an existing item', v_what
        using errcode = '22023';
    end if;

    v_num := app.import_numeric (v_elem, 'loss_pct', v_what);

    if v_num is null
    or v_num < 0
    or v_num >= 1 then
      raise exception '%: loss_pct must be finite and in [0, 1)', v_what
        using errcode = '22023';
    end if;

    v_num := pg_catalog.round(v_num, 5);

    if v_num >= 1 then
      raise exception '%: loss_pct must be finite and in [0, 1)', v_what
        using errcode = '22023';
    end if;

    v_text := coalesce('k:' || v_ikey, 'i:' || v_sid::text);

    if v_text = any (v_targets) then
      raise exception '%: the same item appears twice', v_what
        using errcode = '22023';
    end if;

    v_targets := pg_catalog.array_append(v_targets, v_text);
    v_losses := v_losses || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'stock_item_id',
        v_sid,
        'item_key',
        v_ikey,
        'loss_pct',
        pg_catalog.trim_scale(v_num),
        'expected_token',
        v_token
      )
    );
  end loop;

  -- Owner-typed opening prices. The only section that may carry a cost.
  v_n := 0;
  v_targets := '{}'::text[];

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(app.import_array (p_payload, 'manual_opening_prices', 2000)) as e
  loop
    v_n := v_n + 1;
    v_what := 'manual opening price ' || v_n;

    perform app.import_assert_keys (
      v_elem,
      array[
        'stock_item_id',
        'item_key',
        'unit_cost',
        'zero_cost_reason',
        'expected_identity',
        'expected_current_id'
      ],
      v_what
    );

    v_sid := app.import_uuid (v_elem, 'stock_item_id', v_what);
    v_ikey := app.import_text (v_elem, 'item_key', v_what, 1, 40, false);
    v_text := app.import_text (v_elem, 'expected_identity', v_what, 1, 200, false);
    v_id := app.import_uuid (v_elem, 'expected_current_id', v_what);
    v_token := app.import_text (v_elem, 'zero_cost_reason', v_what, 1, 500, false);

    if pg_catalog.num_nonnulls(v_sid, v_ikey) <> 1 then
      raise exception '%: needs exactly one of stock_item_id and item_key', v_what
        using errcode = '22023';
    end if;

    if v_ikey is not null then
      if not (v_ikey = any (v_item_keys)) then
        raise exception '%: unknown item_key "%"', v_what, v_ikey
          using errcode = '22023';
      end if;

      if v_text is not null
      or v_id is not null then
        raise exception '%: expected_identity and expected_current_id are only for an existing item', v_what
          using errcode = '22023';
      end if;
    elsif v_text is null then
      raise exception '%: expected_identity is required for an existing item', v_what
        using errcode = '22023';
    end if;

    v_num := app.import_numeric (v_elem, 'unit_cost', v_what);

    if v_num is null
    or v_num < 0 then
      raise exception '%: unit_cost must be finite and greater than or equal to 0', v_what
        using errcode = '22023';
    end if;

    v_num := pg_catalog.round(v_num, 6);

    if v_num = 0
    and v_token is null then
      raise exception '%: zero_cost_reason is required when unit_cost is 0', v_what
        using errcode = '22023';
    end if;

    if v_num > 0
    and v_token is not null then
      raise exception '%: zero_cost_reason must be null when unit_cost is greater than 0', v_what
        using errcode = '22023';
    end if;

    v_name := coalesce('k:' || v_ikey, 'i:' || v_sid::text);

    if v_name = any (v_targets) then
      raise exception '%: the same item appears twice', v_what
        using errcode = '22023';
    end if;

    v_targets := pg_catalog.array_append(v_targets, v_name);
    v_prices := v_prices || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'stock_item_id',
        v_sid,
        'item_key',
        v_ikey,
        'unit_cost',
        pg_catalog.trim_scale(v_num),
        'zero_cost_reason',
        v_token,
        'expected_identity',
        v_text,
        'expected_current_id',
        v_id
      )
    );
  end loop;

  -- Bindings of normalised source names. Nothing else is stored from the file.
  v_n := 0;
  v_targets := '{}'::text[];

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(app.import_array (p_payload, 'bindings', 4000)) as e
  loop
    v_n := v_n + 1;
    v_what := 'binding ' || v_n;

    perform app.import_assert_keys (
      v_elem,
      array['source_name', 'stock_item_id', 'item_key', 'recipe_id', 'recipe_key', 'is_block'],
      v_what
    );

    v_name := app.import_text (v_elem, 'source_name', v_what, 1, 200, true);
    v_sid := app.import_uuid (v_elem, 'stock_item_id', v_what);
    v_ikey := app.import_text (v_elem, 'item_key', v_what, 1, 40, false);
    v_cid := app.import_uuid (v_elem, 'recipe_id', v_what);
    v_rkey := app.import_text (v_elem, 'recipe_key', v_what, 1, 40, false);

    if pg_catalog.num_nonnulls(v_sid, v_ikey, v_cid, v_rkey) <> 1 then
      raise exception '%: needs exactly one target', v_what
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof(v_elem -> 'is_block') is null
    or pg_catalog.jsonb_typeof(v_elem -> 'is_block') = 'null' then
      v_is_block := false;
    elsif pg_catalog.jsonb_typeof(v_elem -> 'is_block') = 'boolean' then
      v_is_block := (v_elem ->> 'is_block')::boolean;
    else
      raise exception '%: is_block must be true or false', v_what
        using errcode = '22023';
    end if;

    if v_is_block
    and v_cid is null
    and v_rkey is null then
      raise exception '%: is_block needs a recipe target', v_what
        using errcode = '22023';
    end if;

    if v_ikey is not null
    and not (v_ikey = any (v_item_keys)) then
      raise exception '%: unknown item_key "%"', v_what, v_ikey
        using errcode = '22023';
    end if;

    if v_rkey is not null then
      v_recipe_refs := pg_catalog.array_append(v_recipe_refs, v_rkey);
    end if;

    if v_name = any (v_targets) then
      raise exception '%: duplicate source_name "%"', v_what, v_name
        using errcode = '22023';
    end if;

    v_targets := pg_catalog.array_append(v_targets, v_name);
    v_bindings := v_bindings || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'source_name',
        v_name,
        'stock_item_id',
        v_sid,
        'item_key',
        v_ikey,
        'recipe_id',
        v_cid,
        'recipe_key',
        v_rkey,
        'is_block',
        v_is_block
      )
    );
  end loop;

  select
    r.k
  into v_key
  from
    pg_catalog.unnest(v_recipe_refs) as r (k)
  where
    not (r.k = any (v_recipe_keys))
  limit
    1;

  if found then
    raise exception 'unknown recipe_key "%"', v_key
      using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'fn',
    'commit_recipe_import',
    'structural_hash',
    v_hash,
    'effective_from',
    v_from_text,
    'reason',
    v_reason,
    'items',
    v_items,
    'recipes',
    v_recipes,
    'losses',
    v_losses,
    'manual_opening_prices',
    v_prices,
    'bindings',
    v_bindings
  );
end;
$$;

comment on function app.import_normalize_payload (jsonb) is 'Pure structural validation of a recipe import payload. Price-like keys are refused at every level outside manual_opening_prices, unknown keys are refused at every level, and the canonical payload for replay is returned. Raises 22023. Internal.';

-- ============================================================================
-- D. State helpers used by the commit. Internal.
-- ============================================================================
create function app.import_sub_request_id (p_request_id uuid, p_label text) returns uuid language sql immutable
set
  search_path = '' as $$
  select
    pg_catalog.md5(p_request_id::text || ':' || p_label)::uuid;
$$;

create function app.import_recipe_canonical_to (p_recipe_id uuid, p_at timestamptz) returns timestamptz language sql stable security definer
set
  search_path = '' as $$
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
          and v.valid_during @> p_at
      ) then (
        select
          v.effective_to
        from
          app.recipe_versions v
        where
          v.recipe_id = p_recipe_id
          and v.superseded_change_id is null
          and v.valid_during @> p_at
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
          and v.effective_from > p_at
      )
    end;
$$;

create function app.import_loss_canonical_to (p_item_id uuid, p_at timestamptz) returns timestamptz language sql stable security definer
set
  search_path = '' as $$
  select
    case
      when exists (
        select
          1
        from
          app.item_loss_versions v
        where
          v.item_id = p_item_id
          and v.superseded_change_id is null
          and v.valid_during @> p_at
      ) then (
        select
          v.effective_to
        from
          app.item_loss_versions v
        where
          v.item_id = p_item_id
          and v.superseded_change_id is null
          and v.valid_during @> p_at
        order by
          v.effective_from desc
        limit
          1
      )
      else (
        select
          min(v.effective_from)
        from
          app.item_loss_versions v
        where
          v.item_id = p_item_id
          and v.superseded_change_id is null
          and v.effective_from > p_at
      )
    end;
$$;

-- True when the version in force at p_at has the same batch and the same
-- multiset of lines. Order is not part of the structure.
create function app.import_version_matches (
  p_recipe_id uuid,
  p_at timestamptz,
  p_batch_qty numeric,
  p_batch_unit text,
  p_lines jsonb
) returns boolean language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_version uuid;
  v_bqty numeric;
  v_bunit text;
  v_have text[];
  v_want text[];
begin
  select
    v.id,
    v.batch_qty,
    v.batch_unit
  into v_version,
    v_bqty,
    v_bunit
  from
    app.recipe_versions v
  where
    v.recipe_id = p_recipe_id
    and v.superseded_change_id is null
    and v.valid_during @> p_at;

  if not found then
    return false;
  end if;

  if v_bqty is distinct from p_batch_qty
  or v_bunit is distinct from p_batch_unit then
    return false;
  end if;

  select
    pg_catalog.array_agg(
      s.x
      order by
        s.x
    )
  into v_have
  from
    (
      select
        coalesce(l.stock_item_id::text, '') || '|' || coalesce(l.child_recipe_id::text, '') || '|' || pg_catalog.trim_scale(l.quantity)::text || '|' || l.unit as x
      from
        app.recipe_lines l
      where
        l.version_id = v_version
    ) s;

  select
    pg_catalog.array_agg(
      s.x
      order by
        s.x
    )
  into v_want
  from
    (
      select
        coalesce(e.value ->> 'stock_item_id', '') || '|' || coalesce(e.value ->> 'child_recipe_id', '') || '|' || pg_catalog.trim_scale((e.value ->> 'quantity')::numeric)::text || '|' || (e.value ->> 'unit') as x
      from
        pg_catalog.jsonb_array_elements(p_lines) as e
    ) s;

  return v_have is not distinct from v_want;
end;
$$;

-- Children first. p_deps is a json array: for recipe i, the 1-based indexes
-- of the import recipes it uses. A recipe that waits on itself, or on a
-- cycle, can never be placed.
create function app.import_publish_order (p_deps jsonb) returns integer[] language plpgsql immutable
set
  search_path = '' as $$
declare
  v_n integer := pg_catalog.jsonb_array_length(p_deps);
  v_done boolean[] := pg_catalog.array_fill(false, array[v_n]);
  v_order integer[] := '{}'::integer[];
  v_progress boolean;
  v_ready boolean;
  v_d integer;
begin
  while pg_catalog.cardinality(v_order) < v_n loop
    v_progress := false;

    for v_i in 1..v_n loop
      if v_done[v_i] then
        continue;
      end if;

      v_ready := true;

      for v_d in
      select
        e.value::integer
      from
        pg_catalog.jsonb_array_elements_text(p_deps -> (v_i - 1)) as e
      loop
        if not v_done[v_d] then
          v_ready := false;
          exit;
        end if;
      end loop;

      if v_ready then
        v_done[v_i] := true;
        v_order := pg_catalog.array_append(v_order, v_i);
        v_progress := true;
      end if;
    end loop;

    if not v_progress then
      raise exception 'recipes in the import use each other in a cycle'
        using errcode = '22023';
    end if;
  end loop;

  return v_order;
end;
$$;

create function app.insert_import_costing_change (
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
      'import',
      auth.uid (),
      p_reason,
      p_payload,
      v_result
    );

  return v_result;
end;
$$;

-- ============================================================================
-- D2. One publication path. recipe_publish_version is the body of
-- set_recipe_version with the closing publication check made optional, and
-- set_recipe_version now calls it with the check on, so single edits behave
-- exactly as before. The import publishes every recipe of a file without the
-- check and then validates the whole affected graph once, because a
-- coordinated change (a batch changing unit together with the lines of its
-- parents) is invalid in every one-at-a-time order.
-- ============================================================================
create function app.recipe_publish_version (
  p_request_id uuid,
  p_recipe_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_batch_qty numeric,
  p_batch_unit text,
  p_lines jsonb,
  p_reason text,
  p_expected_token text,
  p_validate boolean
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

  if p_validate then
    perform app.recipe_validate_publication(p_recipe_id, v_effective_from, p_effective_to);
  end if;

  return v_result;
end;
$$;

comment on function app.recipe_publish_version (
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  numeric,
  text,
  jsonb,
  text,
  text,
  boolean
) is 'Shared body of set_recipe_version. When p_validate is false the closing recipe_validate_publication is skipped and the caller must validate every recipe it published, over the same interval, before the transaction ends. Takes advisory lock 7342750000000000001 before locking the recipe. Owner only. Internal.';

create or replace function app.set_recipe_version (
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
begin
  return app.recipe_publish_version(
    p_request_id,
    p_recipe_id,
    p_effective_from,
    p_effective_to,
    p_batch_qty,
    p_batch_unit,
    p_lines,
    p_reason,
    p_expected_token,
    true
  );
end;
$$;

-- ============================================================================
-- E. The commit. Owner only. Ledger lock, argument validation, replay, then
-- state checks, then the writes in dependency order. The existing writers do
-- the real work with sub request ids derived from the import request id, so
-- every rule they enforce applies here unchanged.
-- ============================================================================
create function app.commit_recipe_import (p_request_id uuid, p_payload jsonb) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_from_is_now boolean;
  v_effective_from timestamptz;
  v_from_arg timestamptz;
  v_reason text;
  v_import_id uuid := pg_catalog.gen_random_uuid();
  v_elem jsonb;
  v_line jsonb;
  v_resolved jsonb;
  v_deps jsonb;
  v_all_deps jsonb := '[]'::jsonb;
  v_sub jsonb;
  v_idx integer;
  v_dep integer;
  v_n integer;
  v_key text;
  v_name text;
  v_kind text;
  v_db_kind text;
  v_active boolean;
  v_sid uuid;
  v_cid uuid;
  v_rid uuid;
  v_current uuid;
  v_code text;
  v_token text;
  v_to timestamptz;
  v_loss numeric(6, 5);
  v_cur_loss numeric;
  v_identity text;
  v_label text;
  v_status text;
  v_result jsonb;
  v_change_id bigint;
  v_item_ids jsonb := '{}'::jsonb;
  v_r_key text[] := '{}'::text[];
  v_r_id uuid[] := '{}'::uuid[];
  v_r_new boolean[] := '{}'::boolean[];
  v_r_lines jsonb[] := '{}'::jsonb[];
  v_r_bqty numeric[] := '{}'::numeric[];
  v_r_bcode text[] := '{}'::text[];
  v_order integer[];
  v_pub_ids uuid[] := '{}'::uuid[];
  v_pub_tos timestamptz[] := '{}'::timestamptz[];
  v_recipes_out jsonb := '[]'::jsonb;
  v_losses_out jsonb := '[]'::jsonb;
  v_prices_out jsonb := '[]'::jsonb;
  v_counts jsonb;
  c_items integer := 0;
  c_recipes_created integer := 0;
  c_versions integer := 0;
  c_unchanged integer := 0;
  c_losses integer := 0;
  c_losses_unchanged integer := 0;
  c_prices integer := 0;
  c_bindings integer := 0;
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

  v_payload := app.import_normalize_payload (p_payload);
  v_replay := app.costing_replay_result (p_request_id, v_payload);

  if v_replay is not null then
    return v_replay;
  end if;

  v_from_is_now := v_payload ->> 'effective_from' = 'now';
  v_reason := v_payload ->> 'reason';

  if v_from_is_now then
    v_effective_from := pg_catalog.date_trunc('minute', pg_catalog.now());
    v_from_arg := null;
  else
    v_effective_from := (v_payload ->> 'effective_from')::timestamptz;
    v_from_arg := v_effective_from;
  end if;

  if not v_from_is_now
  and v_effective_from < pg_catalog.now()
  and v_reason is null then
    raise exception 'reason is required for a backdated change'
      using errcode = '22023';
  end if;

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(v_payload -> 'items') as e
  loop
    v_name := v_elem ->> 'name';

    if exists (
      select
        1
      from
        app.stock_items si
      where
        si.name = v_name
    ) then
      raise exception 'stock item name already exists: %', v_name
        using errcode = '22023';
    end if;
  end loop;

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(v_payload -> 'recipes') as e
  loop
    v_name := v_elem ->> 'name';

    if v_name is not null
    and exists (
      select
        1
      from
        app.recipes r
      where
        r.name = v_name
    ) then
      raise exception 'recipe name already exists: %', v_name
        using errcode = '22023';
    end if;
  end loop;

  -- New stock items, unconfigured. Loss and price come from the sections below.
  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(v_payload -> 'items') as e
  loop
    v_sid := app.create_stock_item (
      app.import_sub_request_id (p_request_id, 'item:' || (v_elem ->> 'key')),
      v_elem ->> 'name',
      v_elem ->> 'kind',
      v_elem ->> 'base_unit',
      v_elem ->> 'count_frequency',
      null,
      null,
      true
    );
    v_item_ids := v_item_ids || pg_catalog.jsonb_build_object(v_elem ->> 'key', v_sid);
    c_items := c_items + 1;
  end loop;

  -- Recipe identities first, so a line can point at any recipe in the file.
  v_n := pg_catalog.jsonb_array_length(v_payload -> 'recipes');

  for v_i in 1..v_n loop
    v_elem := (v_payload -> 'recipes') -> (v_i - 1);
    v_key := v_elem ->> 'key';
    v_kind := v_elem ->> 'kind';

    if v_elem ->> 'recipe_id' is null then
      v_rid := (
        app.create_recipe (
          app.import_sub_request_id (p_request_id, 'recipe:' || v_key),
          v_elem ->> 'name',
          v_kind
        ) ->> 'recipe_id'
      )::uuid;
      v_r_new := pg_catalog.array_append(v_r_new, true);
      c_recipes_created := c_recipes_created + 1;
    else
      v_rid := (v_elem ->> 'recipe_id')::uuid;

      select
        r.kind,
        r.active
      into v_db_kind,
        v_active
      from
        app.recipes r
      where
        r.id = v_rid;

      if not found then
        raise exception 'unknown recipe id: %', v_rid
          using errcode = '22023';
      end if;

      if v_db_kind <> v_kind then
        raise exception 'recipe % is a % recipe, not %', v_rid, v_db_kind, v_kind
          using errcode = '22023';
      end if;

      if not v_active then
        raise exception 'recipe % is inactive', v_rid
          using errcode = '22023';
      end if;

      v_r_new := pg_catalog.array_append(v_r_new, false);
    end if;

    v_r_key := pg_catalog.array_append(v_r_key, v_key);
    v_r_id := pg_catalog.array_append(v_r_id, v_rid);
  end loop;

  -- Resolve every line to ids and unit codes, and note which import recipes
  -- each recipe uses.
  for v_i in 1..v_n loop
    v_elem := (v_payload -> 'recipes') -> (v_i - 1);
    v_resolved := '[]'::jsonb;
    v_deps := '[]'::jsonb;

    if v_elem ->> 'kind' = 'batch' then
      v_code := app.resolve_unit_code (v_elem ->> 'batch_unit');

      if v_code is null then
        raise exception 'unknown unit "%" for the batch of recipe "%"', v_elem ->> 'batch_unit', v_r_key[v_i]
          using errcode = '22023';
      end if;

      v_r_bqty := pg_catalog.array_append(v_r_bqty, (v_elem ->> 'batch_qty')::numeric);
      v_r_bcode := pg_catalog.array_append(v_r_bcode, v_code);
    else
      v_r_bqty := pg_catalog.array_append(v_r_bqty, null::numeric);
      v_r_bcode := pg_catalog.array_append(v_r_bcode, null::text);
    end if;

    for v_line in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(v_elem -> 'lines') as e
    loop
      v_sid := null;
      v_cid := null;
      v_dep := null;

      if v_line ->> 'item_key' is not null then
        v_sid := (v_item_ids ->> (v_line ->> 'item_key'))::uuid;
      elsif v_line ->> 'stock_item_id' is not null then
        v_sid := (v_line ->> 'stock_item_id')::uuid;
      elsif v_line ->> 'recipe_key' is not null then
        v_dep := pg_catalog.array_position(v_r_key, v_line ->> 'recipe_key');
        v_cid := v_r_id[v_dep];
      else
        v_cid := (v_line ->> 'child_recipe_id')::uuid;
        v_dep := pg_catalog.array_position(v_r_id, v_cid);
      end if;

      v_code := app.resolve_unit_code (v_line ->> 'unit');

      if v_code is null then
        raise exception 'unknown unit "%" in recipe "%"', v_line ->> 'unit', v_r_key[v_i]
          using errcode = '22023';
      end if;

      if v_dep is not null then
        v_deps := v_deps || pg_catalog.jsonb_build_array(v_dep);
      end if;

      v_resolved := v_resolved || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          v_sid,
          'child_recipe_id',
          v_cid,
          'quantity',
          (v_line -> 'quantity'),
          'unit',
          v_code
        )
      );
    end loop;

    v_r_lines := pg_catalog.array_append(v_r_lines, v_resolved);
    v_all_deps := v_all_deps || pg_catalog.jsonb_build_array(v_deps);
  end loop;

  v_order := app.import_publish_order (v_all_deps);

  -- Approved loss ratios.
  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(v_payload -> 'losses') as e
  loop
    if v_elem ->> 'item_key' is not null then
      v_sid := (v_item_ids ->> (v_elem ->> 'item_key'))::uuid;
      v_label := 'k:' || (v_elem ->> 'item_key');
    else
      v_sid := (v_elem ->> 'stock_item_id')::uuid;
      v_label := 'i:' || (v_elem ->> 'stock_item_id');
    end if;

    v_loss := (v_elem ->> 'loss_pct')::numeric;
    v_token := app.schedule_token ('loss', v_sid, null);

    if v_elem ->> 'item_key' is null
    and v_token is distinct from v_elem ->> 'expected_token' then
      raise exception 'configuration changed'
        using errcode = '40001';
    end if;

    select
      v.loss_pct
    into v_cur_loss
    from
      app.item_loss_versions v
    where
      v.item_id = v_sid
      and v.superseded_change_id is null
      and v.valid_during @> v_effective_from;

    if found
    and v_cur_loss = v_loss then
      v_status := 'unchanged';
      c_losses_unchanged := c_losses_unchanged + 1;
    else
      v_to := app.import_loss_canonical_to (v_sid, v_effective_from);
      v_sub := app.set_item_loss (
        app.import_sub_request_id (p_request_id, 'loss:' || v_label),
        v_sid,
        v_loss,
        v_from_arg,
        v_to,
        v_token,
        v_reason
      );
      v_status := 'set';
      c_losses := c_losses + 1;
    end if;

    v_losses_out := v_losses_out || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('stock_item_id', v_sid, 'status', v_status)
    );
  end loop;

  -- Publish every changed recipe without the per-recipe publication check, then
  -- validate the affected graph once below. An unchanged existing recipe gets no version.
  foreach v_idx in array v_order loop
    v_elem := (v_payload -> 'recipes') -> (v_idx - 1);
    v_rid := v_r_id[v_idx];
    v_token := app.recipe_schedule_token (v_rid);

    if not v_r_new[v_idx]
    and v_token is distinct from v_elem ->> 'expected_token' then
      raise exception 'configuration changed'
        using errcode = '40001';
    end if;

    if not v_r_new[v_idx]
    and app.import_version_matches (
      v_rid,
      v_effective_from,
      v_r_bqty[v_idx],
      v_r_bcode[v_idx],
      v_r_lines[v_idx]
    ) then
      v_status := 'unchanged';
      c_unchanged := c_unchanged + 1;
      v_change_id := null;
    else
      v_to := app.import_recipe_canonical_to (v_rid, v_effective_from);
      v_sub := app.recipe_publish_version (
        app.import_sub_request_id (p_request_id, 'version:' || v_r_key[v_idx]),
        v_rid,
        v_from_arg,
        v_to,
        v_r_bqty[v_idx],
        v_r_bcode[v_idx],
        v_r_lines[v_idx],
        v_reason,
        v_token,
        false
      );
      v_pub_ids := pg_catalog.array_append(v_pub_ids, v_rid);
      v_pub_tos := pg_catalog.array_append(v_pub_tos, v_to);
      v_status := case
        when v_r_new[v_idx] then 'created'
        else 'published'
      end;
      v_change_id := (v_sub ->> 'change_id')::bigint;
      c_versions := c_versions + 1;
    end if;

    v_recipes_out := v_recipes_out || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'key',
        v_r_key[v_idx],
        'recipe_id',
        v_rid,
        'status',
        v_status,
        'change_id',
        v_change_id
      )
    );
  end loop;

  -- Every imported version now exists, so each published recipe and its
  -- ancestors are checked against the final graph. A failure rolls everything back.
  for v_i in 1..coalesce(pg_catalog.cardinality(v_pub_ids), 0) loop
    perform app.recipe_validate_publication (v_pub_ids[v_i], v_effective_from, v_pub_tos[v_i]);
  end loop;

  -- Owner-typed opening prices, with the same identity binding as the writer.
  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(v_payload -> 'manual_opening_prices') as e
  loop
    if v_elem ->> 'item_key' is not null then
      v_sid := (v_item_ids ->> (v_elem ->> 'item_key'))::uuid;
      v_label := 'k:' || (v_elem ->> 'item_key');
      v_current := null;

      select
        si.base_unit || '|' || si.kind || '|' || coalesce(si.parent_item_id::text, '') || '|'
      into v_identity
      from
        app.stock_items si
      where
        si.id = v_sid;
    else
      v_sid := (v_elem ->> 'stock_item_id')::uuid;
      v_label := 'i:' || (v_elem ->> 'stock_item_id');
      v_current := (v_elem ->> 'expected_current_id')::uuid;
      v_identity := v_elem ->> 'expected_identity';
    end if;

    v_sub := app.set_item_opening_price (
      app.import_sub_request_id (p_request_id, 'price:' || v_label),
      v_sid,
      (v_elem ->> 'unit_cost')::numeric,
      v_elem ->> 'zero_cost_reason',
      v_current,
      v_identity
    );
    c_prices := c_prices + 1;
    v_prices_out := v_prices_out || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('stock_item_id', v_sid, 'change_id', v_sub -> 'change_id')
    );
  end loop;

  c_bindings := pg_catalog.jsonb_array_length(v_payload -> 'bindings');
  v_counts := pg_catalog.jsonb_build_object(
    'items_created',
    c_items,
    'recipes_created',
    c_recipes_created,
    'versions_published',
    c_versions,
    'recipes_unchanged',
    c_unchanged,
    'losses_set',
    c_losses,
    'losses_unchanged',
    c_losses_unchanged,
    'opening_prices_set',
    c_prices,
    'bindings',
    c_bindings
  );

  v_result := app.insert_import_costing_change (
    p_request_id,
    v_reason,
    v_payload,
    pg_catalog.jsonb_build_object(
      'import_id',
      v_import_id,
      'structural_hash',
      v_payload ->> 'structural_hash',
      'effective_from',
      v_payload ->> 'effective_from',
      'counts',
      v_counts,
      'items',
      v_item_ids,
      'recipes',
      v_recipes_out,
      'losses',
      v_losses_out,
      'opening_prices',
      v_prices_out
    )
  );
  v_change_id := (v_result ->> 'change_id')::bigint;

  insert into
    app.recipe_imports (id, request_id, structural_hash, created_change_id, counts, summary)
  values
    (
      v_import_id,
      p_request_id,
      v_payload ->> 'structural_hash',
      v_change_id,
      v_counts,
      pg_catalog.jsonb_build_object(
        'effective_from',
        v_payload ->> 'effective_from',
        'recipes',
        v_recipes_out
      )
    );

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements(v_payload -> 'bindings') as e
  loop
    v_sid := null;
    v_rid := null;

    if v_elem ->> 'item_key' is not null then
      v_sid := (v_item_ids ->> (v_elem ->> 'item_key'))::uuid;
    elsif v_elem ->> 'stock_item_id' is not null then
      v_sid := (v_elem ->> 'stock_item_id')::uuid;
    elsif v_elem ->> 'recipe_key' is not null then
      v_rid := v_r_id[pg_catalog.array_position(v_r_key, v_elem ->> 'recipe_key')];
    else
      v_rid := (v_elem ->> 'recipe_id')::uuid;
    end if;

    if v_sid is not null
    and not exists (
      select
        1
      from
        app.stock_items si
      where
        si.id = v_sid
    ) then
      raise exception 'unknown stock_item id: %', v_sid
        using errcode = '22023';
    end if;

    if v_rid is not null
    and not exists (
      select
        1
      from
        app.recipes r
      where
        r.id = v_rid
    ) then
      raise exception 'unknown recipe id: %', v_rid
        using errcode = '22023';
    end if;

    insert into
      app.recipe_import_bindings (import_id, source_name, recipe_id, stock_item_id, is_block)
    values
      (
        v_import_id,
        v_elem ->> 'source_name',
        v_rid,
        v_sid,
        (v_elem ->> 'is_block')::boolean
      );
  end loop;

  return v_result;
end;
$$;

comment on function app.commit_recipe_import (uuid, jsonb) is 'Commits one reviewed workbook import atomically. Owner only. Takes advisory lock 7342750000000000001, validates the payload (price-like keys refused outside manual_opening_prices, unknown keys refused everywhere), replays by request_id, then creates the approved items and recipes, publishes every changed version through recipe_publish_version without the per-recipe check, validates the whole affected graph once after all versions exist, sets approved losses through set_item_loss, applies owner-typed opening prices, and records bindings. An unchanged recipe gets no version. Any refusal rolls everything back.';

-- ============================================================================
-- F. RLS and grants. The owner reads; nothing writes except the commit.
-- ============================================================================
comment on function app.import_assert_keys (jsonb, text[], text) is 'Raises 22023 unless the node is an object that uses only the allowed keys. Internal.';

comment on function app.import_array (jsonb, text, integer) is 'Reads an optional json array by key, absent or null meaning empty, and refuses anything else or more than the maximum entries with 22023. Internal.';

comment on function app.import_text (jsonb, text, text, integer, integer, boolean) is 'Reads an optional trimmed text field of the given length range from an import payload node. An empty value is null unless required. Raises 22023. Internal.';

comment on function app.import_uuid (jsonb, text, text) is 'Reads an optional uuid string field from an import payload node. Raises 22023 for anything else. Internal.';

comment on function app.import_numeric (jsonb, text, text) is 'Reads an optional finite number from an import payload node, as a json number or numeric text. Raises 22023 otherwise. Internal.';

comment on function app.import_sub_request_id (uuid, text) is 'Deterministic request id for one sub-write of an import, derived from the import request id and a label, so a retry never double-writes. Internal.';

comment on function app.import_recipe_canonical_to (uuid, timestamptz) is 'End of the recipe version in force at the instant, or the start of the next version when the instant is in a gap, which is what set_recipe_version expects as its interval end. Internal.';

comment on function app.import_loss_canonical_to (uuid, timestamptz) is 'End of the loss version in force at the instant, or the start of the next one when the instant is in a gap, which is what set_item_loss expects as its interval end. Internal.';

comment on function app.import_version_matches (uuid, timestamptz, numeric, text, jsonb) is 'True when the recipe version in force at the instant has the same batch quantity and unit and the same multiset of resolved lines, ignoring line order. Internal.';

comment on function app.import_publish_order (jsonb) is 'Orders the imported recipes children first from a json array of 1-based dependency indexes. A cycle or a self-use raises 22023. Internal.';

comment on function app.insert_import_costing_change (uuid, text, jsonb, jsonb) is 'Appends the costing change of kind import for one committed workbook import and returns the result with change_id merged in. Internal.';

alter table app.recipe_imports enable row level security;

alter table app.recipe_import_bindings enable row level security;

create policy recipe_imports_select_owner on app.recipe_imports for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy recipe_import_bindings_select_owner on app.recipe_import_bindings for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.recipe_imports
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.recipe_import_bindings
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.recipe_imports,
  app.recipe_import_bindings to authenticated,
  service_role;

revoke all on function app.commit_recipe_import (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

grant
execute on function app.commit_recipe_import (uuid, jsonb) to authenticated;

revoke all on function app.import_assert_keys (jsonb, text[], text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_array (jsonb, text, integer)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_text (jsonb, text, text, integer, integer, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_uuid (jsonb, text, text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_numeric (jsonb, text, text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_normalize_payload (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_sub_request_id (uuid, text)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_recipe_canonical_to (uuid, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_loss_canonical_to (uuid, timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_version_matches (uuid, timestamptz, numeric, text, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.import_publish_order (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.recipe_publish_version (
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  numeric,
  text,
  jsonb,
  text,
  text,
  boolean
)
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on function app.insert_import_costing_change (uuid, text, jsonb, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;
