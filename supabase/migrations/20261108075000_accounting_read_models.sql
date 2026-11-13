-- Owner read models for the phase 5 screens. No tables and no writers.
-- Deductions stay dormant until a later migration records activation.
-- Money and quantities leave as decimal text. Times use costing_timestamptz_text.
-- Safe failure reasons are an allow-list. Raw database text is not returned.
create function app.accounting_processing_summary () returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_result jsonb;
begin
  if not app.is_owner () then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  select
    pg_catalog.jsonb_build_object(
      'activated',
      exists (
        select
          1
        from
          app.inventory_activation
      ),
      'pending_count',
      (
        select
          count(*)::text
        from
          (
            select
              e.order_id
            from
              app.accounting_work_events e
              left join app.accounting_work_state ws on ws.order_id = e.order_id
            where
              e.processed_at is null
            group by
              e.order_id
            having
              max(ws.failed_at) is null
              or pg_catalog.bool_or(e.work_generation is null)
          ) pending_orders
      ),
      'blocked_count',
      (
        select
          count(*)::text
        from
          app.accounting_work_state ws
        where
          ws.last_outcome = 'blocked'
          and ws.failed_at is null
      ),
      'failed_count',
      (
        select
          count(*)::text
        from
          app.accounting_work_state ws
        where
          ws.failed_at is not null
      ),
      'processed_event_count',
      (
        select
          count(*)::text
        from
          app.accounting_work_events e
        where
          e.processed_at is not null
      ),
      'open_event_count',
      (
        select
          count(*)::text
        from
          app.accounting_work_events e
        where
          e.processed_at is null
      ),
      'open_span_count',
      (
        select
          count(*)::text
        from
          app.accounting_rederive_spans sp
        where
          sp.completed_at is null
      ),
      'coverage',
      (
        select
          pg_catalog.jsonb_build_object(
            'run_id',
            cov.run_id::text,
            'started_at',
            app.costing_timestamptz_text (cov.started_at),
            'finished_at',
            app.costing_timestamptz_text (cov.finished_at),
            'orders_scope_applied',
            cov.orders_scope_applied,
            'scope_kind',
            cov.scope_kind,
            'scope_from',
            app.costing_timestamptz_text (cov.scope_from),
            'transactions_covered',
            cov.transactions_covered,
            'presented_shift_count',
            pg_catalog.cardinality (cov.presented_shift_ids)::text,
            'legacy_direct',
            cov.legacy_direct
          )
        from
          app.pos_sync_coverage cov
        order by
          cov.finished_at desc,
          cov.run_id desc
        limit
          1
      ),
      'parked',
      (
        select
          coalesce(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'order_id',
                q.order_id,
                'attempts',
                q.attempts::text,
                'work_generation',
                q.work_generation::text,
                'failed_at',
                app.costing_timestamptz_text (q.failed_at),
                'sqlstate',
                q.sqlstate,
                'reason',
                q.reason
              )
              order by
                q.failed_at,
                q.order_id
            ),
            '[]'::jsonb
          )
        from
          (
            select
              ws.order_id,
              ws.attempts,
              ws.work_generation,
              ws.failed_at,
              case
                when att.reason is not null
                and att.sqlstate ~ '^[0-9A-Z]{5}$' then att.sqlstate
                when att.reason is not null then null
                when ws.last_error_code ~ '^[0-9A-Z]{5}$' then ws.last_error_code
                else null
              end as sqlstate,
              case
                when att.reason in (
                  'error',
                  'recompute_limit',
                  'critical',
                  'escaped'
                ) then att.reason
                when att.reason is null
                and ws.last_reason in (
                  'error',
                  'recompute_limit',
                  'critical',
                  'escaped'
                ) then ws.last_reason
                else null
              end as reason
            from
              app.accounting_work_state ws
              left join lateral (
                select
                  a.sqlstate,
                  a.reason
                from
                  app.accounting_work_attempts a
                where
                  a.order_id = ws.order_id
                  and a.work_generation = ws.work_generation
                order by
                  a.recorded_at desc,
                  a.attempt_id desc
                limit
                  1
              ) att on true
            where
              ws.failed_at is not null
            order by
              ws.failed_at,
              ws.order_id
            limit
              100
          ) q
      ),
      'parked_count',
      (
        select
          count(*)::text
        from
          app.accounting_work_state ws
        where
          ws.failed_at is not null
      ),
      'parked_truncated',
      (
        select
          count(*) > 100
        from
          app.accounting_work_state ws
        where
          ws.failed_at is not null
      )
    )
  into v_result;

  return v_result;
end;
$$;

comment on function app.accounting_processing_summary () is 'Owner only. Pending, blocked and failed counts, event and rederive-span progress, the latest successful sync coverage, and up to 100 parked orders with an allow-listed SQLSTATE and reason. Pending matches the private queue: an open event counts unless the order is parked and every open event is already claimed. A parked order with a new unclaimed event is still pending. Does not post stock.';

revoke all on function app.accounting_processing_summary ()
from
  public,
  anon,
  service_role;

grant
execute on function app.accounting_processing_summary () to authenticated;

-- Private filters. They keep version ids and decimal text and drop every
-- other provenance key. Revoked from every API role.
create function app.accounting_read_uuid_list (p_value jsonb) returns jsonb language sql immutable
set
  search_path = '' as $$
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.lower(u.id)
        order by
          pg_catalog.lower(u.id)
      ),
      '[]'::jsonb
    )
  from
    (
      select distinct
        elem #>> '{}' as id
      from
        pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof (p_value) = 'array' then p_value
            else '[]'::jsonb
          end
        ) elem
      where
        pg_catalog.jsonb_typeof (elem) = 'string'
        and (elem #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) u;
$$;

create function app.accounting_read_loss_versions (p_value jsonb) returns jsonb language sql stable
set
  search_path = '' as $$
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id',
          pg_catalog.lower(row.item_id),
          'version_id',
          pg_catalog.lower(row.version_id),
          'loss_pct',
          row.loss_pct
        )
        order by
          pg_catalog.lower(row.item_id),
          pg_catalog.lower(row.version_id)
      ),
      '[]'::jsonb
    )
  from
    (
      select
        elem ->> 'item_id' as item_id,
        elem ->> 'version_id' as version_id,
        elem ->> 'loss_pct' as loss_pct
      from
        pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof (p_value) = 'array' then p_value
            else '[]'::jsonb
          end
        ) elem
      where
        pg_catalog.jsonb_typeof (elem) = 'object'
        and (elem ->> 'item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (elem ->> 'version_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (elem ->> 'loss_pct') ~ '^-?[0-9]+(\.[0-9]+)?$'
    ) row;
$$;

create function app.accounting_read_conversion_versions (p_value jsonb) returns jsonb language sql stable
set
  search_path = '' as $$
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id',
          pg_catalog.lower(row.item_id),
          'unit_code',
          row.unit_code,
          'version_id',
          pg_catalog.lower(row.version_id),
          'factor_to_base',
          row.factor_to_base
        )
        order by
          pg_catalog.lower(row.item_id),
          row.unit_code,
          pg_catalog.lower(row.version_id)
      ),
      '[]'::jsonb
    )
  from
    (
      select
        elem ->> 'item_id' as item_id,
        elem ->> 'unit_code' as unit_code,
        elem ->> 'version_id' as version_id,
        elem ->> 'factor_to_base' as factor_to_base
      from
        pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof (p_value) = 'array' then p_value
            else '[]'::jsonb
          end
        ) elem
      where
        pg_catalog.jsonb_typeof (elem) = 'object'
        and (elem ->> 'item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (elem ->> 'version_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (elem ->> 'factor_to_base') ~ '^-?[0-9]+(\.[0-9]+)?$'
        and exists (
          select
            1
          from
            app.units u
          where
            u.code = elem ->> 'unit_code'
        )
    ) row;
$$;

comment on function app.accounting_read_uuid_list (jsonb) is 'Private. UUID strings from a jsonb array, lowercased and distinct. Other values are dropped.';

comment on function app.accounting_read_loss_versions (jsonb) is 'Private. Loss version rows whose ids are UUIDs and whose loss percent is decimal text.';

comment on function app.accounting_read_conversion_versions (jsonb) is 'Private. Conversion version rows whose ids are UUIDs, whose factor is decimal text, and whose unit code exists.';

revoke all on function app.accounting_read_uuid_list (jsonb),
app.accounting_read_loss_versions (jsonb),
app.accounting_read_conversion_versions (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.order_cost_detail (p_order_id text) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_id text;
  v_found boolean;
  v_number text;
  v_input_id bigint;
  v_input jsonb;
  v_state jsonb;
  v_apps jsonb;
begin
  if not app.is_owner () then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  v_id := pg_catalog.btrim(p_order_id);

  if v_id is null or v_id = '' then
    raise exception 'order id is required'
      using errcode = '22023';
  end if;

  select
    exists (
      select
        1
      from
        app.pos_orders o
      where
        o.id = v_id
      union all
      select
        1
      from
        app.order_cost_state s
      where
        s.order_id = v_id
      union all
      select
        1
      from
        app.order_cost_applications a
      where
        a.order_id = v_id
    )
  into v_found;

  if not v_found then
    return pg_catalog.jsonb_build_object(
      'found',
      false,
      'order_id',
      v_id,
      'order_number',
      null,
      'input',
      null,
      'state',
      null,
      'applications',
      '[]'::jsonb
    );
  end if;

  select
    o.order_number::text
  into v_number
  from
    app.pos_orders o
  where
    o.id = v_id;

  select
    s.latest_input_id
  into v_input_id
  from
    app.order_cost_state s
  where
    s.order_id = v_id;

  if v_input_id is null then
    select
      i.id
    into v_input_id
    from
      app.pos_cost_inputs i
    where
      i.order_id = v_id
    order by
      i.input_revision desc
    limit
      1;
  end if;

  if v_input_id is not null then
    select
      pg_catalog.jsonb_build_object(
        'input_id',
        i.id::text,
        'input_revision',
        i.input_revision::text,
        'snapshot_id',
        i.snapshot_id::text,
        'snapshot_version',
        snap.version::text,
        'missing_from_pos',
        i.missing_from_pos,
        'digest',
        i.digest
      )
    into v_input
    from
      app.pos_cost_inputs i
      join app.pos_order_snapshots snap on snap.id = i.snapshot_id
    where
      i.id = v_input_id;
  end if;

  select
    pg_catalog.jsonb_build_object(
      'disposition',
      s.disposition,
      'latest_application_id',
      s.latest_application_id::text,
      'owner_application_id',
      s.owner_application_id::text,
      'causes',
      coalesce(
        (
          select
            pg_catalog.jsonb_agg(c.code)
          from
            (
              select
                case
                  when pg_catalog.jsonb_typeof (elem) = 'string'
                  and (elem #>> '{}') ~ '^[a-z0-9_]{1,64}$' then elem #>> '{}'
                  when pg_catalog.jsonb_typeof (elem) = 'object'
                  and (elem ->> 'code') ~ '^[a-z0-9_]{1,64}$' then elem ->> 'code'
                  else null
                end as code
              from
                pg_catalog.jsonb_array_elements(
                  case
                    when pg_catalog.jsonb_typeof (s.causes) = 'array' then s.causes
                    else '[]'::jsonb
                  end
                ) elem
            ) c
          where
            c.code is not null
        ),
        '[]'::jsonb
      )
    )
  into v_state
  from
    app.order_cost_state s
  where
    s.order_id = v_id;

  select
    coalesce(
      pg_catalog.jsonb_agg(app_row.obj order by app_row.id),
      '[]'::jsonb
    )
  into v_apps
  from
    (
      select
        a.id,
        pg_catalog.jsonb_build_object(
          'id',
          a.id::text,
          'receipt_kind',
          a.receipt_kind,
          'disposition',
          a.disposition,
          'cost_input_id',
          a.cost_input_id::text,
          'input_revision',
          inp.input_revision::text,
          'snapshot_id',
          a.snapshot_id::text,
          'snapshot_version',
          snap.version::text,
          'predecessor_id',
          a.predecessor_id::text,
          'retired_application_id',
          a.retired_application_id::text,
          'movement_owner_id',
          a.movement_owner_id::text,
          'occurred_at',
          app.costing_timestamptz_text (a.occurred_at),
          'shift_id',
          a.shift_id,
          'algorithm_version',
          a.algorithm_version::text,
          'signature',
          a.signature,
          'created_at',
          app.costing_timestamptz_text (a.created_at),
          'lines',
          coalesce(
            (
              select
                pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'item_id',
                    elem ->> 'stock_item_id',
                    'name',
                    si.name,
                    'base_unit',
                    case
                      when si.base_unit in ('kg', 'piece', 'liter') then si.base_unit
                      when elem ->> 'base_unit' in ('kg', 'piece', 'liter') then elem ->> 'base_unit'
                      else null
                    end,
                    'quantity',
                    case
                      when (elem ->> 'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$' then elem ->> 'quantity'
                      else null
                    end
                  )
                  order by
                    elem ->> 'stock_item_id'
                )
              from
                pg_catalog.jsonb_array_elements(
                  case
                    when pg_catalog.jsonb_typeof (a.requirements) = 'array' then a.requirements
                    else '[]'::jsonb
                  end
                ) elem
                left join app.stock_items si on si.id::text = elem ->> 'stock_item_id'
              where
                pg_catalog.jsonb_typeof (elem) = 'object'
                and (elem ->> 'stock_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            ),
            '[]'::jsonb
          ),
          'posted',
          coalesce(
            (
              select
                pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'movement_id',
                    sm.id::text,
                    'item_id',
                    sm.item_id,
                    'name',
                    si.name,
                    'movement_type',
                    sm.movement_type::text,
                    'quantity',
                    pg_catalog.trim_scale (sm.quantity)::text,
                    'total_cost',
                    pg_catalog.trim_scale (sm.total_cost)::text,
                    'occurred_at',
                    app.costing_timestamptz_text (sm.occurred_at)
                  )
                  order by
                    sm.id
                )
              from
                app.order_cost_movement_links link
                join app.stock_movements sm on sm.id = link.movement_id
                left join app.stock_items si on si.id = sm.item_id
              where
                link.application_id = a.id
            ),
            '[]'::jsonb
          ),
          'provenance',
          pg_catalog.jsonb_build_object(
            'mapping_versions',
            app.accounting_read_uuid_list (prov.body -> 'mapping_versions'),
            'recipe_versions',
            app.accounting_read_uuid_list (prov.body -> 'recipe_versions'),
            'packaging_versions',
            app.accounting_read_uuid_list (prov.body -> 'packaging_versions'),
            'loss_versions',
            app.accounting_read_loss_versions (prov.body -> 'loss_versions'),
            'conversion_versions',
            app.accounting_read_conversion_versions (prov.body -> 'conversion_versions'),
            'algorithm_version',
            a.algorithm_version::text
          ),
          'reversals',
          coalesce(
            (
              select
                pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'movement_id',
                    sm.id::text,
                    'item_id',
                    sm.item_id,
                    'name',
                    si.name,
                    'movement_type',
                    sm.movement_type::text,
                    'quantity',
                    pg_catalog.trim_scale (sm.quantity)::text,
                    'total_cost',
                    pg_catalog.trim_scale (sm.total_cost)::text,
                    'reverses_movement_id',
                    sm.reverses_movement_id::text
                  )
                  order by
                    sm.id
                )
              from
                app.stock_movements sm
                left join app.stock_items si on si.id = sm.item_id
              where
                sm.id = any (a.reversal_movement_ids)
            ),
            '[]'::jsonb
          ),
          'adjustments',
          coalesce(
            (
              select
                pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'movement_id',
                    sm.id::text,
                    'item_id',
                    sm.item_id,
                    'name',
                    si.name,
                    'quantity',
                    pg_catalog.trim_scale (sm.quantity)::text,
                    'total_cost',
                    pg_catalog.trim_scale (sm.total_cost)::text,
                    'adjusts_movement_id',
                    sm.adjusts_movement_id::text
                  )
                  order by
                    sm.id
                )
              from
                app.stock_movements sm
                left join app.stock_items si on si.id = sm.item_id
              where
                sm.movement_type = 'cost_adjustment'
                and (
                  sm.adjusts_movement_id in (
                    select
                      link.movement_id
                    from
                      app.order_cost_movement_links link
                    where
                      link.application_id = a.id
                  )
                  or sm.adjusts_movement_id = any (a.reversal_movement_ids)
                )
            ),
            '[]'::jsonb
          )
        ) as obj
      from
        app.order_cost_applications a
        join app.pos_cost_inputs inp on inp.id = a.cost_input_id
        join app.pos_order_snapshots snap on snap.id = a.snapshot_id
        cross join lateral (
          select
            case
              when pg_catalog.jsonb_typeof (a.provenance) = 'object' then a.provenance
              else '{}'::jsonb
            end as body
        ) prov
      where
        a.order_id = v_id
    ) app_row;

  return pg_catalog.jsonb_build_object(
    'found',
    true,
    'order_id',
    v_id,
    'order_number',
    v_number,
    'input',
    v_input,
    'state',
    v_state,
    'applications',
    coalesce(v_apps, '[]'::jsonb)
  );
end;
$$;

comment on function app.order_cost_detail (text) is 'Owner only. One order: the applied cost input and snapshot version, the head disposition, saved requirement quantities, configuration version ids, posted movements, reversals and cost adjustments. Provenance keeps version ids and decimal factors only. A blank id is 22023. An unknown id returns found false. Does not post stock.';

revoke all on function app.order_cost_detail (text)
from
  public,
  anon,
  service_role;

grant
execute on function app.order_cost_detail (text) to authenticated;

create function app.opening_activation_review (
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
          obs.opening_id is null,
          'opening_line_count',
          cnt.n,
          'observation',
          case
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

comment on function app.opening_activation_review (uuid, integer) is 'Owner only. One page of the stock roster, including items with no opening line. A stored opening line is a positive observation; a zero is not stored, so a missing line is not a recorded zero. next_item_id is the last item included on this page when another item remains, and null when the page is short. The next page starts after that id, so no item is skipped. The checklist and can_activate describe the whole catalog, not the page. can_activate is a data-gap flag for a later writer and is false while activation is already recorded. Does not record activation.';

revoke all on function app.opening_activation_review (uuid, integer)
from
  public,
  anon,
  service_role;

grant
execute on function app.opening_activation_review (uuid, integer) to authenticated;

create function app.stock_count_derivation_detail (p_count_id uuid) returns jsonb language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_at timestamptz;
  v_frequency text;
  v_note text;
  v_waiting_sync boolean;
  v_waiting_work boolean;
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
        least(li.ordered_at, cur.occurred_at) is null
        or least(li.ordered_at, cur.occurred_at) <= v_at
    )
    or exists (
      select
        1
      from
        app.accounting_rederive_spans sp
      where
        sp.completed_at is null
        and sp.effective_from <= v_at
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

comment on function app.stock_count_derivation_detail (uuid) is 'Owner only. One count: original observation, latest derivation, compensators, value adjustments on that settlement, surplus, and whether a covering sync or pending accounting work still reaches the count instant. An unresolved event stays relevant after its order is parked, because retrying that order can still change the settlement. Quantities and money are decimal text. Does not post stock.';

revoke all on function app.stock_count_derivation_detail (uuid)
from
  public,
  anon,
  service_role;

grant
execute on function app.stock_count_derivation_detail (uuid) to authenticated;
