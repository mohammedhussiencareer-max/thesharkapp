import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setupSql, lateSql, resumeGuardSql } from './accounting-history.mjs';

function psql(sql) {
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
      if (code === 0) resolve(out.trim());
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
