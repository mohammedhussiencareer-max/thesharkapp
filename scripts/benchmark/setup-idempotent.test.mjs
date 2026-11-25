import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  setupSql,
  histories,
  lateSql,
  resumeGuardSql,
  sortHistories,
  sortHistorySql,
  sortSuffixSql,
  sortBuildSql,
  sortMeasureSql,
  formatSortResult,
  existingResultRows,
  sortBuffersNote,
  sortGrowthFailed,
  resolveResumePlan,
} from './accounting-history.mjs';

const benchmark = fileURLToPath(
  new URL('./accounting-history.mjs', import.meta.url),
);
const runBenchmark = promisify(execFile);
const resetMessage = /--resume is supported only before measurement starts/;

function psql(sql, { notices = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGCLIENTENCODING=UTF8',
        'supabase_db_thesharkapp',
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-X',
        '-tA',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) resolve((notices ? err : out).trim());
      else reject(new Error((err || out).trim()));
    });
    child.stdin.end(sql);
  });
}

test('benchmark setup can run again after a committed fixture', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  await psql(setupSql(anchor));
  await psql(setupSql(anchor));
  const sales = await psql(
    `select count(*) from app.stock_movements where item_id in (
      'b9e00000-0000-4000-8000-000000000037',
      'b9e00000-0000-4000-8000-000000000367',
      'b9e00000-0000-4000-8000-000000000734'
    ) and movement_type = 'sale';`,
  );
  assert.equal(sales, '3');
});

test('resume reuses an unprocessed late fixture', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const history = {
    name: 'idempotent-late',
    prefix: `bidem${Date.now().toString(36)}`,
  };
  await psql(setupSql(anchor));
  await psql(`
insert into app.pos_shifts (id, opened_at, is_active, pos_update_time)
values (
  '${history.prefix}-shift',
  timestamptz '${anchor}',
  false,
  timestamptz '${anchor}'
)
on conflict (id) do nothing;
`);
  await psql(lateSql(history, anchor));
  await psql(lateSql(history, anchor));
  const orders = await psql(
    `select count(*) from app.pos_orders where id like '${history.prefix}-late%';`,
  );
  const lines = await psql(
    `select count(*) from app.pos_order_lines where order_id like '${history.prefix}-late%';`,
  );
  assert.equal(orders, '1');
  assert.equal(lines, '1');
});

test('resume creates a fresh late order after the previous one posted', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const history = {
    name: 'idempotent-posted',
    prefix: `bipost${Date.now().toString(36)}`,
  };
  await psql(setupSql(anchor));
  await psql(`
insert into app.pos_shifts (id, opened_at, is_active, pos_update_time)
values (
  '${history.prefix}-shift',
  timestamptz '${anchor}',
  false,
  timestamptz '${anchor}'
)
on conflict (id) do nothing;
`);
  await psql(lateSql(history, anchor));
  await psql(`
insert into app.order_cost_applications (
  order_id, cost_input_id, snapshot_id, receipt_kind, disposition,
  occurred_at, shift_id, signature, requirements, work_generation
)
select
  input.order_id,
  input.id,
  input.snapshot_id,
  'posting',
  'sale',
  timestamptz '${anchor}' + interval '10 hours',
  '${history.prefix}-shift',
  md5(input.order_id || '-posted'),
  '[]'::jsonb,
  1
from app.pos_cost_inputs input
where input.order_id = '${history.prefix}-late';
`);
  await psql(lateSql(history, anchor));
  const orders = await psql(
    `select count(*) from app.pos_orders where id like '${history.prefix}-late%';`,
  );
  const unprocessed = await psql(
    `select count(*)
     from app.pos_orders o
     where (o.id = '${history.prefix}-late' or o.id like '${history.prefix}-late-%')
       and exists (
         select 1 from app.pos_cost_inputs input where input.order_id = o.id
       )
       and not exists (
         select 1
         from app.pos_cost_inputs input
         join app.order_cost_applications application
           on application.cost_input_id = input.id
         where input.order_id = o.id
           and application.receipt_kind = 'posting'
       );`,
  );
  assert.equal(orders, '2');
  assert.equal(unprocessed, '1');
});

test('--resume refuses after committed measurement fixtures', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const history = {
    name: 'resume-guard',
    prefix: `bguard${Date.now().toString(36)}`,
  };
  await psql(setupSql(anchor));
  await psql(resumeGuardSql(history));
  await psql(`
insert into app.pos_shifts (id, opened_at, is_active, pos_update_time)
values (
  '${history.prefix}-shift',
  timestamptz '${anchor}',
  false,
  timestamptz '${anchor}'
)
on conflict (id) do nothing;
`);
  await psql(lateSql(history, anchor));
  await psql(resumeGuardSql(history));
  await psql(`
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values (
  md5('bench-sel-${history.prefix}')::uuid,
  'bench sel ${history.prefix}',
  'seafood',
  'kg',
  'daily'
);
`);
  await assert.rejects(() => psql(resumeGuardSql(history)), /pnpm db:reset/);
});

test('sort growth gate rejects 2-year buffers more than 10% over 35-day buffers', () => {
  const rows = [
    {
      kind: 'sort-traversal',
      name: '35-day sorts',
      buffers: 400,
      seconds: 0.1,
    },
    {
      kind: 'sort-traversal',
      name: '1-year sorts',
      buffers: 410,
      seconds: 0.1,
    },
    {
      kind: 'sort-traversal',
      name: '2-year sorts',
      buffers: 440,
      seconds: 0.1,
    },
  ];
  assert.equal(sortGrowthFailed(rows), false);
  assert.match(sortBuffersNote(rows), /warmed/i);
  assert.match(sortBuffersNote(rows), /stayed flat/);
  rows[2].buffers = 441;
  assert.equal(sortGrowthFailed(rows), true);
  assert.match(sortBuffersNote(rows), /warmed/i);
  assert.match(sortBuffersNote(rows), /grew/);
  const formatted = formatSortResult({
    ...rows[0],
    days: 35,
    sorts: 35,
    suffix_movements: 1,
    open_deficits: 3,
    resumed: true,
    warmed: true,
    crossed_2s: false,
    pass: true,
  });
  assert.match(
    formatted,
    /session warmup: rolled-back record_purchase \(warmed\)/,
  );
  assert.match(formatted, /warmed rpc buffers: 400/);
  assert.match(formatted, /warmed rpc seconds: 0\.1/);
});

test('cold sort row round-trips with warmed false and unwarmed rpc labels', () => {
  const formatted = formatSortResult({
    kind: 'sort-traversal',
    name: 'legacy cold sorts',
    days: 35,
    sorts: 35,
    suffix_movements: 1,
    open_deficits: 3,
    resumed: false,
    warmed: false,
    buffers: 400,
    seconds: 0.1,
    crossed_2s: false,
    pass: true,
  });
  const [parsed] = existingResultRows(formatted);
  assert.equal(parsed.warmed, false);
  assert.doesNotMatch(formatted, /warmed/i);
  assert.match(formatted, /^- rpc buffers: 400$/m);
  assert.match(formatted, /^- rpc seconds: 0\.1$/m);
});

test('resume plan scopes refusal to the workload being resumed', () => {
  // Full run interrupted during order build after sorts already committed.
  assert.deepEqual(
    resolveResumePlan({
      startName: null,
      sortOnly: false,
      resume: true,
      sortCommittedCount: sortHistories.length,
      orderCatalogStarted: true,
    }),
    { runSorts: false, orderHistories: histories },
  );
  // Explicit order workload resume ignores committed sorts and earlier order histories.
  assert.deepEqual(
    resolveResumePlan({
      startName: histories[1].name,
      sortOnly: false,
      resume: true,
      sortCommittedCount: sortHistories.length,
      orderCatalogStarted: false,
    }),
    { runSorts: false, orderHistories: histories.slice(1) },
  );
  // Partial sort measurements still refuse on full --resume.
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: 1,
        orderCatalogStarted: true,
      }),
    resetMessage,
  );
  // Committed sorts with no order build in progress still refuse on full --resume.
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: sortHistories.length,
        orderCatalogStarted: false,
      }),
    resetMessage,
  );
  // --sort-only still refuses when any sort measurement is committed.
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: true,
        resume: true,
        sortCommittedCount: 1,
        orderCatalogStarted: false,
      }),
    resetMessage,
  );
});

test('sort build interruption between history commit and suffix commit is resumable', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const history = {
    name: 'interrupted suffix sorts',
    prefix: 's-int-suffix',
    days: 2,
    mixed: 'b9e00000-0000-4000-8000-000000009101',
    size: 'b9e00000-0000-4000-8000-000000009102',
    openingRequest: 'b9e00000-0000-4000-8000-000000009103',
    activationRequest: 'b9e00000-0000-4000-8000-000000009104',
    suffixPurchaseRequest: 'b9e00000-0000-4000-8000-000000009105',
    purchaseRequest: 'b9e00000-0000-4000-8000-000000009106',
  };
  await psql(setupSql(anchor));
  // Commit ONLY the sort-history transaction (simulating interruption before suffix commit).
  const catalog = await psql(
    `select exists (select from app.stock_items where id = '${history.mixed}')`,
  );
  if (catalog === 'f') await psql(sortHistorySql(history, anchor));
  await assert.rejects(
    () => psql(sortMeasureSql(history, anchor).replace('commit;', 'rollback;')),
    /required committed sort suffix fixture is missing or incomplete/,
  );
  // Resuming the suffix transaction repairs the fixture idempotently.
  await psql(sortSuffixSql(history, anchor));
  await psql(sortSuffixSql(history, anchor));
  const notices = await psql(
    sortMeasureSql(history, anchor).replace('commit;', 'rollback;'),
    { notices: true },
  );
  const match = notices.match(/MEASURE (\{[^\r\n]+\})/);
  assert.ok(match, notices);
  const valid = JSON.parse(match[1]);
  assert.deepEqual(
    { pass: valid.pass, resumed: valid.resumed, warmed: valid.warmed },
    { pass: true, resumed: true, warmed: true },
  );
});

test('sort acceptance checks the committed suffix and reports the cut used by the RPC', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const history = {
    name: 'acceptance test sorts',
    prefix: 's-acceptance',
    days: 2,
    mixed: 'b9e00000-0000-4000-8000-000000009001',
    size: 'b9e00000-0000-4000-8000-000000009002',
    openingRequest: 'b9e00000-0000-4000-8000-000000009003',
    activationRequest: 'b9e00000-0000-4000-8000-000000009004',
    suffixPurchaseRequest: 'b9e00000-0000-4000-8000-000000009005',
    purchaseRequest: 'b9e00000-0000-4000-8000-000000009006',
  };
  const catalog = await psql(
    `select exists (select from app.stock_items where id = '${history.mixed}')`,
  );
  if (catalog === 'f') await psql(sortBuildSql(history, anchor));

  async function measure(fixture, clockOffset = null) {
    let sql = sortMeasureSql(fixture, anchor).replace('commit;', 'rollback;');
    if (clockOffset !== null) {
      sql = sql.replace(
        'do $$',
        () =>
          `select set_config('app.test_clock', (timestamptz '${anchor}' + interval '${clockOffset}')::text, true);\ndo $$`,
      );
    }
    const notices = await psql(sql, {
      notices: true,
    });
    const match = notices.match(/MEASURE (\{[^\r\n]+\})/);
    assert.ok(match, notices);
    return JSON.parse(match[1]);
  }

  await assert.rejects(
    () =>
      measure({
        ...history,
        suffixPurchaseRequest: 'b9e00000-0000-4000-8000-000000009007',
      }),
    /required committed sort suffix fixture is missing or incomplete/,
  );
  for (const clockOffset of [null, '3 hours', '22 hours']) {
    const valid = await measure(history, clockOffset);
    assert.deepEqual(
      {
        validPass: valid.pass,
        resumed: valid.resumed,
        actualCut: typeof valid.checkpoint_id,
        hasCutTime:
          typeof valid.cut_occurred_at === 'string' &&
          valid.cut_occurred_at.length > 0,
      },
      { validPass: true, resumed: true, actualCut: 'number', hasCutTime: true },
      `clockOffset=${clockOffset}: ${JSON.stringify(valid)}`,
    );
  }
});

test('benchmark CLI refuses committed measurements before sort skip or --skip-build', async () => {
  // First test --skip-build --resume with ONLY an order measurement marker committed,
  // proving it triggers the order guard without sort markers masking it.
  const order = histories[0];
  await psql(`
    insert into app.stock_items (id, name, kind, base_unit, count_frequency)
    values (md5('bench-sel-${order.prefix}')::uuid, 'order guard marker', 'seafood', 'kg', 'daily')
    on conflict (id) do nothing;
  `);
  const orderResult = await Promise.allSettled([
    runBenchmark(process.execPath, [
      benchmark,
      order.name,
      '--skip-build',
      '--resume',
    ]),
  ]);
  assert.deepEqual(
    orderResult.map((result) =>
      result.status === 'fulfilled'
        ? 'exit 0'
        : resetMessage.test(result.reason.stderr)
          ? 'reset required'
          : result.reason.stderr,
    ),
    ['reset required'],
  );

  // Now commit sort measurement markers and prove --sort-only refuses both with
  // and without --resume instead of silently skipping committed measurements.
  for (const history of sortHistories) {
    await psql(`
      insert into app.stock_items (id, name, kind, base_unit, count_frequency)
      values ('${history.mixed}', '${history.name} guard marker', 'fish_mixed', 'kg', 'daily')
      on conflict (id) do nothing;
      insert into app.purchases (request_id, purchased_at, total_paid, batch_id)
      values ('${history.purchaseRequest}', now(), 0, gen_random_uuid())
      on conflict (request_id) do nothing;
    `);
  }
  const sortResults = await Promise.allSettled([
    runBenchmark(process.execPath, [benchmark, '--sort-only', '--resume']),
    runBenchmark(process.execPath, [benchmark, '--sort-only']),
  ]);
  assert.deepEqual(
    sortResults.map((result) =>
      result.status === 'fulfilled'
        ? 'exit 0'
        : resetMessage.test(result.reason.stderr)
          ? 'reset required'
          : result.reason.stderr,
    ),
    ['reset required', 'reset required'],
  );

  // Committed sort measurements and earlier completed order histories must not
  // block resuming a later order history whose own measurement has not started.
  const nextOrder = histories[1];
  const resultsPath = fileURLToPath(new URL('./RESULTS.md', import.meta.url));
  const savedResults = existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8')
    : null;
  let scopedOrderResult;
  try {
    scopedOrderResult = await Promise.allSettled([
      runBenchmark(process.execPath, [
        benchmark,
        nextOrder.name,
        '--skip-build',
        '--resume',
      ]),
    ]);
  } finally {
    if (savedResults !== null) writeFileSync(resultsPath, savedResults);
  }
  assert.equal(scopedOrderResult[0].status, 'rejected');
  assert.doesNotMatch(scopedOrderResult[0].reason.stderr, resetMessage);
  assert.match(
    scopedOrderResult[0].reason.stderr,
    /measured order is not the queue head/,
  );
});
