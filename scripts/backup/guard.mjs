import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRoleSafe, planRestorePrep } from './checks.mjs';
import {
  BackupError,
  FORBIDDEN_USAGE_SCHEMAS,
  SCOPE_SCHEMAS,
  assertMajors,
  checkDumpTarget,
  checkRestoreTarget,
  defaultConfigPath,
  isMain,
  parseDbPort,
  readPinnedMajor,
  runCli,
} from './config.mjs';
import { runPsql } from './psql.mjs';

const roleSql = join(
  dirname(fileURLToPath(import.meta.url)),
  'sql',
  'role-check.sql',
);

function rows(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readServerVersionNum(psql = runPsql) {
  const [value] = rows(
    psql({
      sql: "select current_setting('server_version_num');",
      code: 'SERVER_QUERY_FAILED',
    }),
  );
  return value;
}

export function checkRole(psql = runPsql) {
  const output = psql({
    sql: readFileSync(roleSql, 'utf8'),
    vars: { forbidden_usage: JSON.stringify(FORBIDDEN_USAGE_SCHEMAS) },
    code: 'ROLE_QUERY_FAILED',
  });
  const [line] = rows(output).slice(-1);
  let facts = null;
  try {
    facts = line ? JSON.parse(line) : null;
  } catch {
    throw new BackupError('ROLE_QUERY_FAILED', 'role facts are not valid JSON');
  }
  assertRoleSafe(facts);
}

export function checkTargetEmpty(psql = runPsql) {
  const present = rows(
    psql({
      sql: `select nspname from pg_catalog.pg_namespace where nspname in (${SCOPE_SCHEMAS.map((s) => `'${s}'`).join(', ')}) order by 1;`,
      code: 'TARGET_QUERY_FAILED',
    }),
  );
  if (present.length > 0) {
    throw new BackupError(
      'TARGET_NOT_EMPTY',
      `the target already has schema ${present.join(', ')}; restore only into an empty project`,
    );
  }
}

export function prepareRestore({ metadata, psql = runPsql }) {
  const existingRoles = rows(
    psql({
      sql: 'select rolname from pg_catalog.pg_roles order by 1;',
      code: 'TARGET_QUERY_FAILED',
    }),
  );
  const existingExtensions = rows(
    psql({
      sql: 'select extname from pg_catalog.pg_extension order by 1;',
      code: 'TARGET_QUERY_FAILED',
    }),
  );
  const plan = planRestorePrep({ metadata, existingRoles, existingExtensions });
  if (plan.sql) {
    psql({
      sql: plan.sql,
      singleTransaction: true,
      code: 'RESTORE_PREP_FAILED',
    });
  }
  return plan;
}

export function majorArgs(args) {
  const [serverNum, ...tools] = args;
  const clientVersions = {};
  for (const entry of tools) {
    const split = entry.indexOf('=');
    if (split < 1) {
      throw new BackupError('USAGE', 'client versions are <tool>=<text>');
    }
    clientVersions[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return { serverNum, clientVersions };
}

const USAGE =
  'usage: guard.mjs pinned-major | db-port | dump-target | restore-target | ' +
  'assert-major <server_version_num> [tool=version text]... | server-version | ' +
  'role-check | target-empty | restore-prep <manifest.json>';

if (isMain(import.meta.url)) {
  runCli(() => {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
      case 'pinned-major':
        return String(readPinnedMajor());
      case 'db-port':
        return String(parseDbPort(readFileSync(defaultConfigPath(), 'utf8')));
      case 'dump-target':
        return checkDumpTarget(process.env).enforceRole ? '1' : '0';
      case 'restore-target':
        return checkRestoreTarget(process.env).loopback ? '1' : '0';
      case 'assert-major': {
        const { serverNum, clientVersions } = majorArgs(rest);
        assertMajors({ pinned: readPinnedMajor(), serverNum, clientVersions });
        return '';
      }
      case 'server-version':
        return readServerVersionNum();
      case 'role-check':
        checkRole();
        return '';
      case 'target-empty':
        checkTargetEmpty();
        return '';
      case 'restore-prep': {
        if (!rest[0]) {
          throw new BackupError('USAGE', USAGE);
        }
        const manifest = JSON.parse(readFileSync(rest[0], 'utf8'));
        if (!manifest.metadata?.ownerUuid) {
          throw new BackupError('MANIFEST_INVALID', 'manifest has no owner');
        }
        const plan = prepareRestore({ metadata: manifest.metadata });
        return `restore prep: ${plan.extensions.length} extension(s), ${plan.roles.length} placeholder role(s)`;
      }
      default:
        throw new BackupError('USAGE', USAGE);
    }
  });
}
