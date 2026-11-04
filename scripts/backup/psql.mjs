import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { BackupError } from './config.mjs';
import { sanitizeStderr } from './sanitize.mjs';

export function runPsql({
  sql,
  vars = {},
  singleTransaction = false,
  code = 'PSQL_FAILED',
  env = process.env,
}) {
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(vars)) {
    args.push('-v', `${name}=${value}`);
  }
  if (singleTransaction) {
    args.push('-1');
  }
  args.push('-f', '-');
  const result = spawnSync('psql', args, {
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
    const detail =
      env.BACKUP_PRINT_STDERR === '1' ? sanitizeStderr(result.stderr) : '';
    throw new BackupError(
      code,
      detail ? `psql failed: ${detail}` : 'psql failed (see the stderr file)',
    );
  }
  return result.stdout;
}
