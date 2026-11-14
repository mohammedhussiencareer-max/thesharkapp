import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const restore = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'restore.sh'),
  'utf8',
);

test('restore applies constraints before the manifest compare', () => {
  const constraints = restore.indexOf(
    'restoring constraints, indexes, triggers and policies (post-data)',
  );
  const compare = restore.indexOf(
    'comparing the restored database with the backup manifest',
  );
  assert.ok(constraints > 0);
  assert.ok(compare > constraints);
  assert.equal(restore.includes('replay_checkpoint_invalidations'), false);
});
