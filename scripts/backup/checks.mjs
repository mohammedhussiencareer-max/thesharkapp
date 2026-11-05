import {
  APP_EXTENSIONS,
  BackupError,
  FORBIDDEN_EXTENSIONS,
  OWNER_COLUMNS,
  OWNER_FK_COLUMNS,
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
  for (const object of list(facts.outOfScopeObjects)) {
    violations.push(`application object outside the backup scope: ${object}`);
  }
  const extensions = new Set([...PLATFORM_EXTENSIONS, ...APP_EXTENSIONS]);
  for (const extension of list(facts.extensions)) {
    if (FORBIDDEN_EXTENSIONS.includes(extension)) {
      violations.push(
        `extension ${extension} is installed; its data is outside the backup`,
      );
    } else if (!extensions.has(extension)) {
      violations.push(`extension ${extension} is not in the allowlist`);
    }
  }
  const buckets = facts.storageBuckets;
  if (!Number.isSafeInteger(buckets) || buckets < 0) {
    violations.push(
      'the storage bucket count is unavailable; backup_reader must be able to read storage.buckets(id) (run scripts/backup/provision-backup-reader.sql)',
    );
  } else if (buckets > 0) {
    violations.push(
      `storage holds ${buckets} bucket(s); objects are outside the backup`,
    );
  }
  const fkAllowed = new Set(OWNER_COLUMNS);
  const reported = new Set();
  for (const column of list(facts.ownerFkMap)) {
    if (!fkAllowed.has(column)) {
      reported.add(column);
      violations.push(
        `column ${column} references auth.users but is not in the owner column allowlist`,
      );
    }
  }
  if (Array.isArray(facts.ownerFkMap)) {
    for (const column of OWNER_FK_COLUMNS) {
      if (!facts.ownerFkMap.includes(column)) {
        violations.push(
          `allowlisted owner FK column ${column} does not reference auth.users`,
        );
      }
    }
  }
  for (const column of list(facts.ownerLikeColumns)) {
    if (!fkAllowed.has(column) && !reported.has(column)) {
      violations.push(
        `column ${column} looks like an owner reference but is not in the owner column allowlist`,
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
  for (const key of [
    'memberships',
    'writable',
    'sequenceWrite',
    'storageAccess',
    'schemaCreate',
    'forbiddenUsage',
  ]) {
    if (!Array.isArray(facts[key])) {
      violations.push(`the role check did not report ${key}`);
    }
  }
  if (list(facts.memberships).length > 0) {
    violations.push('role is a member of other roles');
  }
  if (list(facts.writable).length > 0) {
    violations.push(
      `role can write to app tables or columns: ${list(facts.writable).join(', ')}`,
    );
  }
  if (list(facts.sequenceWrite).length > 0) {
    violations.push(
      `role can use or update sequences: ${list(facts.sequenceWrite).join(', ')}`,
    );
  }
  if (list(facts.storageAccess).length > 0) {
    violations.push(
      `role can access storage beyond buckets(id): ${list(facts.storageAccess).join(', ')}`,
    );
  }
  if (list(facts.schemaCreate).length > 0) {
    violations.push(
      `role can create objects in: ${list(facts.schemaCreate).join(', ')}`,
    );
  }
  if (list(facts.forbiddenUsage).length > 0) {
    violations.push(
      `role can enter platform schemas: ${list(facts.forbiddenUsage).join(', ')}`,
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
