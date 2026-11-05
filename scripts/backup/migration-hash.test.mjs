import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  hashMigrationRows,
  hashStatements,
  normalizeSql,
  normalizeStatements,
} from './migration-hash.mjs';

const same = (a, b, label) =>
  assert.equal(hashStatements(a), hashStatements(b), label);
const differ = (a, b, label) =>
  assert.notEqual(hashStatements(a), hashStatements(b), label);

test('whitespace inside a string literal or quoted identifier is content', () => {
  differ(["select 'a b';"], ["select 'ab';"], 'a b vs ab');
  differ(["select 'a  b';"], ["select 'a b';"], 'two spaces vs one');
  differ(["select 'a\nb';"], ["select 'a b';"], 'newline vs space');
  differ(['select "a b" from t;'], ['select "ab" from t;'], 'identifier');
  differ(['select "A" from t;'], ['select "a" from t;'], 'identifier case');
  differ(["select 'x';"], ["select 'y';"], 'different literal');
  same(
    ["select   'a b'\n\tfrom  t ;"],
    ["select 'a b' from t;"],
    'whitespace outside literals',
  );
});

test('whitespace outside literals is collapsed, case and tokens are kept', () => {
  assert.deepEqual(normalizeSql('  select\r\n  1 ,\t2\f from   t  ;  '), [
    'select 1 , 2 from t',
  ]);
  differ(['select 1,2'], ['select 1, 2'], 'a space where there was none');
  differ(['SELECT 1'], ['select 1'], 'keyword case is not folded');
  differ(['select 1 + 2'], ['select 1 - 2'], 'operators');
});

test('one chunk and statement-per-element forms of a migration match', () => {
  const split = ['select 1', 'select 2'];
  same(['select 1;\nselect 2;'], split, 'single chunk');
  same(['select 1;', 'select 2;'], split, 'semicolons kept');
  same(['select 1;\n\n  select 2;\n;'], split, 'empty statement and tail');
  same(['  select 1  ;', ' ', '', 'select 2'], split, 'blank elements');
  same([';;select 1;;select 2;;'], split, 'empty statements');
  same(['select 1; select 2', ''], split, 'no final semicolon');
  differ(['select 2', 'select 1'], split, 'order');
  differ(['select 1 select 2'], split, 'a missing delimiter');
  differ(['select 1;'], split, 'a dropped statement');
  assert.deepEqual(normalizeStatements(['a;b;', 'c', ' ; ']), ['a', 'b', 'c']);
});

test('a semicolon inside a literal or quoted identifier does not split', () => {
  assert.deepEqual(normalizeSql('select \'a;b\'; select "c;d";'), [
    "select 'a;b'",
    'select "c;d"',
  ]);
  same(["select 'a;b'; select 2;"], ["select 'a;b'", 'select 2'], 'literal');
  differ(["select 'a;b'"], ["select 'a'; select 'b'"], 'literal vs two');
});

test('quote escapes keep a literal open until its real end', () => {
  assert.deepEqual(normalizeSql("select 'it''s; fine'; select 2"), [
    "select 'it''s; fine'",
    'select 2',
  ]);
  assert.deepEqual(normalizeSql('select "a""; b"; select 2'), [
    'select "a""; b"',
    'select 2',
  ]);
  // E'..' honours a backslash escape, a plain string does not.
  assert.deepEqual(normalizeSql("select E'it\\'s; ok'; select 2"), [
    "select E'it\\'s; ok'",
    'select 2',
  ]);
  assert.deepEqual(normalizeSql("select 'a\\'; select 2"), [
    "select 'a\\'",
    'select 2',
  ]);
  assert.deepEqual(normalizeSql("select e'a\\\\'; select 2"), [
    "select e'a\\\\'",
    'select 2',
  ]);
  assert.deepEqual(normalizeSql("select name'x; y'; select 2"), [
    "select name'x; y'",
    'select 2',
  ]);
  differ(["select E'a\\'  b';"], ["select E'a\\' b';"], 'inside an E string');
});

test('dollar-quoted bodies keep inner semicolons, whitespace and case', () => {
  const body = 'begin\n  return 1;\nend';
  const fn = (inner) =>
    `create function f() returns int as $$${inner}$$ language plpgsql;`;
  assert.deepEqual(normalizeSql(`${fn(body)}\nselect 2;`), [
    `create function f() returns int as $$${body}$$ language plpgsql`,
    'select 2',
  ]);
  same([`${fn(body)}\nselect 2;`], [fn(body), 'select 2'], 'chunk vs split');
  same([`  ${fn(body)}  `], [fn(body)], 'whitespace outside the body');
  differ([fn(body)], [fn('begin\n  return 1;\nend ')], 'trailing space');
  differ([fn(body)], [fn('begin\n  return 1;  \nend')], 'inner whitespace');
  differ([fn(body)], [fn('begin\n return 1;\nend')], 'indentation');
  differ([fn(body)], [fn('begin\n  return 1; end')], 'a newline');
  differ([fn(body)], [fn('begin\n  return 2;\nend')], 'a changed value');
  differ([fn('select 1; select 2')], [fn('select 1 select 2')], 'inner ;');
  differ([fn('select 1; select 2')], [fn('select 1;select 2')], 'inner gap');
});

test('tagged dollar quotes end only at the same tag', () => {
  const text =
    'do $outer$ begin perform $$x;$$; perform $inner$ y; $inner$; end $outer$; select 2;';
  assert.deepEqual(normalizeSql(text), [
    'do $outer$ begin perform $$x;$$; perform $inner$ y; $inner$; end $outer$',
    'select 2',
  ]);
  differ(
    ['do $a$ x;  y $a$;'],
    ['do $a$ x; y $a$;'],
    'whitespace in a tagged body',
  );
  differ(['do $a$ x $a$;'], ['do $b$ x $b$;'], 'different tags');
  // Parameters and identifiers containing $ do not open a dollar quote.
  assert.deepEqual(
    normalizeSql('select $1,  $2 from t where a = $1; select 2'),
    ['select $1, $2 from t where a = $1', 'select 2'],
  );
  assert.deepEqual(normalizeSql('select a$b$c  from  t$$; select 2'), [
    'select a$b$c from t$$',
    'select 2',
  ]);
});

test('comments act as whitespace between tokens and never split or hide', () => {
  same(['select/**/1'], ['select 1'], 'a block comment separates tokens');
  same(['select -- note; with a semicolon\n1;'], ['select 1'], 'line comment');
  same(['select /* ; */ 1;'], ['select 1'], 'semicolon in a block comment');
  same(['select /* a /* nested ; */ still */ 1'], ['select 1'], 'nested');
  same(['-- header\nselect 1; -- trailer'], ['select 1'], 'outer comments');
  same(['select 1; -- trailer', '/* only a comment */'], ['select 1'], 'tail');
  same(['select 1 -- a\r\n+ 2'], ['select 1 + 2'], 'CRLF ends a line comment');
  differ(['sel/**/ect 1'], ['select 1'], 'a comment inside a word');
  differ(
    ['select 1 --\n+ 2'],
    ['select 1 - 2'],
    'a comment is not an operator',
  );
  differ(
    ['select 1 -- a\nfrom t'],
    ['select 1 -- a from t'],
    'line comment end',
  );
  // Comment markers inside literals, identifiers and bodies are content.
  differ(["select '-- a';"], ["select '-- b';"], 'literal with --');
  differ(["select '/* a */';"], ["select '/* b */';"], 'literal with /*');
  differ(['select "a--b";'], ['select "a--c";'], 'identifier with --');
  differ(['do $$ -- a\n$$;'], ['do $$ -- b\n$$;'], 'comment in a body');
  assert.deepEqual(normalizeSql("select '--'; select '/*'; select 3 /* x */"), [
    "select '--'",
    "select '/*'",
    'select 3',
  ]);
});

test('unterminated constructs end at the end of the text without throwing', () => {
  for (const text of [
    "select 'open; select 2",
    'select "open; select 2',
    'select $$open; select 2',
    'select /* open; select 2',
    "select E'open\\",
    'select 1 --',
  ]) {
    assert.ok(normalizeSql(text).length >= 1, text);
  }
  assert.deepEqual(normalizeSql("select 'open; select 2"), [
    "select 'open; select 2",
  ]);
  assert.deepEqual(normalizeSql(''), []);
  assert.deepEqual(normalizeSql(' ;\n-- only a comment'), []);
});

test('null elements and an empty history hash like empty statements', () => {
  same([null, 'select 1'], ['select 1'], 'null element');
  same([], [''], 'empty');
  same([], [null], 'only null');
  assert.match(hashStatements([]), /^[0-9a-f]{32}$/);
});

test('migration rows are hashed in Node and malformed rows are refused', () => {
  const rows = hashMigrationRows(
    [
      { version: '1', name: 'a', statements: ['select 1;\nselect 2;'] },
      { version: '2', name: 'b', statements: ['select 1', 'select 2'] },
      { version: '3', name: 'c', statements: [] },
    ],
    'test',
    'X',
  );
  assert.equal(rows[0].hash, rows[1].hash);
  assert.notEqual(rows[0].hash, rows[2].hash);
  for (const bad of [
    null,
    [null],
    [{ version: 1, name: 'a', statements: [] }],
    [{ version: '1', name: 'a' }],
    [{ version: '1', name: 'a', statements: [{}] }],
  ]) {
    assert.throws(
      () => hashMigrationRows(bad, 'test', 'X'),
      (error) => error.code === 'X',
    );
  }
});

const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

test('every repository migration hashes the same as one chunk and as split statements', () => {
  assert.ok(migrationFiles.length > 0);
  for (const file of migrationFiles) {
    const text = readFileSync(new URL(file, migrationsDir), 'utf8');
    const statements = normalizeSql(text);
    assert.ok(statements.length > 0, file);
    // What the CLI stores: one element per statement, outer semicolon removed.
    same([text], statements, `${file}: one chunk vs split`);
    same(
      [text],
      statements.map((s) => `${s};`),
      `${file}: with semicolons`,
    );
    same([text], [`-- header\n\n${text}\n;\n-- trailer\n`], `${file}: outer`);
    assert.deepEqual(
      normalizeStatements(statements.map((s) => `${s};`)),
      statements,
      `${file}: normalising twice changes nothing`,
    );
  }
});

test('changing a dollar-quoted body or a literal in a real migration changes its hash', () => {
  const file = migrationFiles.find((name) =>
    readFileSync(new URL(name, migrationsDir), 'utf8').includes(
      '$lock_tables$',
    ),
  );
  assert.ok(file, 'the cutover migration with a tagged DO block');
  // Normalised statements hold no comments, so the first match is real code.
  const statements = normalizeSql(
    readFileSync(new URL(file, migrationsDir), 'utf8'),
  );
  const insertAfter = (needle) => {
    const index = statements.findIndex((s) => s.includes(needle));
    assert.ok(index >= 0, needle);
    const at = statements[index].indexOf(needle) + needle.length;
    const changed = [...statements];
    changed[index] =
      `${changed[index].slice(0, at)} ${changed[index].slice(at)}`;
    return changed;
  };
  differ(statements, insertAfter('$lock_tables$'), 'the start of a body');
  differ(statements, insertAfter("'"), 'the start of the first literal');
});
