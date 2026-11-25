import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  setupSql,
  historySql,
  postSql,
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
  sortConditionsMatch,
  sortBuffersNote,
  sortGrowthFailed,
  hasCompletePassingSortResults,
  resolveBuildAnchor,
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
    name: '35-day sorts',
    days: 35,
    sorts: 35,
    suffix_movements: 1,
    open_deficits: 3,
    resumed: true,
    warmed: false,
    buffers: 4600,
    seconds: 0.2,
    crossed_2s: false,
    pass: true,
  });
  const [parsed] = existingResultRows(formatted);
  assert.equal(parsed.warmed, false);
  assert.doesNotMatch(formatted, /warmed/i);
  assert.match(formatted, /^- rpc buffers: 4600$/m);
  assert.match(formatted, /^- rpc seconds: 0\.2$/m);

  const singleColdNote = sortBuffersNote([parsed]);
  assert.doesNotMatch(singleColdNote, /warmed/i);
  assert.equal(
    singleColdNote,
    'Sort-traversal cold RPC: 35-day sorts 4600 cold buffers / 0.2s.',
  );

  const allCold = [
    {
      kind: 'sort-traversal',
      name: '35-day sorts',
      warmed: false,
      buffers: 400,
      seconds: 0.1,
    },
    {
      kind: 'sort-traversal',
      name: '1-year sorts',
      warmed: false,
      buffers: 410,
      seconds: 0.1,
    },
    {
      kind: 'sort-traversal',
      name: '2-year sorts',
      warmed: false,
      buffers: 440,
      seconds: 0.1,
    },
  ];
  assert.equal(sortConditionsMatch(allCold), true);
  assert.equal(sortGrowthFailed(allCold), false);
  const flatColdNote = sortBuffersNote(allCold);
  assert.doesNotMatch(flatColdNote, /warmed/i);
  assert.match(
    flatColdNote,
    /^Sort-traversal cold RPC buffers stayed flat within 10%: /,
  );
  assert.match(flatColdNote, /35-day sorts 400 cold buffers \/ 0\.1s/);

  allCold[2].buffers = 441;
  assert.equal(sortGrowthFailed(allCold), true);
  const grewColdNote = sortBuffersNote(allCold);
  assert.doesNotMatch(grewColdNote, /warmed/i);
  assert.match(
    grewColdNote,
    /^Sort-traversal cold RPC buffers grew by more than 10%: /,
  );

  const mixed = [
    {
      kind: 'sort-traversal',
      name: '35-day sorts',
      warmed: false,
      buffers: 400,
      seconds: 0.1,
    },
    {
      kind: 'sort-traversal',
      name: '1-year sorts',
      warmed: true,
      buffers: 410,
      seconds: 0.1,
    },
    {
      kind: 'sort-traversal',
      name: '2-year sorts',
      warmed: true,
      buffers: 500,
      seconds: 0.1,
    },
  ];
  assert.equal(sortConditionsMatch(mixed), false);
  assert.equal(sortGrowthFailed(mixed), false);
  const mixedNote = sortBuffersNote(mixed);
  assert.match(mixedNote, /mixed cold\/warmed; growth not compared/);
  assert.match(mixedNote, /35-day sorts 400 cold buffers \/ 0\.1s/);
  assert.match(mixedNote, /1-year sorts 410 warmed buffers \/ 0\.1s/);
  assert.match(mixedNote, /2-year sorts 500 warmed buffers \/ 0\.1s/);
  assert.doesNotMatch(mixedNote, /stayed flat|grew by more than 10%/);
});

function passingSortResults(anchor = '2026-11-25 00:00:00+02') {
  return sortHistories.map((history, index) => ({
    kind: 'sort-traversal',
    name: history.name,
    days: history.days,
    sorts: history.days,
    suffix_movements: 1,
    open_deficits: 3,
    resumed: true,
    warmed: true,
    buffers: 1300 + index * 10,
    seconds: 0.02,
    crossed_2s: false,
    pass: true,
    anchor,
    purchase_request: history.purchaseRequest,
  }));
}

test('resume plan scopes refusal to the workload being resumed', () => {
  const buildAnchor = '2026-11-25 00:00:00+02';
  const validSorts = passingSortResults(buildAnchor);

  // Full run interrupted during order build after all sorts passed for the same build.
  assert.deepEqual(
    resolveResumePlan({
      startName: null,
      sortOnly: false,
      resume: true,
      sortCommittedCount: sortHistories.length,
      orderCatalogStarted: true,
      sortResults: validSorts,
      buildAnchor,
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
  // Missing sort results refuse on full --resume even if all sort purchases exist.
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: sortHistories.length,
        orderCatalogStarted: true,
        sortResults: [],
        buildAnchor,
      }),
    resetMessage,
  );
  // Failing individual sort result refuses on full --resume.
  const failedRow = passingSortResults(buildAnchor);
  failedRow[2].pass = false;
  assert.equal(
    hasCompletePassingSortResults(failedRow, { expectedAnchor: buildAnchor }),
    false,
  );
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: sortHistories.length,
        orderCatalogStarted: true,
        sortResults: failedRow,
        buildAnchor,
      }),
    resetMessage,
  );
  // Sort results whose 2-year row exceeded 10% growth refuse on full --resume.
  const growthFailed = passingSortResults(buildAnchor);
  growthFailed[0].buffers = 1000;
  growthFailed[2].buffers = 1101;
  assert.equal(
    hasCompletePassingSortResults(growthFailed, {
      expectedAnchor: buildAnchor,
    }),
    false,
  );
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: sortHistories.length,
        orderCatalogStarted: true,
        sortResults: growthFailed,
        buildAnchor,
      }),
    resetMessage,
  );
  // Sort results from a different build anchor or missing anchor refuse on full --resume.
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: sortHistories.length,
        orderCatalogStarted: true,
        sortResults: passingSortResults('2026-11-24 00:00:00+02'),
        buildAnchor,
      }),
    resetMessage,
  );
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: sortHistories.length,
        orderCatalogStarted: true,
        sortResults: validSorts,
        buildAnchor: null,
      }),
    resetMessage,
  );
  // Mixed cold/warmed sort results refuse on full --resume.
  const mixedSorts = passingSortResults(buildAnchor);
  mixedSorts[0].warmed = false;
  assert.equal(
    hasCompletePassingSortResults(mixedSorts, { expectedAnchor: buildAnchor }),
    false,
  );
  assert.throws(
    () =>
      resolveResumePlan({
        startName: null,
        sortOnly: false,
        resume: true,
        sortCommittedCount: sortHistories.length,
        orderCatalogStarted: true,
        sortResults: mixedSorts,
        buildAnchor,
      }),
    resetMessage,
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
        sortResults: validSorts.slice(0, 1),
        buildAnchor,
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
        sortResults: validSorts,
        buildAnchor,
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

test('build-resume SQL commits day counts with the last order and reuses persisted build anchor', () => {
  const sql = postSql(histories[0], '2026-11-25 00:00:00+02', {
    remaining: 2,
    reset: true,
    already: 0,
  });
  const chunkMatch = sql.match(
    /create procedure pg_temp\.post_bench_chunk\(\)[\s\S]*?\$chunk\$;/,
  );
  assert.ok(chunkMatch, 'expected post_bench_chunk procedure');
  const chunk = chunkMatch[0];
  assert.doesNotMatch(chunk, /commit;\s*if n %/s);
  assert.match(
    chunk,
    /perform pg_temp\.post_next_bench_order\([^)]+\);\s*n := n \+ 1;\s*if n % \d+ = 0 then\s*perform pg_temp\.post_day_count\(n \/ \d+\);\s*end if;\s*commit;/s,
  );

  assert.equal(
    resolveBuildAnchor({
      persistedAnchor: '2026-11-25 00:00:00+02',
      currentAnchor: '2026-11-26 00:00:00+02',
      hasExistingFixtures: true,
    }),
    '2026-11-25 00:00:00+02',
  );
  assert.equal(
    resolveBuildAnchor({
      persistedAnchor: null,
      currentAnchor: '2026-11-26 00:00:00+02',
      hasExistingFixtures: false,
    }),
    '2026-11-26 00:00:00+02',
  );
  assert.throws(
    () =>
      resolveBuildAnchor({
        persistedAnchor: null,
        currentAnchor: '2026-11-26 00:00:00+02',
        hasExistingFixtures: true,
      }),
    /persisted build anchor.*pnpm db:reset/i,
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

test('order day-end stop rolls back the last order with its count so resume writes the anchor', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const history = {
    name: 'atomic-day-count',
    prefix: 'batomic',
    days: 1,
    perDay: 2,
    item: 'b9e00000-0000-4000-8000-000000009201',
    weeklyItem: 'b9e00000-0000-4000-8000-000000009202',
    openingRequest: 'b9e00000-0000-4000-8000-000000009203',
    activationRequest: 'b9e00000-0000-4000-8000-000000009204',
  };
  await psql(setupSql(anchor));
  const catalog = await psql(
    `select exists (select from app.stock_items where id = '${history.item}')`,
  );
  if (catalog === 'f') await psql(historySql(history, anchor));

  // Fail inside post_day_count on day 1's last order; order 2 must roll back with the count.
  const interruptedSql = postSql(history, anchor, {
    remaining: 2,
    reset: true,
    already: 0,
  }).replace(
    'perform pg_temp.post_day_count(n / 2);',
    "raise exception 'simulated stop before day count';",
  );
  await assert.rejects(
    () => psql(interruptedSql),
    /simulated stop before day count/,
  );

  const postedAfterStop = await psql(`
    select count(*)
    from app.order_cost_state s
    join app.order_cost_applications a on a.id = s.owner_application_id
    where s.order_id like '${history.prefix}-%'
      and s.order_id not like '${history.prefix}-late%'
      and a.receipt_kind = 'posting';
  `);
  const countsAfterStop = await psql(`
    select count(*)
    from app.stock_count_lines
    where item_id = '${history.item}';
  `);
  assert.equal(postedAfterStop, '1');
  assert.equal(countsAfterStop, '0');

  // Resuming from already=1 posts order 2 and commits day 1's count together.
  await psql(
    postSql(history, anchor, {
      remaining: 1,
      reset: false,
      already: 1,
    }),
  );
  const postedAfterResume = await psql(`
    select count(*)
    from app.order_cost_state s
    join app.order_cost_applications a on a.id = s.owner_application_id
    where s.order_id like '${history.prefix}-%'
      and s.order_id not like '${history.prefix}-late%'
      and a.receipt_kind = 'posting';
  `);
  const countsAfterResume = await psql(`
    select count(*)
    from app.stock_count_lines
    where item_id = '${history.item}';
  `);
  assert.equal(postedAfterResume, '2');
  assert.equal(countsAfterResume, '1');
});

test('sort build resumed after Cairo midnight reuses the persisted build anchor', async () => {
  const todayAnchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const prevDayAnchor = await psql(
    `select to_char(((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') - interval '1 day') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const history = {
    name: 'cross-midnight sorts',
    prefix: 's-midnight',
    days: 2,
    mixed: 'b9e00000-0000-4000-8000-000000009301',
    size: 'b9e00000-0000-4000-8000-000000009302',
    openingRequest: 'b9e00000-0000-4000-8000-000000009303',
    activationRequest: 'b9e00000-0000-4000-8000-000000009304',
    suffixPurchaseRequest: 'b9e00000-0000-4000-8000-000000009305',
    purchaseRequest: 'b9e00000-0000-4000-8000-000000009306',
  };
  await psql(setupSql(todayAnchor));
  const savedAnchor = await psql(
    `select coalesce((select anchor from public.bench_build_state where id = 1), '');`,
  );
  try {
    await psql(`delete from public.bench_build_state;`);
    const catalog = await psql(
      `select exists (select from app.stock_items where id = '${history.mixed}')`,
    );
    if (catalog === 'f') await psql(sortBuildSql(history, prevDayAnchor));

    const persistedAnchor = await psql(
      `select anchor from public.bench_build_state where id = 1;`,
    );
    assert.equal(persistedAnchor, prevDayAnchor);

    // Measuring with the fresh next-day anchor fails the suffix timestamp check.
    await assert.rejects(
      () =>
        psql(
          sortMeasureSql(history, todayAnchor).replace('commit;', 'rollback;'),
        ),
      /required committed sort suffix fixture is missing or incomplete/,
    );

    // Reusing the persisted build anchor succeeds across Cairo midnight.
    const resumedAnchor = resolveBuildAnchor({
      persistedAnchor,
      currentAnchor: todayAnchor,
      hasExistingFixtures: true,
    });
    assert.equal(resumedAnchor, prevDayAnchor);
    const notices = await psql(
      sortMeasureSql(history, resumedAnchor).replace('commit;', 'rollback;'),
      { notices: true },
    );
    const match = notices.match(/MEASURE (\{[^\r\n]+\})/);
    assert.ok(match, notices);
    const valid = JSON.parse(match[1]);
    assert.deepEqual(
      { pass: valid.pass, resumed: valid.resumed, warmed: valid.warmed },
      { pass: true, resumed: true, warmed: true },
    );
  } finally {
    if (savedAnchor) {
      await psql(`
        insert into public.bench_build_state (id, anchor)
        values (1, '${savedAnchor}')
        on conflict (id) do update set anchor = excluded.anchor;
      `);
    }
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

test('benchmark CLI refuses full --resume when committed sort results failed the sort gate', async () => {
  const anchor = await psql(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  await psql(setupSql(anchor));
  // Mark order build started and commit all 3 sort purchases with a failing 2-year
  // growth result (>10% over 35-day) in public.bench_sort_results. Full --resume
  // must refuse on the sort-traversal gate before running order guards.
  await psql(`
    insert into app.stock_items (id, name, kind, base_unit, count_frequency)
    values ('${histories[0].item}', 'order build started marker', 'seafood', 'kg', 'daily')
    on conflict (id) do nothing;
    create table if not exists public.bench_sort_results (
      name text primary key,
      purchase_request uuid not null,
      anchor text not null,
      payload jsonb not null,
      recorded_at timestamptz not null default pg_catalog.clock_timestamp()
    );
  `);
  const failingGrowth = passingSortResults(anchor);
  failingGrowth[0].buffers = 1000;
  failingGrowth[2].buffers = 1200;
  for (const row of failingGrowth) {
    const history = sortHistories.find((h) => h.name === row.name);
    const payload = JSON.stringify({
      kind: row.kind,
      name: row.name,
      days: row.days,
      sorts: row.sorts,
      suffix_movements: row.suffix_movements,
      open_deficits: row.open_deficits,
      resumed: row.resumed,
      warmed: row.warmed,
      buffers: row.buffers,
      seconds: row.seconds,
      crossed_2s: row.crossed_2s,
      pass: row.pass,
    }).replace(/'/g, "''");
    await psql(`
      insert into app.stock_items (id, name, kind, base_unit, count_frequency)
      values ('${history.mixed}', '${history.name} guard marker', 'fish_mixed', 'kg', 'daily')
      on conflict (id) do nothing;
      insert into app.purchases (request_id, purchased_at, total_paid, batch_id)
      values ('${history.purchaseRequest}', now(), 0, gen_random_uuid())
      on conflict (request_id) do nothing;
      insert into public.bench_sort_results (name, purchase_request, anchor, payload)
      values ('${history.name}', '${history.purchaseRequest}', '${anchor}', '${payload}'::jsonb)
      on conflict (name) do update
      set purchase_request = excluded.purchase_request,
        anchor = excluded.anchor,
        payload = excluded.payload;
    `);
  }

  const resultsPath = fileURLToPath(new URL('./RESULTS.md', import.meta.url));
  const savedResults = existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8')
    : null;
  let resumeResult;
  try {
    resumeResult = await Promise.allSettled([
      runBenchmark(process.execPath, [benchmark, '--resume']),
    ]);
  } finally {
    if (savedResults !== null) writeFileSync(resultsPath, savedResults);
  }
  assert.equal(resumeResult[0].status, 'rejected');
  assert.match(resumeResult[0].reason.stderr, resetMessage);
  assert.match(
    resumeResult[0].reason.stderr,
    /Sort-traversal gate did not pass for this build\./,
  );
});
