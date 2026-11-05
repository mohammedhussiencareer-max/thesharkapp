import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareManifests } from './compare.mjs';

function manifest() {
  return {
    format: 1,
    metadata: { ownerUuid: 'a' },
    tables: {
      'app.stock_items': { rows: 3, hash: 'aaa' },
      'app.owner': { rows: 1, hash: 'bbb' },
    },
    sequences: { 'app.costing_changes_id_seq': { lastValue: '4' } },
    fingerprint: {
      'function app.is_owner()': {
        def: 'd1',
        secdef: true,
        acl: ['authenticated=X/postgres'],
      },
      'table app.stock_items': { owner: 'postgres', rls: true },
    },
  };
}

function names(differences) {
  return differences.map((d) => d.object);
}

test('identical manifests have no differences, metadata is ignored', () => {
  const other = manifest();
  other.metadata.ownerUuid = 'different';
  assert.deepEqual(compareManifests(manifest(), other), []);
});

test('a changed row hash names the table', () => {
  const actual = manifest();
  actual.tables['app.stock_items'].hash = 'zzz';
  const differences = compareManifests(manifest(), actual);
  assert.deepEqual(names(differences), ['data app.stock_items']);
  assert.equal(differences[0].detail, 'content hash differs');
});

test('a changed row count names the table and both counts', () => {
  const actual = manifest();
  actual.tables['app.stock_items'].rows = 2;
  const [difference] = compareManifests(manifest(), actual);
  assert.equal(difference.object, 'data app.stock_items');
  assert.match(difference.detail, /rows 3 vs 2/);
});

test('missing and extra tables are named', () => {
  const actual = manifest();
  delete actual.tables['app.owner'];
  actual.tables['app.rogue'] = { rows: 0, hash: 'x' };
  const differences = compareManifests(manifest(), actual);
  assert.deepEqual(names(differences), ['data app.owner', 'data app.rogue']);
  assert.match(differences[0].detail, /missing/);
  assert.match(differences[1].detail, /not in the backup/);
});

test('a sequence that went backwards is named', () => {
  const actual = manifest();
  actual.sequences['app.costing_changes_id_seq'].lastValue = '3';
  assert.deepEqual(names(compareManifests(manifest(), actual)), [
    'sequence app.costing_changes_id_seq',
  ]);
  actual.sequences['app.costing_changes_id_seq'].lastValue = null;
  assert.equal(compareManifests(manifest(), actual).length, 1);
});

test('a sequence that moved forward passes unless strict', () => {
  const actual = manifest();
  actual.sequences['app.costing_changes_id_seq'].lastValue = '5';
  assert.deepEqual(compareManifests(manifest(), actual), []);
  assert.deepEqual(
    names(compareManifests(manifest(), actual, { strictSequences: true })),
    ['sequence app.costing_changes_id_seq'],
  );
});

function withSequence(lastValue) {
  const result = manifest();
  result.sequences['app.costing_changes_id_seq'] = { lastValue };
  return result;
}

test('sequence values above 2^53 are compared exactly, strict or not', () => {
  const low = '9007199254740992';
  const high = '9007199254740993';
  assert.equal(Number(low), Number(high), 'the premise: numbers collide');
  for (const strictSequences of [true, false]) {
    assert.deepEqual(
      compareManifests(withSequence(low), withSequence(low), {
        strictSequences,
      }),
      [],
    );
  }
  assert.deepEqual(
    names(
      compareManifests(withSequence(high), withSequence(low), {
        strictSequences: true,
      }),
    ),
    ['sequence app.costing_changes_id_seq'],
  );
  assert.deepEqual(
    names(
      compareManifests(withSequence(low), withSequence(high), {
        strictSequences: true,
      }),
    ),
    ['sequence app.costing_changes_id_seq'],
  );
  assert.deepEqual(
    names(compareManifests(withSequence(high), withSequence(low))),
    ['sequence app.costing_changes_id_seq'],
  );
  assert.deepEqual(compareManifests(withSequence(low), withSequence(high)), []);
});

test('sequence comparison holds at the bigint limits', () => {
  const max = '9223372036854775807';
  const nearMax = '9223372036854775806';
  assert.deepEqual(
    compareManifests(withSequence(max), withSequence(max), {
      strictSequences: true,
    }),
    [],
  );
  assert.equal(
    compareManifests(withSequence(max), withSequence(nearMax)).length,
    1,
  );
  assert.equal(
    compareManifests(withSequence(nearMax), withSequence(max), {
      strictSequences: true,
    }).length,
    1,
  );
  assert.deepEqual(
    compareManifests(withSequence('-9223372036854775808'), withSequence('1')),
    [],
  );
});

test('fingerprinted sequence definitions that differ above 2^53 are named', () => {
  const def = (max) => ({
    'sequence app.s': { seq: { max, start: '1', cache: '1' } },
  });
  const expected = { ...manifest(), fingerprint: def('9223372036854775807') };
  const actual = { ...manifest(), fingerprint: def('9223372036854775806') };
  assert.deepEqual(names(compareManifests(expected, actual)), [
    'sequence app.s',
  ]);
});

test('a sequence value that is not a decimal string or a safe integer is refused', () => {
  for (const bad of [
    9223372036854776000,
    1.5,
    '1e3',
    '0x10',
    'abc',
    {},
    true,
  ]) {
    assert.throws(
      () => compareManifests(withSequence(bad), withSequence('1')),
      { code: 'MANIFEST_INVALID' },
      String(bad),
    );
  }
  assert.deepEqual(compareManifests(withSequence(4), withSequence('4')), []);
});

test('a dropped function is named', () => {
  const actual = manifest();
  delete actual.fingerprint['function app.is_owner()'];
  const differences = compareManifests(manifest(), actual);
  assert.deepEqual(names(differences), ['function app.is_owner()']);
  assert.match(differences[0].detail, /missing/);
});

test('a changed attribute names the object and the attribute', () => {
  const actual = manifest();
  actual.fingerprint['function app.is_owner()'].secdef = false;
  actual.fingerprint['function app.is_owner()'].acl = [];
  const [difference] = compareManifests(manifest(), actual);
  assert.equal(difference.object, 'function app.is_owner()');
  assert.equal(difference.detail, 'differs in acl, secdef');
});

test('an object outside the backup is named', () => {
  const actual = manifest();
  actual.fingerprint['schema rogue'] = { owner: 'postgres' };
  assert.deepEqual(names(compareManifests(manifest(), actual)), [
    'schema rogue',
  ]);
});

test('an invalid manifest is rejected', () => {
  assert.throws(() => compareManifests({}, manifest()), /MANIFEST|manifest/);
  const noSection = manifest();
  delete noSection.fingerprint;
  assert.throws(() => compareManifests(manifest(), noSection), {
    code: 'MANIFEST_INVALID',
  });
  const wrongFormat = { ...manifest(), format: 2 };
  assert.throws(() => compareManifests(wrongFormat, manifest()), {
    code: 'MANIFEST_INVALID',
  });
});

test('the CLI exits non-zero on any difference and lists each object', () => {
  const script = fileURLToPath(new URL('./compare.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'compare-test-'));
  const same = join(dir, 'a.json');
  const changed = join(dir, 'b.json');
  writeFileSync(same, JSON.stringify(manifest()));
  const other = manifest();
  other.tables['app.stock_items'].hash = 'zzz';
  delete other.fingerprint['function app.is_owner()'];
  writeFileSync(changed, JSON.stringify(other));

  const ok = spawnSync(process.execPath, [script, same, same], {
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /manifests match/);

  const bad = spawnSync(process.execPath, [script, same, changed], {
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /DIFF data app\.stock_items/);
  assert.match(bad.stdout, /DIFF function app\.is_owner\(\)/);
  assert.match(bad.stderr, /\[COMPARE_DIFF\]/);

  const missing = spawnSync(process.execPath, [script, same], {
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
});
