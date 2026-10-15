import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mode = process.argv[2];
if (mode !== 'write' && mode !== 'check') {
  console.error('Usage: node scripts/db-types.mjs <write|check>');
  process.exit(1);
}

const target = resolve('apps/web/src/lib/database.types.ts');
const result = spawnSync(
  'supabase',
  ['gen', 'types', '--lang', 'typescript', '--local', '--schema', 'public,app'],
  { encoding: 'utf8', shell: process.platform === 'win32' },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

const generated = result.stdout ?? '';

if (mode === 'write') {
  writeFileSync(target, generated);
  console.log(`Wrote ${target}`);
  process.exit(0);
}

const committed = readFileSync(target, 'utf8');
if (committed === generated) {
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'db-types-'));
const tempFile = join(dir, 'database.types.ts');
writeFileSync(tempFile, generated);
console.error(
  'apps/web/src/lib/database.types.ts does not match the local database.',
);
console.error(`Regenerated types: ${tempFile}`);
console.error('Run pnpm db:types and commit the result.');
process.exit(1);
