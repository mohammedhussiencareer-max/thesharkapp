-- Local e2e fixture for the order decision screen. Synthetic ids and names
-- only. Run by seed-order-decisions.ts as the local postgres role. This
-- prepares the two items, their mappings, and one positive opening. The owner
-- records activation from the screen. Running it again does nothing.
-- The migration leaves accounting_scaling_ready false. This local fixture
-- replaces it so the owner click can store the activation row.
create or replace function app.accounting_scaling_ready () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    true;
$$;

do $seed$
declare
  v_owner uuid;
  v_change bigint;
  v_pos text;
  v_item constant uuid[] := array[
    'e2e0d000-0000-4000-8000-000000000001',
    'e2e0d000-0000-4000-8000-000000000002'
  ]::uuid[];
begin
  if exists (
    select 1 from app.stock_items where id = v_item[1]
  ) then
    return;
  end if;

  select o.user_id into v_owner from app.owner o;

  if v_owner is null then
    raise exception 'the local owner does not exist yet';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  insert into app.stock_items (
    id, name, kind, base_unit, count_frequency, loss_pct, parent_item_id
  ) values
    (v_item[1], 'سمك قرارات أ', 'seafood', 'kg', 'weekly', 0, null),
    (v_item[2], 'سمك قرارات ب', 'seafood', 'kg', 'weekly', 0, null);

  insert into app.costing_changes (request_id, kind, payload, result)
  values ('e2e0d000-0000-4000-8000-0000000000c0', 'legacy', '{}'::jsonb, '{}'::jsonb)
  returning id into v_change;

  insert into app.item_loss_versions (
    effective_from, created_change_id, item_id, loss_pct
  ) select '2000-01-01 00:00:00+00', v_change, i, 0 from unnest(v_item) as i;

  -- Openings before any purchase. The click uses these as the positive roster.
  perform app.record_opening_stock(
    now() - interval '32 days',
    jsonb_build_array(
      jsonb_build_object(
        'item_id', v_item[1], 'quantity', '100', 'unit', 'kg',
        'unit_cost', '50', 'expected_base_unit', 'kg', 'expected_factor', '1'
      ),
      jsonb_build_object(
        'item_id', v_item[2], 'quantity', '100', 'unit', 'kg',
        'unit_cost', '20', 'expected_base_unit', 'kg', 'expected_factor', '1'
      )
    ),
    'e2e0d000-0000-4000-8000-0000000000e2'
  );

  -- Item a costs 50 and item b costs 20. Purchases stay on the public poster
  -- and remain before the owner records activation.
  perform app.post_movements(jsonb_build_array(
    jsonb_build_object(
      'item_id', v_item[1], 'movement_type', 'purchase',
      'occurred_at', now() - interval '31 days', 'quantity', 100, 'unit_cost', 50
    ),
    jsonb_build_object(
      'item_id', v_item[2], 'movement_type', 'purchase',
      'occurred_at', now() - interval '31 days', 'quantity', 100, 'unit_cost', 20
    )
  ));

  -- One kilo of the matching stock item per POS unit, no options, no packaging.
  foreach v_pos in array array['e2e-od-pos-a', 'e2e-od-pos-b'] loop
    perform app.set_pos_option_policy(
      md5('opt|' || v_pos)::uuid, v_pos, '["none"]'::jsonb,
      '2020-01-01T00:00:00Z', null, 'none_expected',
      (app.pos_base_schedule(v_pos, '["none"]'::jsonb) ->> 'token'), 'e2e fixture'
    );

    perform app.set_base_packaging(
      md5('bpk|' || v_pos)::uuid, v_pos, '["none"]'::jsonb,
      '2020-01-01T00:00:00Z', null, '{"none": true}'::jsonb,
      (app.packaging_base_schedule(v_pos, '["none"]'::jsonb) ->> 'token'), 'e2e fixture'
    );

    perform app.set_pos_base_mapping(
      md5('map|' || v_pos)::uuid, v_pos, '["none"]'::jsonb,
      '2020-01-01T00:00:00Z', null,
      jsonb_build_object(
        'stock_item_id', case when v_pos = 'e2e-od-pos-a' then v_item[1] else v_item[2] end,
        'quantity_per_basis', '1',
        'unit', 'kg'
      ),
      (app.pos_base_schedule(v_pos, '["none"]'::jsonb) ->> 'token'), 'e2e fixture'
    );
  end loop;

  perform app.set_order_type_packaging(
    md5('ot|e2e-od-hall')::uuid, 'e2e-od-hall', '2020-01-01T00:00:00Z', null,
    '{"none": true}'::jsonb,
    (app.packaging_order_type_schedule('e2e-od-hall') ->> 'token'), 'e2e fixture'
  );
end;
$seed$;
