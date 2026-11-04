import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OWNER_AUDIT_COLUMNS,
  OWNER_COLUMNS,
  OWNER_FK_COLUMNS,
} from './config.mjs';
import {
  applyRemap,
  buildRemapSql,
  checkOwnerExists,
  checkOwnerSubset,
  normaliseUuid,
  parseColumnRef,
  planRemap,
  remapColumnList,
} from './remap.mjs';

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const metadata = {
  ownerUuid: OLD.toUpperCase(),
  ownerFkMap: ['app.owner.user_id', 'app.costing_changes.actor_id'],
  ownerAuditColumns: ['app.stock_movements.created_by'],
};

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

function fakePsql({ userExists = true, values = {} } = {}) {
  const calls = [];
  const psql = ({ sql, vars, singleTransaction }) => {
    calls.push({ sql, vars, singleTransaction: Boolean(singleTransaction) });
    if (sql.startsWith('select exists')) {
      return userExists ? 't\n' : 'f\n';
    }
    if (sql.startsWith('update')) {
      for (const key of Object.keys(values)) {
        values[key] = values[key].map((v) => (v === OLD ? NEW : v));
      }
      return '';
    }
    const match = /from "app"\."([a-z_]+)" where "([a-z_]+)"/.exec(sql);
    return (values[`app.${match[1]}.${match[2]}`] ?? []).join('\n');
  };
  return { calls, psql };
}

test('normaliseUuid lowercases and rejects anything else', () => {
  assert.equal(normaliseUuid(OLD.toUpperCase(), 'x'), OLD);
  for (const bad of ['', 'abc', `${OLD}0`, `${OLD}'; drop`, null, undefined]) {
    assert.equal(
      codeOf(() => normaliseUuid(bad, 'x')),
      'BAD_UUID',
      String(bad),
    );
  }
});

test('parseColumnRef accepts app.table.column only', () => {
  assert.deepEqual(parseColumnRef('app.owner.user_id'), {
    schema: 'app',
    table: 'owner',
    column: 'user_id',
  });
  for (const bad of [
    'auth.users.id',
    'app.owner',
    'app.owner.user_id.x',
    'app.owner."x"',
    'app.owner.x;drop',
    'APP.owner.user_id',
    'ledger_scratch.recompute_row.id',
  ]) {
    assert.equal(
      codeOf(() => parseColumnRef(bad)),
      'BAD_COLUMN_REF',
      bad,
    );
  }
});

test('remapColumnList unions, dedupes and sorts', () => {
  const columns = remapColumnList({
    ownerFkMap: ['app.owner.user_id', 'app.purchases.created_by'],
    ownerAuditColumns: [
      'app.purchases.created_by',
      'app.sort_batches.created_by',
    ],
  });
  assert.deepEqual(
    columns.map((c) => c.ref),
    [
      'app.owner.user_id',
      'app.purchases.created_by',
      'app.sort_batches.created_by',
    ],
  );
  assert.equal(
    codeOf(() => remapColumnList({ ownerFkMap: ['auth.users.id'] })),
    'BAD_COLUMN_REF',
  );
});

test('a column outside the maintained allowlist is rejected from either manifest list', () => {
  for (const bad of [
    'app.stock_items.id',
    'app.stock_movements.id',
    'app.owner.id',
    'app.purchases.supplier_id',
  ]) {
    for (const key of ['ownerFkMap', 'ownerAuditColumns']) {
      assert.throws(
        () =>
          remapColumnList({
            ownerFkMap: ['app.owner.user_id'],
            ownerAuditColumns: ['app.purchases.created_by'],
            [key]: [bad],
          }),
        (error) =>
          error.code === 'BAD_COLUMN_REF' &&
          error.message.includes(bad) &&
          error.message.includes('allowlist'),
        `${key} ${bad}`,
      );
    }
  }
  assert.equal(
    codeOf(() => remapColumnList({ ownerFkMap: 'app.owner.user_id' })),
    'BAD_COLUMN_REF',
  );
  assert.equal(
    codeOf(() => remapColumnList({ ownerAuditColumns: { a: 1 } })),
    'BAD_COLUMN_REF',
  );
});

test('every configured owner column is a valid app column reference', () => {
  const columns = remapColumnList({
    ownerFkMap: OWNER_FK_COLUMNS,
    ownerAuditColumns: OWNER_AUDIT_COLUMNS,
  });
  assert.equal(columns.length, OWNER_COLUMNS.length);
  assert.deepEqual(
    OWNER_FK_COLUMNS.filter((ref) => OWNER_AUDIT_COLUMNS.includes(ref)),
    [],
  );
  assert.ok(OWNER_FK_COLUMNS.includes('app.owner.user_id'));
  assert.ok(OWNER_FK_COLUMNS.includes('app.item_opening_prices.approved_by'));
});

test('a manifest with an unknown owner column is refused before any database call', () => {
  const { calls, psql } = fakePsql();
  const hostile = {
    ...metadata,
    ownerFkMap: [...metadata.ownerFkMap, 'app.stock_items.id'],
  };
  for (const mode of ['preserve', 'remap']) {
    assert.throws(
      () =>
        checkOwnerExists({
          metadata: hostile,
          mode,
          newOwner: mode === 'remap' ? NEW : undefined,
          psql,
        }),
      (error) => error.code === 'BAD_COLUMN_REF',
    );
    assert.throws(
      () =>
        applyRemap({
          metadata: hostile,
          mode,
          newOwner: mode === 'remap' ? NEW : undefined,
          psql,
        }),
      (error) => error.code === 'BAD_COLUMN_REF',
    );
  }
  assert.deepEqual(calls, []);
});

test('the configured audit allowlist is valid and covers the known columns', () => {
  const columns = remapColumnList({ ownerAuditColumns: OWNER_AUDIT_COLUMNS });
  assert.equal(columns.length, OWNER_AUDIT_COLUMNS.length);
  assert.ok(OWNER_AUDIT_COLUMNS.includes('app.stock_movements.created_by'));
  assert.ok(
    OWNER_AUDIT_COLUMNS.includes('app.month_expense_status.confirmed_by'),
  );
});

test('subset check: only the old owner and null are allowed', () => {
  assert.deepEqual(checkOwnerSubset([], OLD), { ok: true, offending: 0 });
  assert.deepEqual(checkOwnerSubset([OLD, null], OLD.toUpperCase()), {
    ok: true,
    offending: 0,
  });
  assert.deepEqual(checkOwnerSubset([OLD, OTHER], OLD), {
    ok: false,
    offending: 1,
  });
  assert.deepEqual(checkOwnerSubset([OTHER, NEW], OLD), {
    ok: false,
    offending: 2,
  });
});

test('planRemap validates the mode and the uuids', () => {
  assert.deepEqual(planRemap({ mode: 'preserve', oldOwner: OLD }), {
    mode: 'preserve',
    old: OLD,
    next: OLD,
  });
  assert.equal(
    planRemap({ mode: 'remap', oldOwner: OLD, newOwner: NEW }).next,
    NEW,
  );
  const args = (extra) => () => planRemap({ oldOwner: OLD, ...extra });
  assert.equal(codeOf(args({ mode: 'preserve', newOwner: NEW })), 'REMAP_ARGS');
  assert.equal(codeOf(args({ mode: 'remap' })), 'BAD_UUID');
  assert.equal(codeOf(args({ mode: 'remap', newOwner: OLD })), 'REMAP_ARGS');
  assert.equal(codeOf(args({ mode: 'swap', newOwner: NEW })), 'REMAP_ARGS');
  assert.equal(
    codeOf(() => planRemap({ mode: 'preserve' })),
    'BAD_UUID',
  );
});

test('buildRemapSql replaces only values equal to the old owner', () => {
  const sql = buildRemapSql(
    remapColumnList({ ownerFkMap: ['app.owner.user_id'] }),
  );
  assert.equal(
    sql,
    `update "app"."owner" set "user_id" = :'new'::uuid where "user_id" = :'old'::uuid;`,
  );
});

test('remap mode replaces the owner in one transaction after the subset check', () => {
  const values = {
    'app.owner.user_id': [OLD],
    'app.costing_changes.actor_id': [OLD],
    'app.stock_movements.created_by': [OLD],
  };
  const { calls, psql } = fakePsql({ values });
  const result = applyRemap({ metadata, mode: 'remap', newOwner: NEW, psql });
  assert.deepEqual(result, { columns: 3, updated: true });
  const updates = calls.filter((c) => c.sql.startsWith('update'));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].singleTransaction, true);
  assert.equal(updates[0].sql.split('\n').length, 3);
  assert.deepEqual(updates[0].vars, { old: OLD, new: NEW });
  const firstUpdate = calls.indexOf(updates[0]);
  assert.ok(
    calls.slice(0, firstUpdate).every((c) => !c.sql.startsWith('update')),
  );
  assert.deepEqual(values['app.owner.user_id'], [NEW]);
});

test('a foreign value stops the remap before any update', () => {
  const { calls, psql } = fakePsql({
    values: { 'app.stock_movements.created_by': [OLD, OTHER] },
  });
  assert.throws(
    () => applyRemap({ metadata, mode: 'remap', newOwner: NEW, psql }),
    (error) =>
      error.code === 'REMAP_SUBSET' &&
      error.message.includes('app.stock_movements.created_by') &&
      !error.message.includes(OTHER),
  );
  assert.ok(calls.every((c) => !c.sql.startsWith('update')));
});

test('a missing target user stops the restore in both modes', () => {
  for (const [mode, newOwner] of [
    ['remap', NEW],
    ['preserve', undefined],
  ]) {
    const { calls, psql } = fakePsql({ userExists: false });
    assert.throws(
      () => applyRemap({ metadata, mode, newOwner, psql }),
      (error) => error.code === 'OWNER_MISSING',
    );
    assert.equal(calls.length, 1);
  }
});

test('preserve mode checks the subset but never updates', () => {
  const { calls, psql } = fakePsql({
    values: { 'app.owner.user_id': [OLD] },
  });
  assert.deepEqual(applyRemap({ metadata, mode: 'preserve', psql }), {
    columns: 3,
    updated: false,
  });
  assert.ok(calls.every((c) => !c.sql.startsWith('update')));
  const { psql: failing } = fakePsql({
    values: { 'app.owner.user_id': [OTHER] },
  });
  assert.throws(
    () => applyRemap({ metadata, mode: 'preserve', psql: failing }),
    (error) => error.code === 'REMAP_SUBSET',
  );
});
