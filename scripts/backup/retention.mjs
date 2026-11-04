import { readFileSync } from 'node:fs';
import { BackupError, formatError, isMain } from './config.mjs';

export const POLICY = {
  daily: 14,
  weekly: 8,
  monthly: 24,
  minVerified: 7,
  maxDeletions: 5,
};

const TAG =
  /^backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(\d+(?:-\d+)?)$/;

export function formatTag(date, runId) {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `backup-${stamp}-${runId}`;
}

export function parseTag(tag) {
  const match = TAG.exec(tag);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s, runId] = match;
  const time = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  const roundTrip = formatTag(time, runId);
  return roundTrip === tag ? { time, runId } : null;
}

export function cairoDay(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isoWeekKey(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date - firstThursday) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const MAX_DELETIONS_LIMIT = 50;

export function assertPolicy(policy) {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BackupError(
        'USAGE',
        `retention policy ${name} must be a nonnegative integer`,
      );
    }
  }
  if (policy.maxDeletions > MAX_DELETIONS_LIMIT) {
    throw new BackupError(
      'USAGE',
      `retention policy maxDeletions must be at most ${MAX_DELETIONS_LIMIT}`,
    );
  }
}

export function planRetention({
  backups,
  currentRunFailed = false,
  policy = POLICY,
}) {
  assertPolicy(policy);
  const verified = [];
  const ignored = [];
  for (const backup of backups) {
    const parsed = parseTag(backup.tag);
    if (!parsed || backup.verified !== true) {
      ignored.push(backup.tag);
      continue;
    }
    verified.push({
      tag: backup.tag,
      time: parsed.time,
      day: cairoDay(parsed.time),
    });
  }
  verified.sort((a, b) => b.time - a.time || (a.tag < b.tag ? 1 : -1));

  const reasons = new Map(verified.map((v) => [v.tag, []]));
  for (const v of verified.slice(0, policy.minVerified)) {
    reasons.get(v.tag).push('newest');
  }
  const keepPeriods = (keyOf, count, label) => {
    const seen = new Set();
    for (const v of verified) {
      const key = keyOf(v);
      if (seen.has(key)) {
        continue;
      }
      if (seen.size >= count) {
        break;
      }
      seen.add(key);
      reasons.get(v.tag).push(label);
    }
  };
  keepPeriods((v) => v.day, policy.daily, 'daily');
  keepPeriods((v) => isoWeekKey(v.day), policy.weekly, 'weekly');
  keepPeriods((v) => v.day.slice(0, 7), policy.monthly, 'monthly');

  const expired = verified
    .filter((v) => reasons.get(v.tag).length === 0)
    .reverse()
    .map((v) => v.tag);
  const skipped = currentRunFailed ? 'the current run failed' : null;
  const remove = skipped ? [] : expired.slice(0, policy.maxDeletions);

  return {
    keep: verified.map((v) => ({ tag: v.tag, reasons: reasons.get(v.tag) })),
    delete: remove,
    deferred: skipped ? 0 : expired.length - remove.length,
    ignored,
    skipped,
  };
}

function parseLimit(text) {
  if (typeof text !== 'string' || !/^\d{1,3}$/.test(text)) {
    throw new BackupError(
      'USAGE',
      `--max-deletions needs an integer from 0 to ${MAX_DELETIONS_LIMIT}`,
    );
  }
  return Number(text);
}

function parseArgs(argv) {
  const options = { dryRun: false, failed: false, input: null, max: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--current-run-failed') {
      options.failed = true;
    } else if (arg === '--input') {
      i += 1;
      options.input = argv[i];
    } else if (arg === '--max-deletions') {
      i += 1;
      options.max = parseLimit(argv[i]);
    } else {
      throw new BackupError('USAGE', `unknown argument ${arg}`);
    }
  }
  if (!options.input) {
    throw new BackupError(
      'USAGE',
      'usage: retention.mjs --input <file|-> [--dry-run] [--current-run-failed] [--max-deletions N]',
    );
  }
  return options;
}

export function renderPlan(plan) {
  const lines = plan.keep.map(
    (k) => `keep    ${k.tag}  ${k.reasons.join(',') || '-'}`,
  );
  lines.push(...plan.delete.map((tag) => `delete  ${tag}`));
  lines.push(...plan.ignored.map((tag) => `ignore  ${tag}`));
  if (plan.skipped) {
    lines.push(`no deletions: ${plan.skipped}`);
  }
  if (plan.deferred > 0) {
    lines.push(`${plan.deferred} more expired, deferred to the next run`);
  }
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const raw = readFileSync(options.input === '-' ? 0 : options.input, 'utf8');
    const backups = JSON.parse(raw);
    const policy =
      options.max === null ? POLICY : { ...POLICY, maxDeletions: options.max };
    const plan = planRetention({
      backups,
      currentRunFailed: options.failed,
      policy,
    });
    const out = options.dryRun ? renderPlan(plan) : plan.delete.join('\n');
    if (out) {
      console.log(out);
    }
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
}
