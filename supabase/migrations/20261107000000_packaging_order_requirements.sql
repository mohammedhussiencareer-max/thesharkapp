-- Packaging policies and per-order requirements.
--
-- A policy is dated like a mapping version: half-open, supersede plus
-- fragments, one btree_gist exclusion, one schedule token per subject
-- (identity included), request_id replay before any mutable-state check,
-- a null effective_from stored as "now", a backdating reason, 40001, and
-- the ledger advisory lock first. The costing change kind stays "mapping".
--
-- Subjects are separate from app.pos_map_subjects so a packaging save does
-- not change a mapping token. An order-type subject is the trimmed POS
-- order_type, and a blank type is ["none"]. A base subject is the PR 6
-- item plus size key. A version is an approved list or an approved none.
-- No row in force means unreviewed, which does not count as covered.
--
-- Only kind "packaging" can be a packaging target. Packaging items stay
-- forbidden as recipe and mapping targets; those writers already reject
-- them, so publication does not walk packaging policies.
--
-- Capacity is kilograms of product per container. It is rejected on an
-- order-type line. On a base line it is used only when the POS line is
-- weighted: containers = ceil(weighted_kg / capacity_kg). A fixed line
-- ignores capacity and multiplies by the line quantity. A weight line
-- without capacity is linear per weighted kilogram. Order-type quantities
-- are once per order.
--
-- app.resolve_order_requirements rounds once, after base, option, nested
-- recipe and packaging fractions have been summed. below_precision is an
-- order aggregate that rounds to 0. The exact sibling keeps the fractions
-- and is revoked from API roles.
-- ============================================================================
-- A. Subjects, versions, lines.
-- ============================================================================
create function app.packaging_order_type_key (p_order_type text) returns jsonb language sql immutable
set
  search_path = '' as $$
  select
    case
      when nullif(btrim(p_order_type), '') is null then '["none"]'::jsonb
      else pg_catalog.jsonb_build_array('type', btrim(p_order_type))
    end;
$$;

comment on function app.packaging_order_type_key (text) is 'Canonical order-type key. A null or blank POS order_type is ["none"]; any other value is ["type", trimmed]. Does not reject a long value: the writer does, and a stored order longer than the subject limit simply matches no policy.';

create table app.packaging_subjects (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  order_type_key jsonb null,
  pos_item_id text null,
  size_key jsonb null,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  constraint packaging_subjects_kind_chk check (kind in ('order_type', 'base')),
  constraint packaging_subjects_item_chk check (
    pos_item_id is null
    or (
      pos_item_id = btrim(pos_item_id)
      and length(pos_item_id) between 1 and 200
    )
  ),
  constraint packaging_subjects_order_key_chk check (
    order_type_key is null
    or order_type_key = '["none"]'::jsonb
    or (
      pg_catalog.jsonb_typeof (order_type_key) = 'array'
      and pg_catalog.jsonb_array_length (order_type_key) = 2
      and order_type_key ->> 0 = 'type'
      and order_type_key ->> 1 = btrim(order_type_key ->> 1)
      and length(order_type_key ->> 1) between 1 and 200
    )
  ),
  constraint packaging_subjects_shape_chk check (
    (
      kind = 'order_type'
      and order_type_key is not null
      and pos_item_id is null
      and size_key is null
    )
    or (
      kind = 'base'
      and order_type_key is null
      and pos_item_id is not null
      and size_key is not null
    )
  )
);

comment on table app.packaging_subjects is 'Identity of one packaging policy. Order type is the trimmed POS order_type, or ["none"] when the type is blank. Base is the POS item plus size key. Created on the first dated write. Rows are immutable.';

create unique index packaging_subjects_order_type_uidx on app.packaging_subjects (order_type_key)
where
  kind = 'order_type';

create unique index packaging_subjects_base_uidx on app.packaging_subjects (pos_item_id, size_key)
where
  kind = 'base';

create table app.packaging_versions (
  id uuid primary key default gen_random_uuid(),
  effective_from timestamptz not null,
  effective_to timestamptz null,
  valid_during tstzrange generated always as (tstzrange (effective_from, effective_to, '[)')) stored,
  created_change_id bigint not null references app.costing_changes (id) on delete restrict,
  superseded_change_id bigint null references app.costing_changes (id) on delete restrict,
  subject_id uuid not null references app.packaging_subjects (id) on delete restrict,
  decision text not null,
  constraint packaging_versions_from_finite_chk check (pg_catalog.isfinite (effective_from)),
  constraint packaging_versions_to_chk check (
    effective_to is null
    or (
      pg_catalog.isfinite (effective_to)
      and effective_to > effective_from
    )
  ),
  constraint packaging_versions_decision_chk check (decision in ('lines', 'none')),
  constraint packaging_versions_no_overlap exclude using gist (
    subject_id extensions.gist_uuid_ops
    with
      =,
      valid_during
    with
      &&
  )
  where
    (superseded_change_id is null)
);

comment on table app.packaging_versions is 'Dated packaging policy. decision lines is an approved list; none is an approved absence. Non-superseded intervals of one subject do not overlap. A gap means unreviewed. Only superseded_change_id may change, and only once.';

create index packaging_versions_subject_idx on app.packaging_versions (subject_id, effective_from)
where
  superseded_change_id is null;

create index packaging_versions_created_change_idx on app.packaging_versions (created_change_id);

create index packaging_versions_superseded_change_idx on app.packaging_versions (superseded_change_id)
where
  superseded_change_id is not null;

create table app.packaging_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references app.packaging_versions (id) on delete restrict,
  line_no integer not null,
  stock_item_id uuid not null references app.stock_items (id) on delete restrict,
  quantity numeric not null,
  unit_code text not null references app.units (code) on delete restrict,
  capacity_kg numeric null,
  constraint packaging_lines_no_chk check (line_no >= 1),
  constraint packaging_lines_qty_chk check (
    quantity <> 'NaN'::numeric
    and quantity <> 'Infinity'::numeric
    and quantity <> '-Infinity'::numeric
    and quantity > 0
  ),
  constraint packaging_lines_capacity_chk check (
    capacity_kg is null
    or (
      capacity_kg <> 'NaN'::numeric
      and capacity_kg <> 'Infinity'::numeric
      and capacity_kg <> '-Infinity'::numeric
      and capacity_kg > 0
    )
  ),
  constraint packaging_lines_version_no_uidx unique (version_id, line_no),
  constraint packaging_lines_version_item_uidx unique (version_id, stock_item_id)
);

comment on table app.packaging_lines is 'One packaging target on an approved list. quantity is per order for an order-type policy and per line unit for a base policy. capacity_kg is product kilograms per container and is null on an order-type line. Rows are immutable; a superseded version keeps its lines.';

create index packaging_lines_version_idx on app.packaging_lines (version_id, line_no);

create index packaging_lines_item_idx on app.packaging_lines (stock_item_id);

-- ============================================================================
-- B. Immutability. A lines version must actually have lines. The check is
-- deferred so the writer can insert the version and its lines, then force it.
-- ============================================================================
create function app.trg_packaging_subjects_immutable () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.packaging_subjects is immutable; % is not allowed', tg_op
    using errcode = '55000';
end;
$$;

create trigger trg_packaging_subjects_immutable
before update or delete on app.packaging_subjects for each row
execute function app.trg_packaging_subjects_immutable ();

create trigger trg_packaging_subjects_no_truncate
before truncate on app.packaging_subjects for each statement
execute function app.trg_packaging_subjects_immutable ();

create trigger trg_packaging_versions_supersede_only
before update or delete on app.packaging_versions for each row
execute function app.trg_version_supersede_only ();

create trigger trg_packaging_versions_no_truncate
before truncate on app.packaging_versions for each statement
execute function app.trg_version_no_truncate ();

create function app.trg_packaging_lines_immutable () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception 'app.packaging_lines is immutable; % is not allowed', tg_op
    using errcode = '55000';
end;
$$;

create trigger trg_packaging_lines_immutable
before update or delete on app.packaging_lines for each row
execute function app.trg_packaging_lines_immutable ();

create trigger trg_packaging_lines_no_truncate
before truncate on app.packaging_lines for each statement
execute function app.trg_packaging_lines_immutable ();

create function app.trg_packaging_lines_target () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_kind text;
  v_subject_kind text;
  v_decision text;
begin
  select
    si.kind
  into v_kind
  from
    app.stock_items si
  where
    si.id = new.stock_item_id;

  if v_kind is distinct from 'packaging' then
    raise exception 'only packaging items can be packaging targets'
      using errcode = '23514';
  end if;

  select
    s.kind,
    v.decision
  into v_subject_kind,
    v_decision
  from
    app.packaging_versions v
    join app.packaging_subjects s on s.id = v.subject_id
  where
    v.id = new.version_id;

  if v_subject_kind is null then
    raise exception 'unknown packaging version'
      using errcode = '23503';
  end if;

  if v_decision is distinct from 'lines' then
    raise exception 'an approved none has no packaging lines'
      using errcode = '23514';
  end if;

  if v_subject_kind = 'order_type'
  and new.capacity_kg is not null then
    raise exception 'order packaging has no capacity'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_packaging_lines_target
before insert on app.packaging_lines for each row
execute function app.trg_packaging_lines_target ();

create function app.trg_packaging_versions_shape () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_lines integer;
begin
  select
    count(*)::integer
  into v_lines
  from
    app.packaging_lines l
  where
    l.version_id = new.id;

  if new.decision = 'lines'
  and v_lines < 1 then
    raise exception 'a packaging list needs at least one line'
      using errcode = '23514';
  end if;

  if new.decision = 'none'
  and v_lines > 0 then
    raise exception 'an approved none has no packaging lines'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

create constraint trigger trg_packaging_versions_shape
after insert on app.packaging_versions
deferrable initially deferred for each row
execute function app.trg_packaging_versions_shape ();

-- ============================================================================
-- C. Identity, token, and the payload allowlist.
-- ============================================================================
create function app.packaging_identity (
  p_kind text,
  p_order_type_key jsonb,
  p_pos_item_id text,
  p_size_key jsonb
) returns text language sql immutable
set
  search_path = '' as $$
  select
    case
      when p_kind = 'order_type' then 'order_type|' || p_order_type_key::text || '|'
      else 'base|' || p_pos_item_id || '|' || p_size_key::text || '|'
    end;
$$;

create function app.packaging_subject_id (
  p_kind text,
  p_order_type_key jsonb,
  p_pos_item_id text,
  p_size_key jsonb
) returns uuid language sql stable security definer
set
  search_path = '' as $$
  select
    s.id
  from
    app.packaging_subjects s
  where
    (
      p_kind = 'order_type'
      and s.kind = 'order_type'
      and s.order_type_key = p_order_type_key
    )
    or (
      p_kind = 'base'
      and s.kind = 'base'
      and s.pos_item_id = p_pos_item_id
      and s.size_key = p_size_key
    );
$$;

create function app.packaging_schedule_line (
  p_id uuid,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
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
    ) || '|' || p_body;
$$;

create function app.packaging_version_lines_json (p_version_id uuid) returns jsonb language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls (
          pg_catalog.jsonb_build_object(
            'capacity_kg',
            l.capacity_kg,
            'quantity',
            l.quantity,
            'stock_item_id',
            l.stock_item_id,
            'unit',
            l.unit_code
          )
        )
        order by
          l.line_no
      ),
      '[]'::jsonb
    )
  from
    app.packaging_lines l
  where
    l.version_id = p_version_id;
$$;

create function app.packaging_body (p_decision text, p_lines jsonb) returns text language sql immutable
set
  search_path = '' as $$
  select
    case
      when p_decision = 'none' then 'none'
      else 'lines|' || coalesce(
        (
          select
            pg_catalog.string_agg(
              (e.value ->> 'stock_item_id') || '|' || pg_catalog.trim_scale ((e.value ->> 'quantity')::numeric)::text || '|' || (e.value ->> 'unit') || '|' || coalesce(
                pg_catalog.trim_scale ((e.value ->> 'capacity_kg')::numeric)::text,
                ''
              ),
              ';'
              order by
                e.ordinality
            )
          from
            pg_catalog.jsonb_array_elements (coalesce(p_lines, '[]'::jsonb)) with ordinality as e
        ),
        ''
      )
    end;
$$;

create function app.packaging_token (
  p_kind text,
  p_order_type_key jsonb,
  p_pos_item_id text,
  p_size_key jsonb
) returns text language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_identity text := app.packaging_identity (
    p_kind,
    p_order_type_key,
    p_pos_item_id,
    p_size_key
  );
  v_subject uuid := app.packaging_subject_id (
    p_kind,
    p_order_type_key,
    p_pos_item_id,
    p_size_key
  );
  v_body text;
begin
  select
    pg_catalog.string_agg(
      app.packaging_schedule_line (
        v.id,
        v.effective_from,
        v.effective_to,
        app.packaging_body (
          v.decision,
          app.packaging_version_lines_json (v.id)
        )
      ),
      ','
      order by
        v.effective_from,
        v.id
    )
  into v_body
  from
    app.packaging_versions v
  where
    v.subject_id = v_subject
    and v.superseded_change_id is null;

  return pg_catalog.md5 (v_identity || coalesce(v_body, ''));
end;
$$;

comment on function app.packaging_token (text, jsonb, text, jsonb) is 'md5 of the packaging subject identity plus every non-superseded version line. An empty schedule hashes the identity alone. Internal.';

create function app.packaging_assert_keys (p_node jsonb) returns void language plpgsql immutable
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
        raise exception 'price-like key "%" is not allowed in a packaging payload', v_key
          using errcode = '22023';
      end if;

      perform app.packaging_assert_keys (v_value);
    end loop;
  elsif pg_catalog.jsonb_typeof (p_node) = 'array' then
    for v_value in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements (p_node) as e
    loop
      perform app.packaging_assert_keys (v_value);
    end loop;
  end if;
end;
$$;

create function app.packaging_positive_numeric (p_value jsonb, p_what text) returns numeric language plpgsql immutable
set
  search_path = '' as $$
declare
  v_text text;
  v_qty numeric;
begin
  if p_value is null
  or pg_catalog.jsonb_typeof (p_value) = 'null' then
    raise exception '% must be a finite number greater than 0', p_what
      using errcode = '22023';
  end if;

  v_text := p_value #>> '{}';

  if pg_catalog.jsonb_typeof (p_value) = 'string'
  and v_text !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception '% must be a finite number greater than 0', p_what
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof (p_value) not in ('number', 'string')
  or length(v_text) > 40 then
    raise exception '% must be a finite number greater than 0', p_what
      using errcode = '22023';
  end if;

  begin
    v_qty := v_text::numeric;
  exception
    when invalid_text_representation then
      raise exception '% must be a finite number greater than 0', p_what
        using errcode = '22023';
  end;

  if v_qty is null
  or v_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or v_qty <= 0 then
    raise exception '% must be a finite number greater than 0', p_what
      using errcode = '22023';
  end if;

  return pg_catalog.trim_scale (v_qty);
end;
$$;

create function app.packaging_normalize_policy (p_policy jsonb, p_allow_capacity boolean) returns jsonb language plpgsql stable
set
  search_path = '' as $$
declare
  v_keys text[];
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_line_keys text[];
  v_seen uuid[] := '{}'::uuid[];
  v_item uuid;
  v_qty numeric;
  v_unit text;
  v_cap numeric;
begin
  if p_policy is null
  or pg_catalog.jsonb_typeof (p_policy) = 'null' then
    return null;
  end if;

  if pg_catalog.jsonb_typeof (p_policy) <> 'object' then
    raise exception 'packaging policy must be an object'
      using errcode = '22023';
  end if;

  perform app.packaging_assert_keys (p_policy);

  select
    pg_catalog.array_agg(
      e.key
      order by
        e.key
    )
  into v_keys
  from
    pg_catalog.jsonb_object_keys (p_policy) as e (key);

  if v_keys = array['none']::text[] then
    if pg_catalog.jsonb_typeof (p_policy -> 'none') is distinct from 'boolean'
    or (p_policy ->> 'none') is distinct from 'true' then
      raise exception 'approved none must be true'
        using errcode = '22023';
    end if;

    return pg_catalog.jsonb_build_object('none', true);
  end if;

  if v_keys is distinct from array['lines']::text[] then
    raise exception 'unknown key in packaging policy'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof (p_policy -> 'lines') <> 'array'
  or pg_catalog.jsonb_array_length (p_policy -> 'lines') < 1 then
    raise exception 'a packaging list needs at least one line'
      using errcode = '22023';
  end if;

  for v_line in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements (p_policy -> 'lines') as e
  loop
    if pg_catalog.jsonb_typeof (v_line) <> 'object' then
      raise exception 'a packaging line must be an object'
        using errcode = '22023';
    end if;

    select
      pg_catalog.array_agg(
        e.key
        order by
          e.key
      )
    into v_line_keys
    from
      pg_catalog.jsonb_object_keys (v_line) as e (key);

    if pg_catalog.jsonb_exists (v_line, 'capacity_kg')
    and not p_allow_capacity then
      raise exception 'order packaging has no capacity'
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_exists (v_line, 'capacity_kg') then
      if v_line_keys is distinct from array['capacity_kg', 'quantity', 'stock_item_id', 'unit']::text[] then
        raise exception 'unknown key in packaging policy'
          using errcode = '22023';
      end if;
    elsif v_line_keys is distinct from array['quantity', 'stock_item_id', 'unit']::text[] then
      raise exception 'unknown key in packaging policy'
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof (v_line -> 'stock_item_id') <> 'string'
    or pg_catalog.jsonb_typeof (v_line -> 'unit') <> 'string' then
      raise exception 'packaging line fields must be scalars'
        using errcode = '22023';
    end if;

    begin
      v_item := (v_line ->> 'stock_item_id')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'stock_item_id must be a uuid'
          using errcode = '22023';
    end;

    if v_item = any (v_seen) then
      raise exception 'a packaging list names an item twice'
        using errcode = '22023';
    end if;

    v_seen := pg_catalog.array_append(v_seen, v_item);
    v_qty := app.packaging_positive_numeric (v_line -> 'quantity', 'quantity');
    v_unit := btrim(v_line ->> 'unit');

    if v_unit is null
    or v_unit = '' then
      raise exception 'unit is required'
        using errcode = '22023';
    end if;

    v_cap := null;

    if pg_catalog.jsonb_exists (v_line, 'capacity_kg') then
      v_cap := app.packaging_positive_numeric (v_line -> 'capacity_kg', 'capacity_kg');
    end if;

    v_lines := v_lines || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_strip_nulls (
        pg_catalog.jsonb_build_object(
          'capacity_kg',
          v_cap,
          'quantity',
          v_qty,
          'stock_item_id',
          v_item,
          'unit',
          v_unit
        )
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object('lines', v_lines);
end;
$$;

comment on function app.packaging_normalize_policy (jsonb, boolean) is 'Canonical packaging policy. Null is a gap. {"none": true} is an approved absence. {"lines": [...]} is an approved list. Does not read the catalog. Unknown and price-like keys raise 22023. Internal.';

-- ============================================================================
-- D. Dated write. Replay happens before item kind, unit codes, or the token.
-- ============================================================================
create function app.packaging_with_subject (
  p_result jsonb,
  p_kind text,
  p_order_type_key jsonb,
  p_pos_item_id text,
  p_size_key jsonb
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
begin
  if pg_catalog.jsonb_exists (p_result, 'subject_id') then
    return p_result;
  end if;

  return p_result || pg_catalog.jsonb_build_object(
    'subject_id',
    app.packaging_subject_id (
      p_kind,
      p_order_type_key,
      p_pos_item_id,
      p_size_key
    )
  );
end;
$$;

create function app.packaging_apply (
  p_fn text,
  p_kind text,
  p_request_id uuid,
  p_order_type text,
  p_order_type_key jsonb,
  p_pos_item_id text,
  p_size_key jsonb,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_policy jsonb,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql volatile security definer
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
  v_result jsonb;
  v_change_id bigint;
  v_gap boolean;
  v_decision text;
  v_resolved jsonb := '[]'::jsonb;
  v_line jsonb;
  v_item uuid;
  v_item_kind text;
  v_unit text;
  v_qty numeric;
  v_cap numeric;
  v_superseded uuid[] := '{}'::uuid[];
  v_ids uuid[] := '{}'::uuid[];
  v_froms timestamptz[] := '{}'::timestamptz[];
  v_tos timestamptz[] := '{}'::timestamptz[];
  v_decisions text[] := '{}'::text[];
  v_line_json jsonb[] := '{}'::jsonb[];
  v_row record;
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

  if p_kind is distinct from 'order_type'
  and p_kind is distinct from 'base' then
    raise exception 'packaging subject kind must be order_type or base'
      using errcode = '22023';
  end if;

  if p_kind = 'order_type'
  and p_order_type is not null
  and length(btrim(p_order_type)) > 200 then
    raise exception 'order_type must be at most 200 characters'
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

  v_gap := p_policy is null;
  v_payload := pg_catalog.jsonb_build_object(
    'effective_from',
    case
      when v_from_is_now then 'now'
      else app.costing_timestamptz_text (p_effective_from)
    end,
    'effective_to',
    app.costing_timestamptz_text (p_effective_to),
    'expected_token',
    p_expected_token,
    'fn',
    p_fn,
    'kind',
    p_kind,
    'order_type',
    p_order_type,
    'policy',
    p_policy,
    'pos_item_id',
    p_pos_item_id,
    'reason',
    v_reason,
    'size_key',
    p_size_key
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

  v_identity := app.packaging_identity (
    p_kind,
    p_order_type_key,
    p_pos_item_id,
    p_size_key
  );
  v_subject := app.packaging_subject_id (
    p_kind,
    p_order_type_key,
    p_pos_item_id,
    p_size_key
  );

  if v_subject is not null then
    perform 1
    from
      app.packaging_subjects s
    where
      s.id = v_subject
    for update;
  end if;

  v_token := app.packaging_token (
    p_kind,
    p_order_type_key,
    p_pos_item_id,
    p_size_key
  );

  if v_token is distinct from p_expected_token then
    raise exception 'configuration changed'
      using errcode = '40001';
  end if;

  -- Replay already returned. Item kind and unit codes can change after a
  -- committed request, so a retry must not be rejected by their current state.
  if not v_gap
  and pg_catalog.jsonb_exists (p_policy, 'lines') then
    for v_line in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements (p_policy -> 'lines') as e
    loop
      v_item := (v_line ->> 'stock_item_id')::uuid;
      v_qty := (v_line ->> 'quantity')::numeric;
      v_cap := (v_line ->> 'capacity_kg')::numeric;

      select
        si.kind
      into v_item_kind
      from
        app.stock_items si
      where
        si.id = v_item;

      if v_item_kind is null then
        raise exception 'unknown stock_item id: %', v_item
          using errcode = '22023';
      end if;

      if v_item_kind is distinct from 'packaging' then
        raise exception 'only packaging items can be packaging targets'
          using errcode = '22023';
      end if;

      v_unit := app.resolve_unit_code (v_line ->> 'unit');

      if v_unit is null then
        raise exception 'unknown unit "%"', v_line ->> 'unit'
          using errcode = '22023';
      end if;

      v_resolved := v_resolved || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_strip_nulls (
          pg_catalog.jsonb_build_object(
            'capacity_kg',
            v_cap,
            'quantity',
            v_qty,
            'stock_item_id',
            v_item,
            'unit',
            v_unit
          )
        )
      );
    end loop;

    v_decision := 'lines';
  elsif not v_gap then
    v_decision := 'none';
  end if;

  select
    case
      when exists (
        select
          1
        from
          app.packaging_versions v
        where
          v.subject_id = v_subject
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
          app.packaging_versions v
        where
          v.subject_id = v_subject
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
          app.packaging_versions v
        where
          v.subject_id = v_subject
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

  for v_row in
  select
    v.id,
    v.effective_from,
    v.effective_to,
    v.decision
  from
    app.packaging_versions v
  where
    v.subject_id = v_subject
    and v.superseded_change_id is null
    and v.valid_during && pg_catalog.tstzrange (v_effective_from, p_effective_to, '[)')
  order by
    v.effective_from,
    v.id
  for update
  loop
    v_superseded := pg_catalog.array_append(v_superseded, v_row.id);

    if v_row.effective_from < v_effective_from then
      v_ids := pg_catalog.array_append(v_ids, pg_catalog.gen_random_uuid ());
      v_froms := pg_catalog.array_append(v_froms, v_row.effective_from);
      v_tos := pg_catalog.array_append(v_tos, v_effective_from);
      v_decisions := pg_catalog.array_append(v_decisions, v_row.decision);
      v_line_json := pg_catalog.array_append(
        v_line_json,
        app.packaging_version_lines_json (v_row.id)
      );
    end if;

    if p_effective_to is not null
    and (
      v_row.effective_to is null
      or v_row.effective_to > p_effective_to
    ) then
      v_ids := pg_catalog.array_append(v_ids, pg_catalog.gen_random_uuid ());
      v_froms := pg_catalog.array_append(v_froms, p_effective_to);
      v_tos := pg_catalog.array_append(v_tos, v_row.effective_to);
      v_decisions := pg_catalog.array_append(v_decisions, v_row.decision);
      v_line_json := pg_catalog.array_append(
        v_line_json,
        app.packaging_version_lines_json (v_row.id)
      );
    end if;
  end loop;

  if not v_gap then
    v_ids := pg_catalog.array_append(v_ids, pg_catalog.gen_random_uuid ());
    v_froms := pg_catalog.array_append(v_froms, v_effective_from);
    v_tos := pg_catalog.array_append(v_tos, p_effective_to);
    v_decisions := pg_catalog.array_append(v_decisions, v_decision);
    v_line_json := pg_catalog.array_append(
      v_line_json,
      case
        when v_decision = 'lines' then v_resolved
        else '[]'::jsonb
      end
    );
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
        app.packaging_schedule_line (
          v.id,
          v.effective_from,
          v.effective_to,
          app.packaging_body (
            v.decision,
            app.packaging_version_lines_json (v.id)
          )
        ) as line
      from
        app.packaging_versions v
      where
        v.subject_id = v_subject
        and v.superseded_change_id is null
        and not (v.id = any (v_superseded))
      union all
      select
        v_ids[g.i],
        v_froms[g.i],
        app.packaging_schedule_line (
          v_ids[g.i],
          v_froms[g.i],
          v_tos[g.i],
          app.packaging_body (v_decisions[g.i], v_line_json[g.i])
        )
      from
        pg_catalog.generate_series(1, coalesce(pg_catalog.cardinality (v_ids), 0)) as g (i)
    ) s;

  v_result := app.insert_mapping_costing_change (
    p_request_id,
    v_reason,
    v_payload,
    pg_catalog.jsonb_build_object(
      'inserted',
      pg_catalog.to_jsonb (v_ids),
      'superseded',
      pg_catalog.to_jsonb (v_superseded),
      'token',
      v_new_token
    )
  );
  v_change_id := (v_result -> 'change_id')::bigint;

  if v_subject is null then
    insert into
      app.packaging_subjects (
        kind,
        order_type_key,
        pos_item_id,
        size_key,
        created_change_id
      )
    values
      (
        p_kind,
        case
          when p_kind = 'order_type' then p_order_type_key
          else null
        end,
        case
          when p_kind = 'base' then p_pos_item_id
          else null
        end,
        case
          when p_kind = 'base' then p_size_key
          else null
        end,
        v_change_id
      )
    returning
      id
    into v_subject;
  end if;

  v_result := v_result || pg_catalog.jsonb_build_object('subject_id', v_subject);

  if pg_catalog.cardinality (v_superseded) > 0 then
    update app.packaging_versions
    set
      superseded_change_id = v_change_id
    where
      id = any (v_superseded);
  end if;

  if coalesce(pg_catalog.cardinality (v_ids), 0) > 0 then
    for v_i in 1..pg_catalog.cardinality (v_ids) loop
      insert into
        app.packaging_versions (
          id,
          effective_from,
          effective_to,
          created_change_id,
          subject_id,
          decision
        )
      values
        (
          v_ids[v_i],
          v_froms[v_i],
          v_tos[v_i],
          v_change_id,
          v_subject,
          v_decisions[v_i]
        );

      if v_decisions[v_i] = 'lines' then
        insert into
          app.packaging_lines (
            version_id,
            line_no,
            stock_item_id,
            quantity,
            unit_code,
            capacity_kg
          )
        select
          v_ids[v_i],
          e.ordinality::integer,
          (e.value ->> 'stock_item_id')::uuid,
          pg_catalog.trim_scale ((e.value ->> 'quantity')::numeric),
          e.value ->> 'unit',
          case
            when e.value ->> 'capacity_kg' is null then null
            else pg_catalog.trim_scale ((e.value ->> 'capacity_kg')::numeric)
          end
        from
          pg_catalog.jsonb_array_elements (v_line_json[v_i]) with ordinality as e;
      end if;
    end loop;
  end if;

  execute 'set constraints app.trg_packaging_versions_shape immediate';

  execute 'set constraints app.trg_packaging_versions_shape deferred';

  if app.packaging_token (
    p_kind,
    p_order_type_key,
    p_pos_item_id,
    p_size_key
  ) is distinct from v_new_token then
    raise exception 'internal packaging token mismatch'
      using errcode = '55000';
  end if;

  return v_result;
end;
$$;

comment on function app.packaging_apply (
  text,
  text,
  uuid,
  text,
  jsonb,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
) is 'Dates one packaging policy. Null policy leaves a gap. Replay returns the sealed audit row, which has no subject_id; the wrapper adds it. Takes advisory lock 7342750000000000001. Owner only. Internal.';

create function app.set_order_type_packaging (
  p_request_id uuid,
  p_order_type text,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_policy jsonb,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_type text;
  v_key jsonb;
  v_policy jsonb;
  v_result jsonb;
begin
  perform app.assert_ledger_write_allowed ();
  v_type := nullif(btrim(p_order_type), '');
  v_key := app.packaging_order_type_key (v_type);
  v_policy := app.packaging_normalize_policy (p_policy, false);
  v_result := app.packaging_apply (
    'set_order_type_packaging',
    'order_type',
    p_request_id,
    v_type,
    v_key,
    null,
    null,
    p_effective_from,
    p_effective_to,
    v_policy,
    p_expected_token,
    p_reason
  );
  return app.packaging_with_subject (v_result, 'order_type', v_key, null, null);
end;
$$;

comment on function app.set_order_type_packaging (
  uuid,
  text,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
) is 'Dates the once-per-order packaging policy of one POS order type. A blank type is the ["none"] subject. Null policy leaves a gap. {"none": true} approves no packaging. Lines have no capacity. Takes advisory lock 7342750000000000001 first. Owner only.';

create function app.set_base_packaging (
  p_request_id uuid,
  p_pos_item_id text,
  p_size_key jsonb,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_policy jsonb,
  p_expected_token text,
  p_reason text
) returns jsonb language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_policy jsonb;
  v_result jsonb;
begin
  perform app.assert_ledger_write_allowed ();
  v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
  v_key := app.pos_size_key_normalize (p_size_key);
  v_policy := app.packaging_normalize_policy (p_policy, true);
  v_result := app.packaging_apply (
    'set_base_packaging',
    'base',
    p_request_id,
    null,
    null,
    v_item,
    v_key,
    p_effective_from,
    p_effective_to,
    v_policy,
    p_expected_token,
    p_reason
  );
  return app.packaging_with_subject (v_result, 'base', null, v_item, v_key);
end;
$$;

comment on function app.set_base_packaging (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
) is 'Dates the packaging policy of one POS item and size. A line may carry capacity_kg. Null policy leaves a gap. Takes advisory lock 7342750000000000001 first. Owner only.';

-- ============================================================================
-- E. Schedules. Quantities are decimal text, never JSON numbers.
-- ============================================================================
create function app.packaging_versions_json (p_subject uuid) returns jsonb language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',
          v.id,
          'effective_from',
          v.effective_from,
          'effective_to',
          v.effective_to,
          'decision',
          v.decision,
          'lines',
          coalesce(
            (
              select
                pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'stock_item_id',
                    l.stock_item_id,
                    'quantity',
                    pg_catalog.to_jsonb (pg_catalog.trim_scale (l.quantity)::text),
                    'unit_code',
                    l.unit_code,
                    'capacity_kg',
                    case
                      when l.capacity_kg is null then 'null'::jsonb
                      else pg_catalog.to_jsonb (pg_catalog.trim_scale (l.capacity_kg)::text)
                    end
                  )
                  order by
                    l.line_no
                )
              from
                app.packaging_lines l
              where
                l.version_id = v.id
            ),
            '[]'::jsonb
          )
        )
        order by
          v.effective_from,
          v.id
      ),
      '[]'::jsonb
    )
  from
    app.packaging_versions v
  where
    v.subject_id = p_subject
    and v.superseded_change_id is null;
$$;

create function app.packaging_order_type_schedule (p_order_type text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_type text := nullif(btrim(p_order_type), '');
  v_key jsonb;
  v_identity text;
  v_subject uuid;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_key := app.packaging_order_type_key (v_type);
  v_identity := app.packaging_identity ('order_type', v_key, null, null);
  v_subject := app.packaging_subject_id ('order_type', v_key, null, null);

  return pg_catalog.jsonb_build_object(
    'subject_id',
    v_subject,
    'order_type_key',
    v_key,
    'identity',
    v_identity,
    'token',
    app.packaging_token ('order_type', v_key, null, null),
    'empty_token',
    pg_catalog.md5 (v_identity),
    'versions',
    app.packaging_versions_json (v_subject)
  );
end;
$$;

comment on function app.packaging_order_type_schedule (text) is 'Owner read of one order-type packaging subject. A blank type is ["none"]. The token is the empty-schedule token until the first version. Quantities and capacity are decimal text.';

create function app.packaging_base_schedule (p_pos_item_id text, p_size_key jsonb) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_key jsonb;
  v_identity text;
  v_subject uuid;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_item := app.pos_text_id (p_pos_item_id, 'pos_item_id');
  v_key := app.pos_size_key_normalize (p_size_key);
  v_identity := app.packaging_identity ('base', null, v_item, v_key);
  v_subject := app.packaging_subject_id ('base', null, v_item, v_key);

  return pg_catalog.jsonb_build_object(
    'subject_id',
    v_subject,
    'pos_item_id',
    v_item,
    'size_key',
    v_key,
    'identity',
    v_identity,
    'token',
    app.packaging_token ('base', null, v_item, v_key),
    'empty_token',
    pg_catalog.md5 (v_identity),
    'versions',
    app.packaging_versions_json (v_subject)
  );
end;
$$;

comment on function app.packaging_base_schedule (text, jsonb) is 'Owner read of one base packaging subject. The token is the empty-schedule token until the first version. Quantities and capacity are decimal text.';

-- ============================================================================
-- F. Order requirements. Line math stays in resolve_line_requirements_exact.
-- Packaging does not apply marine loss: a container count is not a net weight.
-- ============================================================================
create function app.packaging_kg_scale (p_qty numeric, p_unit text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_unit text;
  v_num numeric;
  v_den numeric;
begin
  v_unit := app.resolve_unit_code (p_unit);

  if v_unit is null then
    return pg_catalog.jsonb_build_object('ok', false);
  end if;

  select
    r.ratio_num,
    r.ratio_den
  into v_num,
    v_den
  from
    app.recipe_unit_ratio (v_unit, 'kg') r;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'ok',
    true,
    'numerator',
    p_qty * v_num,
    'denominator',
    v_den
  );
end;
$$;

create function app.packaging_expand (
  p_kind text,
  p_order_type_key jsonb,
  p_pos_item_id text,
  p_size_key jsonb,
  p_at timestamptz,
  p_weighted boolean,
  p_scale_ok boolean,
  p_scale_num numeric,
  p_scale_den numeric,
  p_line_id text
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_id uuid;
  v_decision text;
  v_issues jsonb := '[]'::jsonb;
  v_reqs jsonb := '[]'::jsonb;
  v_paths jsonb := '[]'::jsonb;
  v_role text;
  v_line record;
  v_factor numeric;
  v_num numeric;
  v_den numeric;
  v_containers numeric;
  v_step numeric;
  v_state text;
begin
  v_role := case
    when p_kind = 'order_type' then 'order_type'
    else 'base'
  end;

  if p_kind = 'order_type' then
    select
      v.id,
      v.decision
    into v_id,
      v_decision
    from
      app.packaging_versions v
      join app.packaging_subjects s on s.id = v.subject_id
    where
      s.kind = 'order_type'
      and s.order_type_key = p_order_type_key
      and v.superseded_change_id is null
      and v.valid_during @> p_at
    order by
      v.id
    limit
      1;
  else
    select
      v.id,
      v.decision
    into v_id,
      v_decision
    from
      app.packaging_versions v
      join app.packaging_subjects s on s.id = v.subject_id
    where
      s.kind = 'base'
      and s.pos_item_id = p_pos_item_id
      and s.size_key = p_size_key
      and v.superseded_change_id is null
      and v.valid_during @> p_at
    order by
      v.id
    limit
      1;
  end if;

  if v_id is null then
    return pg_catalog.jsonb_build_object(
      'state',
      'gap',
      'version_id',
      null,
      'issues',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_strip_nulls (
          pg_catalog.jsonb_build_object(
            'code',
            'packaging_unreviewed',
            'role',
            v_role,
            'line_id',
            p_line_id,
            'order_type_key',
            p_order_type_key,
            'pos_item_id',
            p_pos_item_id,
            'size_key',
            p_size_key
          )
        )
      ),
      'requirements',
      null,
      'paths',
      '[]'::jsonb
    );
  end if;

  if v_decision = 'none' then
    return pg_catalog.jsonb_build_object(
      'state',
      'none',
      'version_id',
      v_id,
      'issues',
      '[]'::jsonb,
      'requirements',
      '[]'::jsonb,
      'paths',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_strip_nulls (
          pg_catalog.jsonb_build_object(
            'source',
            case
              when p_kind = 'order_type' then 'order_packaging'
              else 'item_packaging'
            end,
            'line_id',
            p_line_id,
            'packaging_version_id',
            v_id,
            'decision',
            'none'
          )
        )
      )
    );
  end if;

  if p_kind = 'base'
  and p_weighted
  and not p_scale_ok then
    return pg_catalog.jsonb_build_object(
      'state',
      'blocked',
      'version_id',
      v_id,
      'issues',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_strip_nulls (
          pg_catalog.jsonb_build_object(
            'code',
            'packaging_weight_unit',
            'role',
            'base',
            'line_id',
            p_line_id,
            'pos_item_id',
            p_pos_item_id,
            'size_key',
            p_size_key
          )
        )
      ),
      'requirements',
      null,
      'paths',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'source',
          'item_packaging',
          'line_id',
          p_line_id,
          'packaging_version_id',
          v_id,
          'decision',
          'lines',
          'state',
          'blocked'
        )
      )
    );
  end if;

  for v_line in
  select
    l.stock_item_id,
    l.quantity,
    l.unit_code,
    l.capacity_kg,
    l.line_no,
    si.kind,
    si.base_unit
  from
    app.packaging_lines l
    join app.stock_items si on si.id = l.stock_item_id
  where
    l.version_id = v_id
  order by
    l.line_no
  loop
    v_num := null;
    v_den := null;
    v_containers := null;
    v_factor := null;

    if v_line.kind is distinct from 'packaging' then
      v_issues := v_issues || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_strip_nulls (
          pg_catalog.jsonb_build_object(
            'code',
            'packaging_kind',
            'role',
            v_role,
            'line_id',
            p_line_id,
            'stock_item_id',
            v_line.stock_item_id
          )
        )
      );
    else
      begin
        v_factor := app.item_factor_at (v_line.stock_item_id, v_line.unit_code, p_at);
      exception
        when sqlstate '22023' then
          v_factor := null;
      end;

      if v_factor is null then
        v_issues := v_issues || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_strip_nulls (
            pg_catalog.jsonb_build_object(
              'code',
              'packaging_unit',
              'role',
              v_role,
              'line_id',
              p_line_id,
              'stock_item_id',
              v_line.stock_item_id,
              'unit',
              v_line.unit_code
            )
          )
        );
      elsif p_kind = 'order_type' then
        v_num := v_line.quantity * v_factor;
        v_den := 1;
      elsif p_weighted
      and v_line.capacity_kg is not null then
        -- ceil(kg / capacity) from the exact fraction. Numeric division
        -- rounds the quotient, so 3 / 2.99999999999999999 becomes 1.
        v_step := p_scale_den * v_line.capacity_kg;

        if p_scale_num > 0
        and v_step > 0
        and p_scale_num not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        and v_step not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
          v_containers := pg_catalog.div (p_scale_num, v_step);

          if p_scale_num - v_containers * v_step > 0 then
            v_containers := v_containers + 1;
          end if;
        end if;

        if v_containers > 0 then
          v_num := v_containers * v_line.quantity * v_factor;
          v_den := 1;
        end if;
      else
        v_num := p_scale_num * v_line.quantity * v_factor;
        v_den := p_scale_den;
      end if;
    end if;

    if v_num is not null
    and v_den is not null
    and v_den > 0
    and v_num > 0 then
      v_reqs := v_reqs || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'stock_item_id',
          v_line.stock_item_id,
          'base_unit',
          v_line.base_unit,
          'numerator',
          v_num,
          'denominator',
          v_den
        )
      );
    end if;

    v_paths := v_paths || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_strip_nulls (
        pg_catalog.jsonb_build_object(
          'source',
          case
            when p_kind = 'order_type' then 'order_packaging'
            else 'item_packaging'
          end,
          'line_id',
          p_line_id,
          'packaging_version_id',
          v_id,
          'decision',
          'lines',
          'stock_item_id',
          v_line.stock_item_id,
          'containers',
          case
            when v_containers is null then null
            else pg_catalog.to_jsonb (pg_catalog.trim_scale (v_containers)::text)
          end
        )
      )
    );
  end loop;

  if pg_catalog.jsonb_array_length (v_issues) > 0 then
    v_state := 'blocked';
    v_reqs := null;
  else
    v_state := 'lines';
  end if;

  return pg_catalog.jsonb_build_object(
    'state',
    v_state,
    'version_id',
    v_id,
    'issues',
    v_issues,
    'requirements',
    v_reqs,
    'paths',
    v_paths
  );
end;
$$;

create function app.packaging_distinct_ids (p_ids jsonb) returns jsonb language sql immutable
set
  search_path = '' as $$
  select
    coalesce(
      pg_catalog.jsonb_agg(
        d.value
        order by
          d.value::text
      ),
      '[]'::jsonb
    )
  from
    (
      select distinct
        e.value
      from
        pg_catalog.jsonb_array_elements (coalesce(p_ids, '[]'::jsonb)) as e
    ) d;
$$;

-- Paths already produced by recipe_expand_exact, annotated with the order
-- line. The recipe id chain is the walk path; the leaf stock item is appended
-- so a dish that uses a batch shows dish, batch and stock. A batch or a
-- cooking recipe in a role the line lookup rejects contributes nothing,
-- matching pos_map_expand_target.
create function app.packaging_target_recipe_paths (
  p_target_kind text,
  p_recipe_id uuid,
  p_at timestamptz,
  p_weighted boolean,
  p_role text,
  p_scale_num numeric,
  p_scale_den numeric,
  p_line_id text,
  p_pos_item_id text,
  p_size_key jsonb,
  p_option_value text,
  p_mapping_version_id uuid
) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_kind text;
  v_exact jsonb;
  v_paths jsonb;
begin
  if p_target_kind is distinct from 'recipe'
  or p_recipe_id is null
  or p_scale_num is null
  or p_scale_den is null
  or p_scale_num <= 0
  or p_scale_den <= 0 then
    return '[]'::jsonb;
  end if;

  select
    r.kind
  into v_kind
  from
    app.recipes r
  where
    r.id = p_recipe_id;

  if v_kind is null
  or v_kind = 'batch'
  or (
    v_kind = 'cooking'
    and (
      p_role is distinct from 'option'
      or not p_weighted
    )
  ) then
    return '[]'::jsonb;
  end if;

  v_exact := app.recipe_expand_exact (
    p_recipe_id,
    p_at,
    p_scale_num,
    p_scale_den,
    (not p_weighted)
    or p_role is distinct from 'base'
  );

  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls (
          pg_catalog.jsonb_build_object(
            'source',
            'recipe',
            'line_id',
            p_line_id,
            'role',
            p_role,
            'pos_item_id',
            p_pos_item_id,
            'size_key',
            p_size_key,
            'option_value',
            p_option_value,
            'mapping_version_id',
            p_mapping_version_id,
            'recipe_line_id',
            e.value ->> 'line_id',
            'stock_item_id',
            e.value ->> 'stock_item_id',
            'path',
            (e.value -> 'path') || pg_catalog.jsonb_build_array(e.value ->> 'stock_item_id')
          )
        )
        order by
          e.ordinality
      ),
      '[]'::jsonb
    )
  into v_paths
  from
    pg_catalog.jsonb_array_elements (
      coalesce(v_exact -> 'provenance' -> 'paths', '[]'::jsonb)
    ) with ordinality as e (value, ordinality);

  return v_paths;
end;
$$;

comment on function app.packaging_target_recipe_paths (
  text,
  uuid,
  timestamptz,
  boolean,
  text,
  numeric,
  numeric,
  text,
  text,
  jsonb,
  text,
  uuid
) is 'Recipe expansion paths for one mapping target, from recipe_expand_exact. Each path is the recipe chain plus the leaf stock item, with the order line, role and option value. Internal.';

-- Same expand gates as the line lookup: an exception or an unusable weight
-- stops the line, none_expected ignores options, and a repeated option value
-- is ambiguous. Item-scoped option mappings win over the global one.
create function app.packaging_line_recipe_paths (p_order_id text, p_line_id text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_item text;
  v_ordered timestamptz;
  v_qty numeric;
  v_weighted numeric;
  v_weighted_unit text;
  v_options jsonb;
  v_key jsonb;
  v_map_id uuid;
  v_map_kind text;
  v_map_recipe uuid;
  v_exc_id uuid;
  v_policy text;
  v_weighted_line boolean;
  v_scale_num numeric;
  v_scale_den numeric;
  v_unit_code text;
  v_ratio_num numeric;
  v_ratio_den numeric;
  v_stop boolean := false;
  v_paths jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_values text[] := '{}'::text[];
  v_opt record;
  v_opt_id uuid;
  v_opt_kind text;
  v_opt_recipe uuid;
begin
  select
    l.item_id,
    o.ordered_at,
    l.quantity,
    l.weighted_qty,
    l.weighted_unit,
    l.options
  into v_item,
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
    return '[]'::jsonb;
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
    v.recipe_id
  into v_map_id,
    v_map_kind,
    v_map_recipe
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
    v.option_policy
  into v_policy
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

  if v_exc_id is not null then
    return '[]'::jsonb;
  end if;

  v_weighted_line := v_weighted is not null;

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
      v_stop := true;
    end if;
  else
    v_scale_num := v_qty;
    v_scale_den := 1;
  end if;

  if v_stop then
    return '[]'::jsonb;
  end if;

  if v_map_id is not null then
    v_paths := v_paths || app.packaging_target_recipe_paths (
      v_map_kind,
      v_map_recipe,
      v_ordered,
      v_weighted_line,
      'base',
      v_scale_num,
      v_scale_den,
      p_line_id,
      v_item,
      v_key,
      null,
      v_map_id
    );
  end if;

  if v_policy = 'none_expected' then
    return v_paths;
  end if;

  for v_elem in
  select
    e.value
  from
    pg_catalog.jsonb_array_elements (coalesce(v_options, '[]'::jsonb)) as e
  loop
    if pg_catalog.jsonb_typeof (v_elem) = 'object'
    and nullif(btrim(v_elem ->> 'value'), '') is not null then
      v_values := pg_catalog.array_append(v_values, btrim(v_elem ->> 'value'));
    end if;
  end loop;

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
      continue;
    end if;

    v_opt_id := null;
    v_opt_kind := null;
    v_opt_recipe := null;

    select
      v.id,
      v.target_kind,
      v.recipe_id
    into v_opt_id,
      v_opt_kind,
      v_opt_recipe
    from
      app.pos_map_versions v
      join app.pos_map_subjects s on s.id = v.subject_id
    where
      s.kind = 'option'
      and s.option_scope = 'item'
      and s.pos_item_id = v_item
      and s.size_key = v_key
      and s.option_value = v_opt.val
      and v.family = 'mapping'
      and v.superseded_change_id is null
      and v.valid_during @> v_ordered
    limit
      1;

    if not found then
      select
        v.id,
        v.target_kind,
        v.recipe_id
      into v_opt_id,
        v_opt_kind,
        v_opt_recipe
      from
        app.pos_map_versions v
        join app.pos_map_subjects s on s.id = v.subject_id
      where
        s.kind = 'option'
        and s.option_scope = 'global'
        and s.option_value = v_opt.val
        and s.pos_item_id is null
        and s.size_key is null
        and v.family = 'mapping'
        and v.superseded_change_id is null
        and v.valid_during @> v_ordered
      limit
        1;

      if not found
      or v_opt_kind = 'unmapped' then
        continue;
      end if;
    end if;

    if v_opt_kind in ('unmapped', 'no_stock') then
      continue;
    end if;

    v_paths := v_paths || app.packaging_target_recipe_paths (
      v_opt_kind,
      v_opt_recipe,
      v_ordered,
      v_weighted_line,
      'option',
      v_scale_num,
      v_scale_den,
      p_line_id,
      v_item,
      v_key,
      v_opt.val,
      v_opt_id
    );
  end loop;

  return v_paths;
end;
$$;

comment on function app.packaging_line_recipe_paths (text, text) is 'Recipe expansion paths for one order line at its ordered_at. Base and option contributions carry the order line id, role and, for an option, the option value. Internal.';

create function app.resolve_order_requirements_exact (p_order_id text, p_expected_order_version integer) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_status text;
  v_missing boolean;
  v_ordered timestamptz;
  v_order_type text;
  v_version integer;
  v_cause text;
  v_key jsonb;
  v_exact jsonb;
  v_line record;
  v_weighted boolean;
  v_scale_ok boolean;
  v_scale_num numeric;
  v_scale_den numeric;
  v_kg jsonb;
  v_pack jsonb;
  v_reqs jsonb := '[]'::jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_paths jsonb := '[]'::jsonb;
  v_map_ids jsonb := '[]'::jsonb;
  v_recipe_ids jsonb := '[]'::jsonb;
  v_pack_ids jsonb := '[]'::jsonb;
  v_line_bad boolean := false;
  v_unreviewed boolean := false;
  v_blocked boolean := false;
  v_causes jsonb := '[]'::jsonb;
  v_order_pack jsonb;
  v_sorted jsonb;
begin
  select
    o.status,
    o.missing_from_pos,
    o.ordered_at,
    o.order_type,
    o.version
  into v_status,
    v_missing,
    v_ordered,
    v_order_type,
    v_version
  from
    app.pos_orders o
  where
    o.id = p_order_id;

  if not found then
    raise exception 'unknown order'
      using errcode = '22023';
  end if;

  if p_expected_order_version is not null
  and p_expected_order_version is distinct from v_version then
    raise exception 'order changed'
      using errcode = '40001';
  end if;

  if v_missing
  or v_status <> 'complete' then
    v_cause := case
      when v_missing then 'missing'
      when v_status = 'canceled' then 'canceled'
      when v_status = 'active' then 'open'
      else v_status
    end;

    return pg_catalog.jsonb_build_object(
      'status',
      'sales_only',
      'cause',
      v_cause,
      'requirements',
      null,
      'lines',
      null,
      'order_packaging',
      null,
      'issues',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('code', v_cause, 'role', 'order')
      ),
      'causes',
      '[]'::jsonb,
      'provenance',
      pg_catalog.jsonb_build_object(
        'at',
        app.costing_timestamptz_text (v_ordered),
        'algorithm_version',
        1,
        'mapping_versions',
        '[]'::jsonb,
        'packaging_versions',
        '[]'::jsonb,
        'recipe_versions',
        '[]'::jsonb,
        'paths',
        '[]'::jsonb
      )
    );
  end if;

  v_key := app.packaging_order_type_key (v_order_type);
  v_order_pack := app.packaging_expand (
    'order_type',
    v_key,
    null,
    null,
    v_ordered,
    false,
    true,
    1,
    1,
    null
  );

  if v_order_pack ->> 'state' = 'gap' then
    v_unreviewed := true;
  elsif v_order_pack ->> 'state' = 'blocked' then
    v_blocked := true;
  elsif pg_catalog.jsonb_typeof (v_order_pack -> 'requirements') = 'array' then
    v_reqs := app.pos_map_merge_req (v_reqs, v_order_pack -> 'requirements');
  end if;

  v_issues := v_issues || coalesce(v_order_pack -> 'issues', '[]'::jsonb);
  v_paths := v_paths || coalesce(v_order_pack -> 'paths', '[]'::jsonb);

  if v_order_pack ->> 'version_id' is not null then
    v_pack_ids := v_pack_ids || pg_catalog.jsonb_build_array(v_order_pack -> 'version_id');
  end if;

  for v_line in
  select
    l.line_id,
    l.item_id,
    l.item_name,
    l.size_name,
    l.quantity,
    l.weighted_qty,
    l.weighted_unit
  from
    app.pos_order_lines l
  where
    l.order_id = p_order_id
  order by
    l.line_id
  loop
    v_exact := app.resolve_line_requirements_exact (p_order_id, v_line.line_id);
    v_map_ids := v_map_ids || coalesce(v_exact -> 'provenance' -> 'mapping_versions', '[]'::jsonb);
    v_recipe_ids := v_recipe_ids || coalesce(
      v_exact -> 'provenance' -> 'recipe_versions',
      '[]'::jsonb
    );
    v_paths := v_paths || coalesce(
      (
        select
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_strip_nulls (
              pg_catalog.jsonb_build_object(
                'source',
                'line',
                'line_id',
                v_line.line_id,
                'role',
                e.value -> 'role',
                'pos_item_id',
                e.value -> 'pos_item_id',
                'size_key',
                e.value -> 'size_key',
                'option_value',
                e.value -> 'option_value',
                'mapping_version_id',
                e.value -> 'mapping_version_id',
                'state',
                e.value -> 'state'
              )
            )
          )
        from
          pg_catalog.jsonb_array_elements (coalesce(v_exact -> 'subjects', '[]'::jsonb)) as e
      ),
      '[]'::jsonb
    );
    v_paths := v_paths || app.packaging_line_recipe_paths (p_order_id, v_line.line_id);

    if v_exact ->> 'status' = 'exception' then
      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id',
          v_line.line_id,
          'status',
          'exception',
          'issues',
          coalesce(v_exact -> 'issues', '[]'::jsonb),
          'subjects',
          coalesce(v_exact -> 'subjects', '[]'::jsonb),
          'packaging',
          pg_catalog.jsonb_build_object(
            'state',
            'skipped',
            'version_id',
            null,
            'issues',
            '[]'::jsonb
          )
        )
      );
    else
      if v_exact ->> 'status' is distinct from 'ready' then
        v_line_bad := true;
        v_issues := v_issues || coalesce(v_exact -> 'issues', '[]'::jsonb);
      elsif pg_catalog.jsonb_typeof (v_exact -> 'requirements') = 'array' then
        v_reqs := app.pos_map_merge_req (v_reqs, v_exact -> 'requirements');
      end if;

      v_weighted := v_line.weighted_qty is not null;
      v_scale_ok := true;
      v_scale_num := v_line.quantity;
      v_scale_den := 1;

      if v_weighted then
        v_kg := app.packaging_kg_scale (v_line.weighted_qty, v_line.weighted_unit);
        v_scale_ok := coalesce((v_kg ->> 'ok')::boolean, false);

        if v_scale_ok then
          v_scale_num := (v_kg ->> 'numerator')::numeric;
          v_scale_den := (v_kg ->> 'denominator')::numeric;
        end if;
      end if;

      v_pack := app.packaging_expand (
        'base',
        null,
        v_line.item_id,
        app.pos_size_key (v_line.size_name),
        v_ordered,
        v_weighted,
        v_scale_ok,
        v_scale_num,
        v_scale_den,
        v_line.line_id
      );

      if v_pack ->> 'state' = 'gap' then
        v_unreviewed := true;
      elsif v_pack ->> 'state' = 'blocked' then
        v_blocked := true;
      elsif v_exact ->> 'status' = 'ready'
      and pg_catalog.jsonb_typeof (v_pack -> 'requirements') = 'array' then
        v_reqs := app.pos_map_merge_req (v_reqs, v_pack -> 'requirements');
      end if;

      v_issues := v_issues || coalesce(v_pack -> 'issues', '[]'::jsonb);
      v_paths := v_paths || coalesce(v_pack -> 'paths', '[]'::jsonb);

      if v_pack ->> 'version_id' is not null then
        v_pack_ids := v_pack_ids || pg_catalog.jsonb_build_array(v_pack -> 'version_id');
      end if;

      v_lines := v_lines || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id',
          v_line.line_id,
          'status',
          v_exact ->> 'status',
          'issues',
          coalesce(v_exact -> 'issues', '[]'::jsonb),
          'subjects',
          coalesce(v_exact -> 'subjects', '[]'::jsonb),
          'packaging',
          pg_catalog.jsonb_build_object(
            'state',
            v_pack ->> 'state',
            'version_id',
            v_pack -> 'version_id',
            'issues',
            coalesce(v_pack -> 'issues', '[]'::jsonb)
          )
        )
      );
    end if;
  end loop;

  if v_line_bad then
    v_causes := v_causes || '["line"]'::jsonb;
  end if;

  if v_unreviewed then
    v_causes := v_causes || '["packaging_unreviewed"]'::jsonb;
  end if;

  if v_blocked then
    v_causes := v_causes || '["blocked"]'::jsonb;
  end if;

  if v_line_bad
  or v_unreviewed
  or v_blocked then
    v_status := 'incomplete';
    v_sorted := null;
  else
    v_status := 'ready';

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
  end if;

  return pg_catalog.jsonb_build_object(
    'status',
    v_status,
    'cause',
    null,
    'requirements',
    v_sorted,
    'lines',
    v_lines,
    'order_packaging',
    pg_catalog.jsonb_build_object(
      'order_type_key',
      v_key,
      'state',
      v_order_pack ->> 'state',
      'version_id',
      v_order_pack -> 'version_id',
      'issues',
      coalesce(v_order_pack -> 'issues', '[]'::jsonb)
    ),
    'issues',
    v_issues,
    'causes',
    v_causes,
    'provenance',
    pg_catalog.jsonb_build_object(
      'at',
      app.costing_timestamptz_text (v_ordered),
      'algorithm_version',
      1,
      'mapping_versions',
      app.packaging_distinct_ids (v_map_ids),
      'packaging_versions',
      app.packaging_distinct_ids (v_pack_ids),
      'recipe_versions',
      app.packaging_distinct_ids (v_recipe_ids),
      'paths',
      coalesce(v_paths, '[]'::jsonb)
    )
  );
end;
$$;

comment on function app.resolve_order_requirements_exact (text, integer) is 'Internal order lookup at ordered_at. Requirements are exact fractions summed across lines, options, recipes and packaging, or null unless the order is ready. Nothing is rounded. A non-null expected version that differs from pos_orders.version raises 40001 order changed. Revoked from API roles.';

create function app.resolve_order_requirements (p_order_id text, p_expected_order_version integer) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_exact jsonb;
  v_requirements jsonb;
  v_below jsonb;
  v_causes jsonb;
begin
  if coalesce(app.is_owner (), false) is not true then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_exact := app.resolve_order_requirements_exact (
    p_order_id,
    p_expected_order_version
  );

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
          pg_catalog.to_jsonb (
            pg_catalog.trim_scale (
              (
                pg_catalog.div(
                  2 * (e.value ->> 'numerator')::numeric * 1000000 + (e.value ->> 'denominator')::numeric,
                  2 * (e.value ->> 'denominator')::numeric
                ) * 0.000001
              )::numeric(20, 6)
            )::text
          )
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
    v_causes := coalesce(v_exact -> 'causes', '[]'::jsonb);

    if not (v_causes ? 'blocked') then
      v_causes := v_causes || '["blocked"]'::jsonb;
    end if;

    return v_exact || pg_catalog.jsonb_build_object(
      'status',
      'incomplete',
      'requirements',
      null,
      'issues',
      (v_exact -> 'issues') || v_below,
      'causes',
      v_causes
    );
  end if;

  return v_exact || pg_catalog.jsonb_build_object('requirements', v_requirements);
end;
$$;

comment on function app.resolve_order_requirements (text, integer) is 'Owner lookup of one POS order at its ordered_at. status is sales_only, incomplete, or ready. Requirements are raw stock quantities rounded once to 6 places as decimal text, or null unless ready. A positive order total that rounds to 0 is below_precision and incomplete. A non-null expected version that differs raises 40001 order changed.';

-- ============================================================================
-- G. Coverage keeps the PR 6 line counts and adds the order rollup.
-- ============================================================================
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

comment on function app.pos_mapping_coverage (timestamptz, timestamptz) is 'Owner coverage for shifts that opened in [p_from, p_to). Line counts stay the PR 6 rules. Orders in the same window are eligible when complete, not missing, and at or after the first opening. Order coverage is ready / eligible, null when nothing is eligible. Incomplete orders are counted by cause: line, packaging_unreviewed, and blocked. order_types is the order-type policy coverage of every type seen in the window.';

-- ============================================================================
-- H. A non-superseded packaging line freezes stock identity too.
-- Every previous check is unchanged.
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
  )
  or exists (
    select
      1
    from
      app.packaging_lines l
      join app.packaging_versions v on v.id = l.version_id
    where
      l.stock_item_id = old.id
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

comment on function app.trg_stock_items_freeze_configured_identity () is 'Rejects a base_unit, kind or parent_item_id change while the item has movements, a current loss, conversion or opening price, a line of a non-superseded recipe version, a non-superseded direct POS mapping, or a line of a non-superseded packaging version. Runs after trg_stock_items_configured_identity_lock, which holds the ledger lock.';

-- ============================================================================
-- I. Order types seen on stored orders. Security invoker, so RLS applies.
-- ============================================================================
create view app.packaging_observed_order_types
with
  (security_invoker = true) as
select
  k.order_type_key,
  k.order_type_key::text as order_type_key_text,
  case
    when k.order_type_key = '["none"]'::jsonb then null
    else k.order_type_key ->> 1
  end as order_type_label,
  count(*)::bigint as order_count,
  max(o.ordered_at) as last_ordered_at
from
  app.pos_orders o
  cross join lateral (
    select
      app.packaging_order_type_key (o.order_type) as order_type_key
  ) k
group by
  k.order_type_key;

comment on view app.packaging_observed_order_types is 'Order types seen on stored POS orders. A blank type is ["none"] with a null label. order_count is every stored order. Security invoker.';

create view app.packaging_line_rows
with
  (security_invoker = true) as
select
  l.id,
  l.version_id,
  l.line_no,
  l.stock_item_id,
  l.quantity,
  l.unit_code,
  l.capacity_kg,
  v.subject_id
from
  app.packaging_lines l
  join app.packaging_versions v on v.id = l.version_id;

comment on view app.packaging_line_rows is 'Packaging lines with their subject, including superseded versions, for a keyset history read. Security invoker.';

-- ============================================================================
-- J. RLS and grants. API roles can read as the owner. They cannot write.
-- ============================================================================
alter table app.packaging_subjects enable row level security;

alter table app.packaging_versions enable row level security;

alter table app.packaging_lines enable row level security;

create policy packaging_subjects_select_owner on app.packaging_subjects for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy packaging_versions_select_owner on app.packaging_versions for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

create policy packaging_lines_select_owner on app.packaging_lines for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.packaging_subjects
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.packaging_versions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.packaging_lines
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.packaging_subjects,
  app.packaging_versions,
  app.packaging_lines to authenticated,
  service_role;

revoke all on table app.packaging_observed_order_types
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.packaging_line_rows
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.packaging_observed_order_types,
  app.packaging_line_rows to authenticated,
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
        'packaging_order_type_key',
        'trg_packaging_subjects_immutable',
        'trg_packaging_lines_immutable',
        'trg_packaging_lines_target',
        'trg_packaging_versions_shape',
        'packaging_identity',
        'packaging_subject_id',
        'packaging_schedule_line',
        'packaging_version_lines_json',
        'packaging_body',
        'packaging_token',
        'packaging_assert_keys',
        'packaging_positive_numeric',
        'packaging_normalize_policy',
        'packaging_with_subject',
        'packaging_apply',
        'set_order_type_packaging',
        'set_base_packaging',
        'packaging_versions_json',
        'packaging_order_type_schedule',
        'packaging_base_schedule',
        'packaging_kg_scale',
        'packaging_expand',
        'packaging_target_recipe_paths',
        'packaging_line_recipe_paths',
        'packaging_distinct_ids',
        'resolve_order_requirements_exact',
        'resolve_order_requirements'
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

-- PR 6 grants service_role SELECT on its security-invoker views. This view
-- calls packaging_order_type_key, so the same role needs EXECUTE on that
-- pure helper or a populated read fails.
grant
execute on function app.packaging_order_type_key (text) to authenticated,
service_role;

grant
execute on function app.set_order_type_packaging (
  uuid,
  text,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
),
app.set_base_packaging (
  uuid,
  text,
  jsonb,
  timestamptz,
  timestamptz,
  jsonb,
  text,
  text
),
app.packaging_order_type_schedule (text),
app.packaging_base_schedule (text, jsonb),
app.resolve_order_requirements (text, integer) to authenticated;
