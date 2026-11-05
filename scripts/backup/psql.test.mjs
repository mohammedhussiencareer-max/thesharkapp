import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureMessage, readSqlstate, runPsql } from './psql.mjs';

const synthetic = {
  BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
  BACKUP_ALLOW_LOOPBACK: '1',
  PGHOST: '127.0.0.1',
};

const leaky = [
  'psql:<stdin>:3: ERROR:  invalid input syntax for type uuid: "first',
  'ERROR: PRIVATE-DATA',
  'last"',
  'DETAIL:  Failing row contains (PRIVATE-DATA).',
].join('\n');

function run(env, result) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: '', ...result };
  };
  let error = null;
  try {
    runPsql({ sql: 'select 1', env, spawn });
  } catch (caught) {
    error = caught;
  }
  return { calls, error };
}

test('production asks psql for SQLSTATE only and reports a fixed message with the code', () => {
  const { calls, error } = run(
    {},
    { status: 3, stderr: 'psql:<stdin>:3: ERROR:  22P02\n' },
  );
  assert.ok(calls[0].args.join(' ').includes('-v VERBOSITY=sqlstate'));
  assert.equal(error.code, 'PSQL_FAILED');
  assert.equal(error.message, 'psql failed (exit 3, SQLSTATE 22P02)');
});

test('production never prints server text, even when psql ignores VERBOSITY or the old flag is set', () => {
  for (const env of [
    {},
    { BACKUP_PRINT_STDERR: '1' },
    { BACKUP_SYNTHETIC_DIAGNOSTICS: '1' },
    { ...synthetic, PGHOST: 'db.example.com' },
    { ...synthetic, BACKUP_ALLOW_LOOPBACK: '0' },
  ]) {
    const { error } = run(env, { status: 3, stderr: leaky });
    assert.equal(error.message, 'psql failed (exit 3)', JSON.stringify(env));
  }
});

test('a connection failure reports its exit status and nothing else', () => {
  const { error } = run(
    {},
    {
      status: 2,
      stderr:
        'psql: error: connection to server at "10.0.0.7", port 5432 failed: FATAL:  password authentication failed for user "Ahmed"\n',
    },
  );
  assert.equal(error.message, 'psql failed (exit 2)');
  const killed = run({}, { status: null, stderr: '' });
  assert.equal(killed.error.message, 'psql failed (exit signal)');
});

test('the SQLSTATE parser accepts only a whole line holding a five-character code', () => {
  assert.equal(readSqlstate('ERROR:  42P01'), '42P01');
  assert.equal(readSqlstate('psql:<stdin>:12: FATAL:  28P01\n'), '28P01');
  for (const bad of [
    'ERROR:  relation "x" does not exist',
    'ERROR:  42P01 and more text',
    'ERROR:  lower',
    'NOTICE:  00000',
    '',
    undefined,
  ]) {
    assert.equal(readSqlstate(bad), null, String(bad));
  }
});

test('the synthetic round trip keeps full messages, sanitized and multiline-safe', () => {
  const { calls, error } = run(synthetic, { status: 3, stderr: leaky });
  assert.ok(!calls[0].args.some((arg) => arg.startsWith('VERBOSITY=')));
  assert.match(error.message, /^psql failed: psql:<stdin>:3: ERROR:/);
  assert.ok(error.message.includes('type uuid: "<q>"'), error.message);
  assert.ok(!error.message.includes('PRIVATE-DATA'), error.message);
  assert.equal(
    failureMessage({ status: 3, stderr: 'NOTICE: nothing useful' }, synthetic),
    'psql failed (exit 3)',
  );
});
