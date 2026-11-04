import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20261103020000_costing_cutover.sql',
);

function code(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .replace(/ \(/g, '(')
    .trim();
}

function names(sql: string, pattern: RegExp): string[] {
  return [...sql.matchAll(pattern)].map((match) => `app.${match[1]}`);
}

describe('costing cutover migration lock order', () => {
  const sql = readFileSync(migration, 'utf8');
  const lock =
    'select pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);';
  const tables =
    /^do (\$\w+\$) begin lock table ([^;]+) in share row exclusive mode; end; \1;/;

  it('takes the ledger advisory lock as its first statement', () => {
    expect(code(sql).startsWith(lock)).toBe(true);
  });

  it('locks every existing table it changes right after, before any DDL', () => {
    const afterLock = code(sql).slice(lock.length).trim();
    const match = tables.exec(afterLock);
    expect(match).not.toBeNull();
    const locked = (match?.[2] ?? '').split(',').map((name) => name.trim());

    const created = new Set(names(sql, /create table app\.(\w+)/g));
    const changed = new Set([
      ...names(sql, /create trigger \w+[^;]*? on app\.(\w+)/g),
      ...names(sql, /alter table app\.(\w+)/g),
      ...names(sql, /references app\.(\w+)/g),
    ]);
    for (const table of created) changed.delete(table);

    expect(changed.size).toBeGreaterThan(0);
    expect([...changed].filter((table) => !locked.includes(table))).toEqual([]);
  });
});
