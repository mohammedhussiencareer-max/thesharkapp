import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeStderr } from './sanitize.mjs';

const SECRET = ['Ahmed', 'Hassan', '01012345678', 'secret.example.com'];

function assertClean(out, extra = []) {
  for (const word of [...SECRET, ...extra]) {
    assert.ok(!out.includes(word), `leaked ${word}: ${out}`);
  }
}

test('quoted literals in error messages are redacted, words and codes stay', () => {
  const text = [
    'psql:<stdin>:12: ERROR:  invalid input syntax for type uuid: "Ahmed Hassan"',
    "ERROR:  value too long for type character varying(20): '01012345678'",
    'ERROR:  relation "Ahmed_orders" does not exist',
    'ERROR:  date/time field value out of range: "Ahmed"',
    'ERROR:  column "Hassan" of relation "orders" does not exist',
    'pg_restore: error: COPY failed for table "Ahmed": ERROR:  null value in column "Hassan"',
  ].join('\n');
  const out = sanitizeStderr(text);
  assertClean(out);
  assert.ok(
    out.includes(
      'psql:<stdin>:12: ERROR:  invalid input syntax for type uuid: "<q>"',
    ),
  );
  assert.ok(out.includes('relation "<q>" does not exist'));
  assert.ok(out.includes("character varying(20): '<q>'"));
  assert.ok(out.includes('pg_restore: error: COPY failed for table "<q>"'));
});

test('(…)=(…) pairs are redacted, including nested parentheses', () => {
  const out = sanitizeStderr(
    [
      'ERROR:  duplicate key value violates unique constraint "k"',
      'ERROR:  Key (lower(name))=(Ahmed (Hassan)) already exists.',
      'ERROR:  Key (a, b)=(Ahmed, 01012345678) conflicts with Key (c)=(Hassan).',
    ].join('\n'),
  );
  assertClean(out);
  assert.ok(out.includes('violates unique constraint "<q>"'));
  assert.ok(out.includes('(<redacted>)=(<redacted>) already exists.'));
  assert.ok(out.includes('(<redacted>)=(<redacted>) conflicts with'));
});

test('DETAIL/CONTEXT/HINT lines with quotes are dropped, quote-free ones lose their parentheses', () => {
  const out = sanitizeStderr(
    [
      'ERROR:  new row for relation "orders" violates check constraint "c"',
      'DETAIL:  Failing row contains (1, Ahmed, 01012345678).',
      'DETAIL:  Key (name)=(Ahmed) is not present in table "customers".',
      'DETAIL:  Process 41 waits for ShareLock on transaction 77.',
      'CONTEXT:  COPY orders, line 3, column name: "Ahmed"',
      'CONTEXT:  COPY orders, line 4',
      "HINT:  Perhaps you meant 'Hassan'.",
      'HINT:  No function matches the given name and argument types.',
    ].join('\n'),
  );
  assertClean(out);
  assert.ok(out.includes('DETAIL:  Failing row contains (<redacted>).'));
  assert.ok(
    out.includes('DETAIL:  Process 41 waits for ShareLock on transaction 77.'),
  );
  assert.ok(out.includes('CONTEXT:  COPY orders, line 4'));
  assert.ok(!out.includes('customers'));
  assert.ok(!out.includes('line 3'));
  assert.ok(!out.includes('Perhaps'));
  assert.ok(out.includes('HINT:  No function matches'));
});

test('LINE, Query was and Command was echoes keep only their label', () => {
  const out = sanitizeStderr(
    [
      "LINE 1: insert into orders values ('Ahmed', 5)",
      'LINE 7: select Hassan from t where phone = 01012345678',
      'pg_dump: error: query failed: ERROR:  permission denied for table orders',
      'pg_dump: detail: Query was: SELECT * FROM orders WHERE name = Ahmed',
      'pg_restore: error: could not execute query: ERROR:  relation "x" does not exist',
      'Command was: INSERT INTO orders VALUES (1, Ahmed, 01012345678);',
      'STATEMENT:  insert into t values (Hassan)',
    ].join('\n'),
  );
  assertClean(out);
  assert.ok(out.includes('LINE 1: <redacted>'));
  assert.ok(out.includes('LINE 7: <redacted>'));
  assert.ok(out.includes('pg_dump: detail: Query was: <redacted>'));
  assert.ok(out.includes('Command was: <redacted>'));
  assert.ok(out.includes('permission denied for table orders'));
});

test('hosts, IPs, byte sequences and unpaired quotes never leak', () => {
  const out = sanitizeStderr(
    [
      'pg_dump: error: connection to server at "secret.example.com" (2a05:d014::2), port 5432 failed: FATAL:  password authentication failed',
      'pg_dump: error: connection to server at "10.0.0.7", port 5432 failed',
      'ERROR:  invalid byte sequence for encoding "UTF8": 0xc3 0x28',
      "ERROR:  role \"Ahmed\" can't see 'Hassan' now",
      'ERROR:  invalid input syntax for type integer: "Ahmed"Hassan"',
      'ERROR:  syntax error at or near "Ahmed',
      'ERROR:  bad \\x416d6564 value',
    ].join('\n'),
  );
  assertClean(out, ['10.0.0.7', '2a05', 'c3', '416d6564']);
  assert.ok(out.includes('connection to server at "<host>"'));
  assert.ok(out.includes('FATAL:  password authentication failed'));
  assert.ok(out.includes('0x<hex>'));
});

test('curly and guillemet quotes are redacted too', () => {
  const out = sanitizeStderr(
    'ERROR:  Beziehung „Ahmed“ existiert nicht\nERROR:  la relation «Hassan» n’existe pas',
  );
  assertClean(out);
});

test('non-error lines are dropped, long lines and line count are capped', () => {
  const long = `ERROR:  ${'x'.repeat(600)}`;
  const many = Array.from({ length: 40 }, (_, i) => `ERROR:  e${i}`).join('\n');
  assert.equal(sanitizeStderr('NOTICE: hello\nrandom Ahmed'), '');
  assert.ok(sanitizeStderr(long).length <= 300);
  assert.equal(sanitizeStderr(many).split('\n').length, 20);
});

test('sanitizing is idempotent (error lines are sanitized twice on the way out)', () => {
  const text = [
    'psql:<stdin>:12: ERROR:  invalid input syntax for type uuid: "Ahmed"',
    'ERROR:  Key (name)=(Ahmed (x)) already exists.',
    'DETAIL:  Failing row contains (1, Ahmed).',
    'LINE 3: select Ahmed',
    'pg_dump: detail: Query was: select 1',
    'pg_dump: error: connection to server at "secret.example.com" (1.2.3.4), port 5432 failed',
    "ERROR:  role \"Ahmed\" can't see 'Hassan' now",
    'ERROR:  invalid byte sequence: 0xc3 0x28',
    `ERROR:  ${'word '.repeat(100)}`,
  ].join('\n');
  const once = sanitizeStderr(text);
  assert.equal(sanitizeStderr(once), once);
  const wrapped = sanitizeStderr(
    `backup: error [PSQL_FAILED]: psql failed: ${once}`,
  );
  assertClean(wrapped);
});
