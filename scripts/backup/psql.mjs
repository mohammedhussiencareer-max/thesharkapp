import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { BackupError, diagnosticsAllowed } from './config.mjs';
import { sanitizeStderr } from './sanitize.mjs';

// psql with VERBOSITY=sqlstate prints "ERROR:  <5-character code>" and nothing
// else, so no server text (and no row value) ever reaches the output.
const SQLSTATE_LINE = /^(?:psql:\S+:\d+: )?(?:ERROR|FATAL):\s+([0-9A-Z]{5})$/;

export function readSqlstate(stderr) {
  for (const line of String(stderr ?? '').split(/\r?\n/)) {
    const match = SQLSTATE_LINE.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}

export function failureMessage({ status, stderr }, env) {
  if (diagnosticsAllowed(env)) {
    const detail = sanitizeStderr(stderr);
    if (detail) {
      return `psql failed: ${detail}`;
    }
  }
  const state = readSqlstate(stderr);
  const code = state ? `, SQLSTATE ${state}` : '';
  return `psql failed (exit ${status ?? 'signal'}${code})`;
}

export function runPsql({
  sql,
  vars = {},
  singleTransaction = false,
  code = 'PSQL_FAILED',
  env = process.env,
  spawn = spawnSync,
}) {
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  if (!diagnosticsAllowed(env)) {
    args.push('-v', 'VERBOSITY=sqlstate');
  }
  for (const [name, value] of Object.entries(vars)) {
    args.push('-v', `${name}=${value}`);
  }
  if (singleTransaction) {
    args.push('-1');
  }
  args.push('-f', '-');
  const result = spawn('psql', args, {
    input: sql,
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    throw new BackupError(code, 'cannot run psql');
  }
  if (env.BACKUP_STDERR_FILE) {
    appendFileSync(env.BACKUP_STDERR_FILE, result.stderr ?? '');
  }
  if (result.status !== 0) {
    throw new BackupError(code, failureMessage(result, env));
  }
  return result.stdout;
}
