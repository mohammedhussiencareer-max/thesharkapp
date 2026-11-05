begin;

select
  plan (112);

insert into
  auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change
  )
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'authenticated',
    'authenticated',
    'owner@theshark.test',
    '',
    '2020-01-01T00:00:00Z',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70',
    'authenticated',
    'authenticated',
    'intruder@theshark.test',
    '',
    '2020-01-01T00:00:00Z',
    '',
    '',
    '',
    ''
  );

insert into
  app.owner (user_id)
values
  ('b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f');

-- Items the table owner seeds: 11 shrimp, 12 salt, 13 oil, 14 flour,
-- 15 box (packaging), 16 mixed fish.
insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    active
  )
values
  (
    'f6000000-0000-4000-8000-000000000011',
    'جمبري موجود',
    'seafood',
    'kg',
    'daily',
    true
  ),
  (
    'f6000000-0000-4000-8000-000000000012',
    'ملح استيراد',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f6000000-0000-4000-8000-000000000013',
    'زيت استيراد',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f6000000-0000-4000-8000-000000000014',
    'دقيق استيراد',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f6000000-0000-4000-8000-000000000015',
    'علبة استيراد',
    'packaging',
    'piece',
    'weekly',
    true
  ),
  (
    'f6000000-0000-4000-8000-000000000016',
    'سمك مشكل استيراد',
    'fish_mixed',
    'kg',
    'daily',
    true
  );

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

-- ============================================================================
-- 0. Fixtures through the owner writers: oil has a 5% loss, EB is an existing
-- batch (salt), EC is an existing cooking recipe that uses EB.
-- ============================================================================
select
  lives_ok (
    $$select app.set_item_loss(
      'f6000000-0000-4000-8000-0000000000a1',
      'f6000000-0000-4000-8000-000000000013',
      0.05, '2020-01-01 00:00:00+00', null,
      (app.item_costing_schedule('f6000000-0000-4000-8000-000000000013') -> 'loss' ->> 'token'),
      'تهيئة'
    )$$,
    'fixture: oil has a loss'
  );

select
  set_config(
    't.eb',
    app.create_recipe (
      'f6000000-0000-4000-8000-0000000000a2',
      'تحضيرة قائمة',
      'batch'
    ) ->> 'recipe_id',
    true
  );

select
  set_config(
    't.ec',
    app.create_recipe (
      'f6000000-0000-4000-8000-0000000000a3',
      'طبخ قائم',
      'cooking'
    ) ->> 'recipe_id',
    true
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f6000000-0000-4000-8000-0000000000a4',
      current_setting('t.eb')::uuid, null, null, 1000, 'g',
      '[{"stock_item_id":"f6000000-0000-4000-8000-000000000012","quantity":100,"unit":"g"}]'::jsonb,
      null,
      (app.recipe_schedule(current_setting('t.eb')::uuid) ->> 'token')
    )$$,
    'fixture: the existing batch has a version'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f6000000-0000-4000-8000-0000000000a5',
      current_setting('t.ec')::uuid, null, null, null, null,
      jsonb_build_array(jsonb_build_object(
        'child_recipe_id', current_setting('t.eb'), 'quantity', 0.5, 'unit', 'kg'
      )),
      null,
      (app.recipe_schedule(current_setting('t.ec')::uuid) ->> 'token')
    )$$,
    'fixture: the existing cooking recipe uses the batch'
  );

-- The base payload. Tokens and the identity come from the live schedules.
select
  set_config(
    't.base',
    replace(
      replace(
        replace(
          replace(
            $j${
              "structural_hash": "@hash",
              "effective_from": null,
              "items": [
                {"key":"i1","name":"فلفل استيراد","kind":"ingredient","base_unit":"kg","count_frequency":"weekly"},
                {"key":"i2","name":"جمبري جديد استيراد","kind":"seafood","base_unit":"kg","count_frequency":"daily"}
              ],
              "recipes": [
                {"key":"d1","name":"طبق استيراد","kind":"dish","lines":[
                  {"recipe_key":"b1","quantity":300,"unit":"g"},
                  {"item_key":"i2","quantity":200,"unit":"g"}
                ]},
                {"key":"b1","name":"تتبيلة استيراد","kind":"batch","batch_qty":2400,"batch_unit":"g","lines":[
                  {"item_key":"i1","quantity":100,"unit":"g"},
                  {"stock_item_id":"f6000000-0000-4000-8000-000000000012","quantity":50,"unit":"g"}
                ]}
              ],
              "losses": [
                {"item_key":"i2","loss_pct":0.1},
                {"stock_item_id":"f6000000-0000-4000-8000-000000000013","loss_pct":0.05,"expected_token":"@oiltok"},
                {"stock_item_id":"f6000000-0000-4000-8000-000000000014","loss_pct":0.02,"expected_token":"@flourtok"}
              ],
              "manual_opening_prices": [
                {"item_key":"i1","unit_cost":12.5},
                {"item_key":"i2","unit_cost":0,"zero_cost_reason":"مجاني"},
                {"stock_item_id":"f6000000-0000-4000-8000-000000000014","unit_cost":7.25,"expected_identity":"@flouridt"}
              ],
              "bindings": [
                {"source_name":"فلفل","item_key":"i1"},
                {"source_name":"تتبيلة","recipe_key":"b1"},
                {"source_name":"طبق","recipe_key":"d1"},
                {"source_name":"ملح","stock_item_id":"f6000000-0000-4000-8000-000000000012"}
              ]
            }$j$,
            '@hash',
            repeat('a', 64)
          ),
          '@oiltok',
          (
            app.item_costing_schedule ('f6000000-0000-4000-8000-000000000013') -> 'loss' ->> 'token'
          )
        ),
        '@flourtok',
        (
          app.item_costing_schedule ('f6000000-0000-4000-8000-000000000014') -> 'loss' ->> 'token'
        )
      ),
      '@flouridt',
      (
        app.item_costing_schedule ('f6000000-0000-4000-8000-000000000014') ->> 'identity'
      )
    ),
    true
  );

-- ============================================================================
-- 1. Structural refusals. Nothing is read or written.
-- ============================================================================
select
  throws_ok (
    $$select app.commit_recipe_import(null, current_setting('t.base')::jsonb)$$,
    '22023',
    'request_id is required',
    'a missing request id is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0', '[]'::jsonb)$$,
    '22023',
    'payload must be a json object',
    'a non-object payload is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb || '{"structural_hash":"ABC"}')$$,
    '22023',
    'structural_hash must be 64 lowercase hex characters',
    'a malformed structural hash is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb || '{"recipes":[]}')$$,
    '22023',
    'recipes must not be empty',
    'an import without recipes is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb || '{"extra":1}')$$,
    '22023',
    'unknown key "extra" in payload',
    'an unknown top-level key is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{items,0,extra}', '1'))$$,
    '22023',
    'unknown key "extra" in item 1',
    'an unknown item key is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,lines,0,extra}', '1'))$$,
    '22023',
    'unknown key "extra" in recipe 1 line 1',
    'an unknown line key is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{bindings,0,extra}', '1'))$$,
    '22023',
    'unknown key "extra" in binding 1',
    'an unknown binding key is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,0,price}', '1'))$$,
    '22023',
    'unknown key "price" in manual opening price 1',
    'the manual section has its own strict allowlist'
  );

-- ============================================================================
-- 2. Price-like keys are refused at every level of the workbook sections.
-- ============================================================================
select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb || '{"price":1}')$$,
    '22023',
    'price-like key "price" is not allowed in a recipe payload',
    'price at the top level is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{items,0,cost}', '3'))$$,
    '22023',
    'price-like key "cost" is not allowed in a recipe payload',
    'cost on an item is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,unit_cost}', '3'))$$,
    '22023',
    'price-like key "unit_cost" is not allowed in a recipe payload',
    'unit_cost on a recipe is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,1,lines,0,price_per_kg}', '3'))$$,
    '22023',
    'price-like key "price_per_kg" is not allowed in a recipe payload',
    'a price-named key on a line is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{losses,0,amount}', '3'))$$,
    '22023',
    'price-like key "amount" is not allowed in a recipe payload',
    'amount on a loss entry is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{losses,1,unit_cost}', '3'))$$,
    '22023',
    'price-like key "unit_cost" is not allowed in a recipe payload',
    'unit_cost on a loss entry is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{bindings,0,Cost}', '3'))$$,
    '22023',
    'price-like key "Cost" is not allowed in a recipe payload',
    'a price-like key on a binding is refused regardless of case'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,lines,0,extra}', '{"deep":{"price":1}}'))$$,
    '22023',
    'price-like key "price" is not allowed in a recipe payload',
    'a nested price key is refused'
  );

-- ============================================================================
-- 3. Section rules.
-- ============================================================================
select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,1,kind}', '"cooking"'))$$,
    '22023',
    'recipe 2: cooking recipes are never imported',
    'a cooking recipe is never imported'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb #- '{recipes,1,batch_qty}')$$,
    '22023',
    'recipe 2: a batch needs batch_qty and batch_unit',
    'a batch without a quantity is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,1,batch_qty}', '0'))$$,
    '22023',
    'recipe 2: batch_qty must be greater than 0',
    'a zero batch quantity is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,batch_qty}', '5'))$$,
    '22023',
    'recipe 1: batch_qty and batch_unit are only for a batch',
    'a dish with a batch quantity is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,1,batch_unit}', '"xyz"'))$$,
    '22023',
    'unknown unit "xyz" for the batch of recipe "b1"',
    'an unknown batch unit fails the import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,lines,1,unit}', '"xyz"'))$$,
    '22023',
    'unknown unit "xyz" in recipe "d1"',
    'an unknown line unit fails the import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,lines,0,quantity}', '0'))$$,
    '22023',
    'recipe 1 line 1: quantity must be greater than 0',
    'a zero line quantity is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,lines,1,stock_item_id}',
        '"f6000000-0000-4000-8000-000000000012"'))$$,
    '22023',
    'recipe 1 line 2: needs exactly one target',
    'a line with two targets is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,lines,1,item_key}', '"zz"'))$$,
    '22023',
    'recipe 1 line 2: unknown item_key "zz"',
    'a line naming an unknown item key is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,lines,0,recipe_key}', '"zz"'))$$,
    '22023',
    'unknown recipe_key "zz"',
    'a line naming an unknown recipe key is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{items,1,name}', '"فلفل استيراد"'))$$,
    '22023',
    'duplicate item name "فلفل استيراد"',
    'two new items with one name are refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{items,0,name}', '"ملح استيراد"'))$$,
    '22023',
    'stock item name already exists: ملح استيراد',
    'a new item cannot reuse an existing item name'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0,name}', '"تحضيرة قائمة"'))$$,
    '22023',
    'recipe name already exists: تحضيرة قائمة',
    'a new recipe cannot reuse an existing recipe name'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{items,0,kind}', '"packaging"'))$$,
    '22023',
    'item 1: kind must be ingredient or seafood',
    'a new packaging item is not created by the import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{bindings,1,source_name}', '"فلفل"'))$$,
    '22023',
    'binding 2: duplicate source_name "فلفل"',
    'two bindings of one source name are refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0}',
        jsonb_build_object('key', 'd1', 'recipe_id', current_setting('t.eb'), 'kind', 'dish',
          'expected_token', 'x', 'lines', current_setting('t.base')::jsonb #> '{recipes,0,lines}')))$$,
    '22023',
    'recipe ' || current_setting('t.eb') || ' is a batch recipe, not dish',
    'an existing recipe cannot change kind'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0}',
        jsonb_build_object('key', 'd1', 'recipe_id', current_setting('t.eb'), 'kind', 'batch',
          'batch_qty', 1, 'batch_unit', 'g',
          'lines', current_setting('t.base')::jsonb #> '{recipes,1,lines}')))$$,
    '22023',
    'recipe 1: expected_token is required for an existing recipe',
    'an existing recipe needs its token'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,0}',
        jsonb_build_object('key', 'd1', 'recipe_id', 'f6000000-0000-4000-8000-0000000009ff',
          'kind', 'dish', 'expected_token', 'x',
          'lines', current_setting('t.base')::jsonb #> '{recipes,0,lines}')))$$,
    '22023',
    'unknown recipe id: f6000000-0000-4000-8000-0000000009ff',
    'an unknown existing recipe is refused'
  );

-- ============================================================================
-- 4. Typed opening prices follow the opening-price rules.
-- ============================================================================
select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,0,unit_cost}', '-1'))$$,
    '22023',
    'manual opening price 1: unit_cost must be finite and greater than or equal to 0',
    'a negative typed price is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,0,unit_cost}', '"abc"'))$$,
    '22023',
    'unit_cost in manual opening price 1 must be a number',
    'a non-numeric typed price is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,0,unit_cost}', '0'))$$,
    '22023',
    'manual opening price 1: zero_cost_reason is required when unit_cost is 0',
    'a zero typed price needs a reason'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,0,zero_cost_reason}', '"سبب"'))$$,
    '22023',
    'manual opening price 1: zero_cost_reason must be null when unit_cost is greater than 0',
    'a positive typed price forbids a zero reason'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb #- '{manual_opening_prices,2,expected_identity}')$$,
    '22023',
    'manual opening price 3: expected_identity is required for an existing item',
    'a price for an existing item needs its identity'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,0,expected_identity}', '"kg|ingredient||"'))$$,
    '22023',
    'manual opening price 1: expected_identity and expected_current_id are only for an existing item',
    'a price for a new item carries no identity'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,2,expected_identity}', '"kg|seafood||"'))$$,
    '40001',
    'configuration changed',
    'a stale identity fails the whole import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{manual_opening_prices,1,item_key}', '"i1"'))$$,
    '22023',
    'manual opening price 2: the same item appears twice',
    'a duplicate typed price is refused'
  );

-- ============================================================================
-- 5. Losses.
-- ============================================================================
select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{losses,0,loss_pct}', '1'))$$,
    '22023',
    'loss 1: loss_pct must be finite and in [0, 1)',
    'a loss of 100 percent is refused'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb #- '{losses,2,expected_token}')$$,
    '22023',
    'loss 3: expected_token is required for an existing item',
    'a loss for an existing item needs its token'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{losses,0,expected_token}', '"x"'))$$,
    '22023',
    'loss 1: expected_token is only for an existing item',
    'a loss for a new item carries no token'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{losses,2,expected_token}', '"stale"'))$$,
    '40001',
    'configuration changed',
    'a stale loss token fails the whole import'
  );

-- ============================================================================
-- 6. Graph and publication failures roll everything back.
-- ============================================================================
select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb || jsonb_build_object('recipes', jsonb_build_array(
        '{"key":"b1","name":"تتبيلة استيراد","kind":"batch","batch_qty":10,"batch_unit":"g","lines":[{"recipe_key":"d1","quantity":1,"unit":"g"}]}'::jsonb,
        '{"key":"d1","name":"طبق استيراد","kind":"batch","batch_qty":10,"batch_unit":"g","lines":[{"recipe_key":"b1","quantity":1,"unit":"g"}]}'::jsonb
      )))$$,
    '22023',
    'recipes in the import use each other in a cycle',
    'a cycle between two imported recipes fails the import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      current_setting('t.base')::jsonb || jsonb_build_object('bindings', '[]'::jsonb, 'recipes', jsonb_build_array(
        '{"key":"b1","name":"تتبيلة استيراد","kind":"batch","batch_qty":10,"batch_unit":"g","lines":[{"recipe_key":"b1","quantity":1,"unit":"g"}]}'::jsonb
      )))$$,
    '22023',
    'recipes in the import use each other in a cycle',
    'a recipe using itself fails the import'
  );

select
  throws_like (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_build_object('structural_hash', repeat('b', 64), 'recipes', jsonb_build_array(
        jsonb_build_object('key', 'eb', 'recipe_id', current_setting('t.eb'),
          'expected_token', (app.recipe_schedule(current_setting('t.eb')::uuid) ->> 'token'),
          'kind', 'batch', 'batch_qty', 1000, 'batch_unit', 'g',
          'lines', '[{"stock_item_id":"f6000000-0000-4000-8000-000000000011","quantity":500,"unit":"g"}]'::jsonb)
      )))$$,
    '%would be invalid%cooking_marine%',
    'seafood in a batch used by an existing cooking recipe fails the import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,1,lines,1}',
        '{"stock_item_id":"f6000000-0000-4000-8000-000000000015","quantity":1,"unit":"piece"}'::jsonb))$$,
    '22023',
    'line 2: a packaging item cannot be a recipe leaf',
    'a packaging leaf fails the import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,1,lines,1}',
        '{"stock_item_id":"f6000000-0000-4000-8000-000000000016","quantity":1,"unit":"kg"}'::jsonb))$$,
    '22023',
    'line 2: a fish_mixed item cannot be a recipe leaf',
    'a mixed-fish leaf fails the import'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{bindings,3,stock_item_id}',
        '"f6000000-0000-4000-8000-0000000009ff"'))$$,
    '22023',
    'unknown stock_item id: f6000000-0000-4000-8000-0000000009ff',
    'a binding to an unknown item fails the import after all the writes'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{effective_from}', '"2020-01-01T00:00:00Z"'))$$,
    '22023',
    'reason is required for a backdated change',
    'a backdated instant needs a reason'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.base')::jsonb, '{effective_from}', '"soon"'))$$,
    '22023',
    'effective_from must be a timestamp or null',
    'a malformed instant is refused'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipes
      where
        name in ('طبق استيراد', 'تتبيلة استيراد')
    ),
    0::bigint,
    'no failed import left a recipe behind'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_items
      where
        name in ('فلفل استيراد', 'جمبري جديد استيراد')
    ),
    0::bigint,
    'no failed import left an item behind'
  );

select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        kind = 'import'
    ) + (
      select
        count(*)
      from
        app.recipe_imports
    ) + (
      select
        count(*)
      from
        app.recipe_import_bindings
    ),
    0::bigint,
    'no failed import left a receipt, a binding or a change'
  );

-- ============================================================================
-- 7. The atomic commit.
-- ============================================================================
select
  lives_ok (
    $$select app.commit_recipe_import(
      'f6000000-0000-4000-8000-000000000101', current_setting('t.base')::jsonb
    )$$,
    'the owner commits the import'
  );

select
  is (
    (
      select
        result #> '{counts}'
      from
        app.costing_changes
      where
        request_id = 'f6000000-0000-4000-8000-000000000101'
    ),
    '{"items_created":2,"recipes_created":2,"versions_published":2,"recipes_unchanged":0,"losses_set":2,"losses_unchanged":1,"opening_prices_set":3,"bindings":4}'::jsonb,
    'the stored result counts what was written'
  );

select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        request_id = 'f6000000-0000-4000-8000-000000000101'
        and kind = 'import'
    ),
    1::bigint,
    'the import is one costing change of kind import'
  );

select
  results_eq (
    $$select name::text collate "default", kind::text collate "default", base_unit::text collate "default", active
      from app.stock_items
      where name in ('فلفل استيراد', 'جمبري جديد استيراد')
      order by name$$,
    $$values
      ('جمبري جديد استيراد'::text, 'seafood'::text, 'kg'::text, true),
      ('فلفل استيراد', 'ingredient', 'kg', true)$$,
    'the approved new items exist'
  );

select
  results_eq (
    $$select r.name::text collate "default", r.kind::text collate "default",
        (select count(*) from app.recipe_versions v where v.recipe_id = r.id and v.superseded_change_id is null)
      from app.recipes r
      where r.name in ('طبق استيراد', 'تتبيلة استيراد')
      order by r.name$$,
    $$values
      ('تتبيلة استيراد'::text, 'batch'::text, 1::bigint),
      ('طبق استيراد', 'dish', 1)$$,
    'both recipes exist with one current version each'
  );

select
  results_eq (
    $$select v.batch_qty, v.batch_unit::text collate "default"
      from app.recipe_versions v
      join app.recipes r on r.id = v.recipe_id
      where r.name = 'تتبيلة استيراد'$$,
    $$values (2400::numeric, 'g'::text)$$,
    'the batch keeps its explicit quantity and unit'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_lines l
        join app.recipe_versions v on v.id = l.version_id
        join app.recipes r on r.id = v.recipe_id
      where
        r.name = 'طبق استيراد'
        and l.child_recipe_id = (
          select
            id
          from
            app.recipes
          where
            name = 'تتبيلة استيراد'
        )
        and l.quantity = 300
        and l.unit = 'g'
    ),
    1::bigint,
    'the dish uses the imported batch as a nested line'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions v
      where
        v.recipe_id in (
          select
            id
          from
            app.recipes
          where
            name in ('طبق استيراد', 'تتبيلة استيراد')
        )
        and v.effective_from = date_trunc('minute', now())
        and v.effective_to is null
    ),
    2::bigint,
    'one effective instant: the current minute, open-ended'
  );

select
  results_eq (
    $$select i.name::text collate "default", l.loss_pct
      from app.item_loss_versions l
      join app.stock_items i on i.id = l.item_id
      where l.superseded_change_id is null
        and i.name in ('جمبري جديد استيراد', 'دقيق استيراد', 'زيت استيراد')
      order by i.name$$,
    $$values
      ('جمبري جديد استيراد'::text, 0.10000::numeric),
      ('دقيق استيراد', 0.02000),
      ('زيت استيراد', 0.05000)$$,
    'approved losses are set and an equal loss creates no version'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
      where
        item_id = 'f6000000-0000-4000-8000-000000000013'
    ),
    1::bigint,
    'the unchanged oil loss has a single version'
  );

select
  results_eq (
    $$select i.name::text collate "default", p.unit_cost, p.zero_cost_reason::text collate "default"
      from app.item_opening_prices p
      join app.stock_items i on i.id = p.item_id
      where p.superseded_change_id is null
        and i.name in ('فلفل استيراد', 'جمبري جديد استيراد', 'دقيق استيراد')
      order by i.name$$,
    $$values
      ('جمبري جديد استيراد'::text, 0::numeric, 'مجاني'::text),
      ('دقيق استيراد', 7.250000, null),
      ('فلفل استيراد', 12.500000, null)$$,
    'typed opening prices are applied, a zero one with its reason'
  );

select
  results_eq (
    $$select b.source_name::text collate "default",
        (b.recipe_id is not null) as is_recipe
      from app.recipe_import_bindings b
      order by b.source_name$$,
    $$values
      ('تتبيلة'::text, true),
      ('طبق', true),
      ('فلفل', false),
      ('ملح', false)$$,
    'the source names are bound to what they became'
  );

select
  results_eq (
    $$select structural_hash::text collate "default", created_change_id = (
        select id from app.costing_changes where request_id = 'f6000000-0000-4000-8000-000000000101'
      )
      from app.recipe_imports$$,
    $$values (repeat('a', 64), true)$$,
    'one receipt carries the structural hash and the change'
  );

select
  is (
    (
      select
        (payload - 'manual_opening_prices')::text ~* '"[a-z_]*(price|cost|amount)[a-z_]*":'
      from
        app.costing_changes
      where
        request_id = 'f6000000-0000-4000-8000-000000000101'
    ),
    false,
    'the stored payload has no price-like key outside the typed section'
  );

select
  is (
    (
      select
        (payload -> 'manual_opening_prices')::text ~ '"unit_cost":'
      from
        app.costing_changes
      where
        request_id = 'f6000000-0000-4000-8000-000000000101'
    ),
    true,
    'only the typed section carries the owner typed costs'
  );

-- ============================================================================
-- 8. Replay.
-- ============================================================================
select
  is (
    app.commit_recipe_import (
      'f6000000-0000-4000-8000-000000000101',
      current_setting('t.base')::jsonb
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'f6000000-0000-4000-8000-000000000101'
    ),
    'replaying the same request returns the stored result'
  );

select
  is (
    app.commit_recipe_import (
      'f6000000-0000-4000-8000-000000000101',
      jsonb_set(
        current_setting('t.base')::jsonb,
        '{items,0,name}',
        '"  فلفل استيراد  "'
      )
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'f6000000-0000-4000-8000-000000000101'
    ),
    'a replay with padded text still matches the stored import'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_imports
    ),
    1::bigint,
    'a replay writes nothing'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-000000000101',
      jsonb_set(current_setting('t.base')::jsonb, '{recipes,1,batch_qty}', '2500'))$$,
    '22023',
    'request_id already used for a different change',
    'the same request id with a different payload errors'
  );

select
  throws_ok (
    $$select app.import_normalize_payload(current_setting('t.base')::jsonb)$$,
    '42501',
    null::text,
    'the owner cannot call the payload normaliser through the API role'
  );

select
  throws_ok (
    $$select app.insert_import_costing_change(
      'f6000000-0000-4000-8000-0000000000f1', null, '{}'::jsonb, '{}'::jsonb
    )$$,
    '42501',
    null::text,
    'the owner cannot append an import change through the API role'
  );

-- ============================================================================
-- 9. Re-import by source name: an unchanged structure creates no version.
-- ============================================================================
select
  set_config(
    't.d1',
    (
      select
        id::text
      from
        app.recipes
      where
        name = 'طبق استيراد'
    ),
    true
  );

select
  set_config(
    't.b1',
    (
      select
        id::text
      from
        app.recipes
      where
        name = 'تتبيلة استيراد'
    ),
    true
  );

select
  set_config(
    't.i1',
    (
      select
        id::text
      from
        app.stock_items
      where
        name = 'فلفل استيراد'
    ),
    true
  );

select
  set_config(
    't.i2',
    (
      select
        id::text
      from
        app.stock_items
      where
        name = 'جمبري جديد استيراد'
    ),
    true
  );

-- The same structure, lines in another order and a different number format.
select
  set_config(
    't.again',
    jsonb_build_object(
      'structural_hash',
      repeat('c', 64),
      'recipes',
      jsonb_build_array(
        jsonb_build_object(
          'key',
          'd1',
          'recipe_id',
          current_setting('t.d1'),
          'expected_token',
          app.recipe_schedule (current_setting('t.d1')::uuid) ->> 'token',
          'kind',
          'dish',
          'lines',
          jsonb_build_array(
            jsonb_build_object(
              'stock_item_id',
              current_setting('t.i2'),
              'quantity',
              '200.000',
              'unit',
              'g'
            ),
            jsonb_build_object(
              'child_recipe_id',
              current_setting('t.b1'),
              'quantity',
              300,
              'unit',
              'g'
            )
          )
        ),
        jsonb_build_object(
          'key',
          'b1',
          'recipe_id',
          current_setting('t.b1'),
          'expected_token',
          app.recipe_schedule (current_setting('t.b1')::uuid) ->> 'token',
          'kind',
          'batch',
          'batch_qty',
          2400,
          'batch_unit',
          'g',
          'lines',
          jsonb_build_array(
            jsonb_build_object(
              'stock_item_id',
              'f6000000-0000-4000-8000-000000000012',
              'quantity',
              50,
              'unit',
              'g'
            ),
            jsonb_build_object(
              'stock_item_id',
              current_setting('t.i1'),
              'quantity',
              100,
              'unit',
              'g'
            )
          )
        )
      ),
      'bindings',
      jsonb_build_array(
        jsonb_build_object(
          'source_name',
          'طبق',
          'recipe_id',
          current_setting('t.d1')
        ),
        jsonb_build_object('source_name', 'تتبيلة', 'recipe_key', 'b1')
      )
    )::text,
    true
  );

select
  lives_ok (
    $$select app.commit_recipe_import(
      'f6000000-0000-4000-8000-000000000102', current_setting('t.again')::jsonb
    )$$,
    'the same structure is imported again'
  );

select
  is (
    (
      select
        result #> '{counts}'
      from
        app.costing_changes
      where
        request_id = 'f6000000-0000-4000-8000-000000000102'
    ),
    '{"items_created":0,"recipes_created":0,"versions_published":0,"recipes_unchanged":2,"losses_set":0,"losses_unchanged":0,"opening_prices_set":0,"bindings":2}'::jsonb,
    'an unchanged structure creates no version, loss or price'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
      where
        recipe_id in (
          current_setting('t.d1')::uuid,
          current_setting('t.b1')::uuid
        )
    ),
    2::bigint,
    'the recipes still have exactly their two versions'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_import_bindings
    ),
    6::bigint,
    'the second import appended its own bindings'
  );

select
  throws_ok (
    $$select app.commit_recipe_import('f6000000-0000-4000-8000-0000000000f0',
      jsonb_set(current_setting('t.again')::jsonb, '{recipes,0,expected_token}', '"stale"'))$$,
    '40001',
    'configuration changed',
    'a stale recipe token fails the re-import even when nothing would change'
  );

-- A changed quantity publishes a new version for that recipe only.
select
  lives_ok (
    $$select app.commit_recipe_import(
      'f6000000-0000-4000-8000-000000000103',
      jsonb_set(current_setting('t.again')::jsonb, '{recipes,0,lines,0,quantity}', '250'))$$,
    'a changed quantity is imported'
  );

select
  is (
    (
      select
        jsonb_agg(
          e ->> 'status'
          order by
            e ->> 'key'
        )
      from
        app.costing_changes c,
        jsonb_array_elements(c.result -> 'recipes') e
      where
        c.request_id = 'f6000000-0000-4000-8000-000000000103'
    ),
    '["unchanged","published"]'::jsonb,
    'only the changed recipe is published'
  );

select
  is (
    (
      select
        l.quantity
      from
        app.recipe_lines l
        join app.recipe_versions v on v.id = l.version_id
      where
        v.recipe_id = current_setting('t.d1')::uuid
        and v.superseded_change_id is null
        and l.stock_item_id = current_setting('t.i2')::uuid
    ),
    250::numeric,
    'the new current version carries the new quantity'
  );

-- ============================================================================
-- 10. A backdated import with a reason.
-- ============================================================================
select
  lives_ok (
    $$select app.commit_recipe_import(
      'f6000000-0000-4000-8000-000000000104',
      jsonb_build_object(
        'structural_hash', repeat('d', 64),
        'effective_from', '2020-01-01T00:00:00Z',
        'reason', 'إدخال قديم',
        'recipes', jsonb_build_array(jsonb_build_object(
          'key', 'old', 'name', 'طبق قديم استيراد', 'kind', 'dish',
          'lines', '[{"stock_item_id":"f6000000-0000-4000-8000-000000000012","quantity":10,"unit":"g"}]'::jsonb
        ))
      ))$$,
    'a backdated import with a reason is committed'
  );

select
  is (
    (
      select
        v.effective_from
      from
        app.recipe_versions v
        join app.recipes r on r.id = v.recipe_id
      where
        r.name = 'طبق قديم استيراد'
    ),
    '2020-01-01 00:00:00+00'::timestamptz,
    'the version starts at the chosen instant'
  );

-- ============================================================================
-- 11. Non-owner and anon.
-- ============================================================================
select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70',
      'role',
      'authenticated'
    )::text,
    true
  );

select
  throws_ok (
    $$select app.commit_recipe_import(
      'f6000000-0000-4000-8000-000000000105', current_setting('t.base')::jsonb
    )$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot commit an import'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_imports
    ),
    0::bigint,
    'a non-owner sees no import receipts'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_import_bindings
    ),
    0::bigint,
    'a non-owner sees no bindings'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    $$select app.commit_recipe_import(
      'f6000000-0000-4000-8000-000000000106', '{}'::jsonb
    )$$,
    '42501',
    null::text,
    'anon cannot commit an import'
  );

select
  throws_ok (
    $$select count(*) from app.recipe_imports$$,
    '42501',
    null::text,
    'anon cannot read the receipts'
  );

select
  throws_ok (
    $$select count(*) from app.recipe_import_bindings$$,
    '42501',
    null::text,
    'anon cannot read the bindings'
  );

reset role;

-- ============================================================================
-- 12. Privileges, as the table owner.
-- ============================================================================
select
  is_empty (
    $$select c.relname, r.role, p.privilege
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      cross join (
        values ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')
      ) as p(privilege)
      where n.nspname = 'app'
        and c.relname in ('recipe_imports', 'recipe_import_bindings')
        and has_table_privilege(r.role, c.oid, p.privilege)$$,
    'no API role can write the import tables'
  );

select
  results_eq (
    $$select c.relname::text collate "default", r.role
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      where n.nspname = 'app'
        and c.relname in ('recipe_imports', 'recipe_import_bindings')
        and has_table_privilege(r.role, c.oid, 'select')
      order by 1, 2$$,
    $$values
      ('recipe_import_bindings'::text, 'authenticated'::text),
      ('recipe_import_bindings', 'service_role'),
      ('recipe_imports', 'authenticated'),
      ('recipe_imports', 'service_role')$$,
    'only authenticated and service_role can select the import tables'
  );

select
  is_empty (
    $$select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app'
        and c.relname in ('recipe_imports', 'recipe_import_bindings')
        and not c.relrowsecurity$$,
    'row level security is on for the import tables'
  );

select
  results_eq (
    $$select p.proname::text collate "default", r.role
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      where n.nspname = 'app'
        and p.proname = 'commit_recipe_import'
        and has_function_privilege(r.role, p.oid, 'execute')
      order by 1, 2$$,
    $$values ('commit_recipe_import'::text, 'authenticated'::text)$$,
    'the commit is executable by authenticated only'
  );

select
  is_empty (
    $$select p.proname, r.role
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      where n.nspname = 'app'
        and (p.proname like 'import\_%' or p.proname = 'insert_import_costing_change')
        and has_function_privilege(r.role, p.oid, 'execute')$$,
    'no API role can execute an internal import helper'
  );

select
  is_empty (
    $$select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and (
          p.proname like 'import\_%'
          or p.proname in ('insert_import_costing_change', 'commit_recipe_import')
        )
        and (
          not p.prosecdef and p.proname in ('commit_recipe_import', 'insert_import_costing_change')
          or not exists (
            select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as c(setting)
            where c.setting in ('search_path=""', 'search_path=')
          )
          or coalesce(obj_description(p.oid, 'pg_proc'), '') = ''
        )$$,
    'every import function pins an empty search_path and carries a comment'
  );

-- ============================================================================
-- 13. Append-only guards, as the table owner.
-- ============================================================================
select
  throws_ok (
    $$update app.recipe_imports set structural_hash = repeat('e', 64)$$,
    '55000',
    'app.recipe_imports is append-only; UPDATE is not allowed',
    'an import receipt cannot be updated'
  );

select
  throws_ok (
    $$delete from app.recipe_imports$$,
    '55000',
    'app.recipe_imports is append-only; DELETE is not allowed',
    'an import receipt cannot be deleted'
  );

select
  throws_ok (
    $$truncate app.recipe_imports cascade$$,
    '55000',
    'app.recipe_imports is append-only; TRUNCATE is not allowed',
    'import receipts cannot be truncated'
  );

select
  throws_ok (
    $$update app.recipe_import_bindings set source_name = 'x'$$,
    '55000',
    'app.recipe_import_bindings is append-only; UPDATE is not allowed',
    'a binding cannot be updated'
  );

select
  throws_ok (
    $$delete from app.recipe_import_bindings$$,
    '55000',
    'app.recipe_import_bindings is append-only; DELETE is not allowed',
    'a binding cannot be deleted'
  );

select
  throws_ok (
    $$truncate app.recipe_import_bindings$$,
    '55000',
    'app.recipe_import_bindings is append-only; TRUNCATE is not allowed',
    'bindings cannot be truncated'
  );

select
  throws_ok (
    $$insert into app.recipe_import_bindings (import_id, source_name, recipe_id, stock_item_id)
      select id, 'x', null, null from app.recipe_imports limit 1$$,
    '23514',
    null::text,
    'a binding must name exactly one target'
  );

select
  throws_ok (
    $$insert into app.recipe_imports (request_id, structural_hash, created_change_id, counts, summary)
      select gen_random_uuid(), 'nothex', id, '{}', '{}' from app.costing_changes limit 1$$,
    '23514',
    null::text,
    'a receipt needs a 64-character lowercase hex hash'
  );

select
  *
from
  finish ();

rollback;
