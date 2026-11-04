import {
  APP_EXTENSIONS,
  BackupError,
  OWNER_AUDIT_COLUMNS,
  PLATFORM_EXTENSIONS,
  PLATFORM_ROLES,
  PLATFORM_SCHEMAS,
  SCOPE_SCHEMAS,
} from './config.mjs';

const FIX =
  'update scripts/backup/config.mjs and docs/BACKUP.md before the next backup';
const IDENT = /^[a-z_][a-z0-9_]*$/;

const list = (value) => (Array.isArray(value) ? value : []);

export function evaluateDrift(facts) {
  const violations = [];
  const known = new Set([...SCOPE_SCHEMAS, ...PLATFORM_SCHEMAS]);
  for (const schema of list(facts.schemas)) {
    if (!known.has(schema)) {
      violations.push(`schema ${schema} is outside the backup scope`);
    }
  }
  for (const object of list(facts.publicObjects)) {
    violations.push(`application object in public: ${object}`);
  }
  const extensions = new Set([...PLATFORM_EXTENSIONS, ...APP_EXTENSIONS]);
  for (const extension of list(facts.extensions)) {
    if (!extensions.has(extension)) {
      violations.push(`extension ${extension} is not in the allowlist`);
    }
  }
  if (Number(facts.storageObjects) > 0) {
    violations.push(`storage holds ${facts.storageObjects} object(s)`);
  }
  if (Number(facts.cronJobs) > 0) {
    violations.push(`${facts.cronJobs} cron job(s) exist`);
  }
  const mapped = new Set([...list(facts.ownerFkMap), ...OWNER_AUDIT_COLUMNS]);
  for (const column of list(facts.ownerLikeColumns)) {
    if (!mapped.has(column)) {
      violations.push(
        `column ${column} looks like an owner reference but is not mapped`,
      );
    }
  }
  for (const column of list(facts.otherAuthRefs)) {
    violations.push(`${column} references an auth table other than users`);
  }
  for (const column of list(facts.missingAuditColumns)) {
    violations.push(`allowlisted owner column ${column} does not exist`);
  }
  return violations;
}

export function assertNoDrift(facts) {
  const violations = evaluateDrift(facts);
  if (violations.length > 0) {
    throw new BackupError('DRIFT', `${violations.join('; ')}. ${FIX}`);
  }
}

export function evaluateRole(facts) {
  const violations = [];
  if (!facts) {
    return ['the connected role was not found'];
  }
  if (!facts.canLogin) {
    violations.push('role cannot log in');
  }
  if (!facts.bypassRls) {
    violations.push('role lacks BYPASSRLS');
  }
  for (const [flag, label] of [
    ['super', 'SUPERUSER'],
    ['createRole', 'CREATEROLE'],
    ['createDb', 'CREATEDB'],
    ['replication', 'REPLICATION'],
  ]) {
    if (facts[flag]) {
      violations.push(`role has ${label}`);
    }
  }
  if (list(facts.memberships).length > 0) {
    violations.push('role is a member of other roles');
  }
  if (list(facts.writable).length > 0) {
    violations.push(
      `role can write to app tables: ${list(facts.writable).join(', ')}`,
    );
  }
  if (list(facts.schemaCreate).length > 0) {
    violations.push(
      `role can create objects in: ${list(facts.schemaCreate).join(', ')}`,
    );
  }
  return violations;
}

export function assertRoleSafe(facts) {
  const violations = evaluateRole(facts);
  if (violations.length > 0) {
    throw new BackupError('ROLE_UNSAFE', violations.join('; '));
  }
}

function ident(value, label) {
  if (!IDENT.test(String(value))) {
    throw new BackupError('BAD_IDENT', `${label} is not a plain identifier`);
  }
  return `"${value}"`;
}

export function planRestorePrep({
  metadata,
  existingRoles = [],
  existingExtensions = [],
}) {
  const statements = [];
  const extensions = [];
  const roles = [];
  for (const extension of metadata.extensions ?? []) {
    const { name, schema } = extension;
    if (PLATFORM_EXTENSIONS.includes(name)) {
      continue;
    }
    if (!APP_EXTENSIONS.includes(name)) {
      throw new BackupError(
        'RESTORE_UNKNOWN_EXTENSION',
        `extension ${name} is not in the allowlist`,
      );
    }
    if (existingExtensions.includes(name)) {
      continue;
    }
    statements.push(
      `create extension if not exists ${ident(name, 'extension')} with schema ${ident(schema, 'extension schema')};`,
    );
    extensions.push(name);
  }
  for (const role of [...(metadata.aclRoles ?? [])].sort()) {
    if (existingRoles.includes(role)) {
      continue;
    }
    if (PLATFORM_ROLES.includes(role) || role.startsWith('pg_')) {
      throw new BackupError(
        'ROLE_MISSING',
        `platform role ${role} is missing in the target project`,
      );
    }
    statements.push(`create role ${ident(role, 'role')} nologin;`);
    roles.push(role);
  }
  return { sql: statements.join('\n'), extensions, roles };
}
