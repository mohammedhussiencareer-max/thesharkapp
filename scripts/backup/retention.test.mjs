import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cairoDay,
  formatTag,
  isoWeekKey,
  parseTag,
  planRetention,
  POLICY,
  renderPlan,
} from './retention.mjs';

const newest = Date.UTC(2026, 10, 4, 2, 17, 0);

function daily(count, { skipEvery = 0 } = {}) {
  const backups = [];
  for (let i = 0; i < count; i += 1) {
    if (skipEvery && i % skipEvery === skipEvery - 1) {
      continue;
    }
    const time = new Date(newest - i * 86400000);
    backups.push({ tag: formatTag(time, 1000 + i), verified: true });
  }
  return backups;
}

function reasonsOf(plan, tag) {
  return plan.keep.find((k) => k.tag === tag).reasons;
}

test('tags round-trip and reject invalid values', () => {
  const tag = formatTag(new Date(Date.UTC(2026, 10, 4, 2, 17, 5)), 987654);
  assert.equal(tag, 'backup-20261104T021705Z-987654');
  const parsed = parseTag(tag);
  assert.equal(parsed.runId, '987654');
  assert.equal(parsed.time.toISOString(), '2026-11-04T02:17:05.000Z');
  assert.equal(parseTag('backup-20261104T021705Z-987654-2').runId, '987654-2');
  for (const bad of [
    'backup-20261304T021705Z-1',
    'backup-20261104T021705Z-',
    'backup-2026-11-04',
    'v1.0.0',
    '',
  ]) {
    assert.equal(parseTag(bad), null, bad);
  }
});

test('days are Cairo days, not UTC days', () => {
  assert.equal(cairoDay(new Date('2026-11-03T22:30:00Z')), '2026-11-04');
  assert.equal(cairoDay(new Date('2026-11-03T21:30:00Z')), '2026-11-03');
  assert.equal(cairoDay(new Date('2026-07-01T21:30:00Z')), '2026-07-02');
});

test('isoWeekKey follows ISO 8601', () => {
  assert.equal(isoWeekKey('2026-01-01'), '2026-W01');
  assert.equal(isoWeekKey('2025-12-29'), '2026-W01');
  assert.equal(isoWeekKey('2027-01-03'), '2026-W53');
  assert.equal(isoWeekKey('2026-11-02'), '2026-W45');
  assert.equal(isoWeekKey('2026-11-08'), '2026-W45');
});

test('a small history is kept whole', () => {
  const plan = planRetention({ backups: daily(10) });
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.keep.length, 10);
});

test('a long history deletes the oldest expired backups, at most five', () => {
  const backups = daily(60);
  const plan = planRetention({ backups });
  assert.equal(plan.delete.length, POLICY.maxDeletions);
  const kept = plan.keep.filter((k) => k.reasons.length > 0).length;
  const expired = backups.length - kept;
  assert.equal(plan.deferred, expired - POLICY.maxDeletions);
  assert.ok(expired > POLICY.maxDeletions);
  for (const tag of plan.delete) {
    assert.deepEqual(reasonsOf(plan, tag), []);
  }
  const expiredTags = plan.keep
    .filter((k) => k.reasons.length === 0)
    .map((k) => k.tag)
    .sort();
  assert.deepEqual([...plan.delete].sort(), expiredTags.slice(0, 5));
});

test('the 14 newest days are kept as daily backups', () => {
  const backups = daily(60);
  const plan = planRetention({ backups });
  for (const backup of backups.slice(0, 14)) {
    assert.ok(reasonsOf(plan, backup.tag).includes('daily'));
  }
  assert.ok(!reasonsOf(plan, backups[14].tag).includes('daily'));
});

test('weekly and monthly backups survive past the daily window', () => {
  const plan = planRetention({ backups: daily(120) });
  const oldest = daily(120).at(-1).tag;
  assert.ok(plan.delete.every((tag) => tag !== daily(120)[0].tag));
  const monthlyTags = plan.keep.filter((k) => k.reasons.includes('monthly'));
  assert.ok(monthlyTags.length >= 4);
  assert.ok(plan.keep.some((k) => k.reasons.includes('weekly')));
  assert.ok(plan.keep.find((k) => k.tag === oldest));
});

test('only the newest verified backup per Cairo day is kept', () => {
  const sameDay = [
    { tag: formatTag(new Date(newest), 1), verified: true },
    { tag: formatTag(new Date(newest - 3600000), 2), verified: true },
  ];
  const plan = planRetention({
    backups: [...sameDay, ...daily(30).slice(1)],
    policy: { ...POLICY, minVerified: 1, maxDeletions: 100 },
  });
  assert.ok(plan.delete.includes(sameDay[1].tag));
  assert.ok(!plan.delete.includes(sameDay[0].tag));
});

test('the seven newest verified backups are never deleted', () => {
  const plan = planRetention({
    backups: daily(10),
    policy: {
      daily: 1,
      weekly: 0,
      monthly: 0,
      minVerified: 7,
      maxDeletions: 5,
    },
  });
  assert.equal(plan.delete.length, 3);
  const newestSeven = daily(10)
    .slice(0, 7)
    .map((b) => b.tag);
  for (const tag of newestSeven) {
    assert.ok(!plan.delete.includes(tag));
  }
  const empty = planRetention({
    backups: daily(5),
    policy: {
      daily: 0,
      weekly: 0,
      monthly: 0,
      minVerified: 7,
      maxDeletions: 5,
    },
  });
  assert.deepEqual(empty.delete, []);
});

test('no deletions when the current run failed', () => {
  const plan = planRetention({ backups: daily(60), currentRunFailed: true });
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.skipped, 'the current run failed');
  assert.match(renderPlan(plan), /no deletions: the current run failed/);
});

test('unverified and unrecognised tags are ignored and never deleted', () => {
  const backups = [
    ...daily(60),
    { tag: formatTag(new Date(newest + 86400000), 7), verified: false },
    { tag: 'manual-note', verified: true },
  ];
  const plan = planRetention({ backups });
  assert.deepEqual(
    plan.ignored.sort(),
    [backups[60].tag, 'manual-note'].sort(),
  );
  assert.ok(!plan.delete.includes('manual-note'));
  assert.ok(!plan.delete.includes(backups[60].tag));
  assert.ok(!plan.keep.some((k) => k.tag === backups[60].tag));
});

test('a gap in the history keeps what exists', () => {
  const plan = planRetention({ backups: daily(40, { skipEvery: 3 }) });
  assert.ok(plan.keep.length > 0);
  assert.ok(plan.delete.length <= POLICY.maxDeletions);
});

test('the CLI is a dry run that prints keep and delete lines', () => {
  const script = fileURLToPath(new URL('./retention.mjs', import.meta.url));
  const input = JSON.stringify(daily(60));
  const result = spawnSync(
    process.execPath,
    [script, '--dry-run', '--input', '-'],
    { input, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^keep {4}backup-/m);
  assert.equal(result.stdout.match(/^delete {2}/gm).length, 5);

  const plain = spawnSync(process.execPath, [script, '--input', '-'], {
    input,
    encoding: 'utf8',
  });
  assert.equal(plain.stdout.trim().split('\n').length, 5);
  assert.ok(
    plain.stdout.split('\n').every((l) => l === '' || l.startsWith('backup-')),
  );

  const bad = spawnSync(process.execPath, [script, '--nope'], {
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\[USAGE\]/);
});
