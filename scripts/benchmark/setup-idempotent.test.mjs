import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setupSql } from './accounting-history.mjs';

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
