import { readFileSync } from 'node:fs';
import {
  BackupError,
  DUMP_SCHEMA,
  OWNER_COLUMNS,
  isMain,
  runCli,
} from './config.mjs';
import { runPsql } from './psql.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/;

export function normaliseUuid(value, label) {
  const text = String(value ?? '').toLowerCase();
  if (!UUID.test(text)) {
    throw new BackupError('BAD_UUID', `${label} is not a UUID`);
  }
  return text;
}

export function parseColumnRef(ref) {
  const match = REF.exec(String(ref));
  if (!match || match[1] !== DUMP_SCHEMA) {
    throw new BackupError(
      'BAD_COLUMN_REF',
      `owner column ${JSON.stringify(ref)} must be app.<table>.<column>`,
    );
  }
  return { schema: match[1], table: match[2], column: match[3] };
}

export function remapColumnList({ ownerFkMap = [], ownerAuditColumns = [] }) {
  if (!Array.isArray(ownerFkMap) || !Array.isArray(ownerAuditColumns)) {
    throw new BackupError(
      'BAD_COLUMN_REF',
      'the manifest owner column lists must be arrays',
    );
  }
  const allowed = new Set(OWNER_COLUMNS);
  const refs = new Set([...ownerFkMap, ...ownerAuditColumns]);
  return [...refs].sort().map((ref) => {
    const parsed = parseColumnRef(ref);
    if (!allowed.has(ref)) {
      throw new BackupError(
        'BAD_COLUMN_REF',
        `owner column ${ref} is not in the maintained owner column allowlist`,
      );
    }
    return { ref, ...parsed };
  });
}

export function checkOwnerSubset(values, oldOwner) {
  const old = normaliseUuid(oldOwner, 'the old owner');
  const offending = values.filter(
    (value) => value !== null && String(value).toLowerCase() !== old,
  );
  return { ok: offending.length === 0, offending: offending.length };
}

export function planRemap({ mode, oldOwner, newOwner }) {
  const old = normaliseUuid(oldOwner, 'the manifest owner');
  if (mode === 'preserve') {
    if (newOwner) {
      throw new BackupError('REMAP_ARGS', 'preserve mode takes no new owner');
    }
    return { mode, old, next: old };
  }
  if (mode === 'remap') {
    const next = normaliseUuid(newOwner, 'the new owner');
    if (next === old) {
      throw new BackupError(
        'REMAP_ARGS',
        'the new owner equals the old owner; use preserve mode',
      );
    }
    return { mode, old, next };
  }
  throw new BackupError('REMAP_ARGS', 'mode must be preserve or remap');
}

const q = (name) => `"${name}"`;

export function distinctValuesSql({ schema, table, column }) {
  return `select distinct ${q(column)}::text from ${q(schema)}.${q(table)} where ${q(column)} is not null order by 1;`;
}

export function buildRemapSql(columns) {
  return columns
    .map(
      ({ schema, table, column }) =>
        `update ${q(schema)}.${q(table)} set ${q(column)} = :'new'::uuid where ${q(column)} = :'old'::uuid;`,
    )
    .join('\n');
}

function lines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function checkOwnerExists({ metadata, mode, newOwner, psql = runPsql }) {
  const plan = planRemap({ mode, oldOwner: metadata.ownerUuid, newOwner });
  remapColumnList(metadata);
  const [found] = lines(
    psql({
      sql: "select exists (select 1 from auth.users where id = :'new'::uuid);",
      vars: { old: plan.old, new: plan.next },
      code: 'REMAP_FAILED',
    }),
  );
  if (found !== 't') {
    throw new BackupError(
      'OWNER_MISSING',
      `the ${mode === 'preserve' ? 'preserved' : 'new'} owner does not exist in the target auth.users`,
    );
  }
  return plan;
}

export function applyRemap({ metadata, mode, newOwner, psql = runPsql }) {
  const plan = checkOwnerExists({ metadata, mode, newOwner, psql });
  const columns = remapColumnList(metadata);
  const vars = { old: plan.old, new: plan.next };
  const ask = (sql) => lines(psql({ sql, vars, code: 'REMAP_FAILED' }));

  for (const column of columns) {
    const verdict = checkOwnerSubset(ask(distinctValuesSql(column)), plan.old);
    if (!verdict.ok) {
      throw new BackupError(
        'REMAP_SUBSET',
        `${column.ref} holds a value other than the old owner`,
      );
    }
  }
  if (mode === 'preserve') {
    return { columns: columns.length, updated: false };
  }

  psql({
    sql: buildRemapSql(columns),
    vars,
    singleTransaction: true,
    code: 'REMAP_FAILED',
  });
  for (const column of columns) {
    const verdict = checkOwnerSubset(ask(distinctValuesSql(column)), plan.next);
    if (!verdict.ok) {
      throw new BackupError(
        'REMAP_SUBSET',
        `${column.ref} still holds a value other than the new owner`,
      );
    }
  }
  return { columns: columns.length, updated: true };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const args = process.argv.slice(2);
    const checkOnly = args[0] === '--check-only';
    const [manifestPath, mode, newOwner] = checkOnly ? args.slice(1) : args;
    if (!manifestPath || !mode) {
      throw new BackupError(
        'USAGE',
        'usage: remap.mjs [--check-only] <manifest.json> preserve | remap <new-owner-uuid>',
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (checkOnly) {
      checkOwnerExists({ metadata: manifest.metadata, mode, newOwner });
      return `owner ${mode}: the target owner exists`;
    }
    const result = applyRemap({
      metadata: manifest.metadata,
      mode,
      newOwner,
    });
    return `owner ${mode}: checked ${result.columns} columns${
      result.updated ? ', replaced the old owner' : ''
    }`;
  });
}
