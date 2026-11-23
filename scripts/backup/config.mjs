import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function isMain(metaUrl) {
  return (
    Boolean(process.argv[1]) &&
    fileURLToPath(metaUrl) === resolve(process.argv[1])
  );
}

export const RESTORE_CONFIRM = 'RESTORE-INTO-EMPTY-PROJECT';
export const DUMP_SCHEMA = 'app';
export const STRUCTURE_ONLY_SCHEMA = 'ledger_scratch';
export const SCOPE_SCHEMAS = [DUMP_SCHEMA, STRUCTURE_ONLY_SCHEMA];

// Owner foreign keys to auth.users. Add a column here when a new table
// references auth.users; never remove one while old archives may exist.
export const OWNER_FK_COLUMNS = [
  'app.costing_changes.actor_id',
  'app.inventory_activation.approved_by',
  'app.item_opening_prices.approved_by',
  'app.order_disposition_events.actor',
  'app.owner.user_id',
  'app.waste_documents.actor',
];

// Owner audit columns that are not foreign keys. Add a column here when a new
// table stores auth.uid() without referencing auth.users.
export const OWNER_AUDIT_COLUMNS = [
  'app.expense_entries.created_by',
  'app.month_expense_status.confirmed_by',
  'app.opening_stocks.created_by',
  'app.purchases.created_by',
  'app.sort_batches.created_by',
  'app.stock_count_requests.created_by',
  'app.stock_counts.created_by',
  'app.stock_movements.created_by',
];

// Supabase platform schemas. The drift guard never rejects these.
export const PLATFORM_SCHEMAS = [
  '_analytics',
  '_realtime',
  '_supavisor',
  'auth',
  'cron',
  'extensions',
  'graphql',
  'graphql_public',
  'information_schema',
  'net',
  'pgbouncer',
  'pgsodium',
  'pgsodium_masks',
  'public',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'vault',
];

// Every owner column the restore may remap.
export const OWNER_COLUMNS = [...OWNER_FK_COLUMNS, ...OWNER_AUDIT_COLUMNS];

// Extensions whose presence fails the backup with their own message. Empty:
// pg_cron and pg_net are platform extensions. Their jobs stay outside the
// dump. backup_reader still has no usage on auth, cron, net, or vault.
export const FORBIDDEN_EXTENSIONS = [];

// Schemas backup_reader must not be able to enter. storage is not listed: the
// drift guard reads storage.buckets(id), so the role has usage on it, and the
// role check's storageAccess fact allows nothing else there.
export const FORBIDDEN_USAGE_SCHEMAS = ['auth', 'cron', 'net', 'vault'];

// Functions backup_reader may execute, as schema.name(identity arguments), as
// the role check reports them. Empty on purpose: pg_dump reads tables and the
// catalog only, and every app RPC is SECURITY DEFINER with an authorization
// helper that trusts request.jwt.claims, which any session can set. Add an entry
// only after reviewing that the function cannot write.
export const READER_EXECUTE_ALLOWLIST = [];

export const PLATFORM_EXTENSIONS = [
  'pg_cron',
  'pg_graphql',
  'pg_net',
  'pg_stat_statements',
  'pgcrypto',
  'pgjwt',
  'pgsodium',
  'plpgsql',
  'supabase_vault',
  'uuid-ossp',
];

// Extensions the application needs and the restore pre-creates.
export const APP_EXTENSIONS = ['btree_gist'];

// Roles that own Supabase platform objects. postgres is deliberately absent: it
// runs the app's migrations, so its objects outside schemas app and
// ledger_scratch are application data the dump would silently omit.
export const PLATFORM_OBJECT_OWNERS = [
  'dashboard_user',
  'pgbouncer',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_functions_admin',
  'supabase_read_only_user',
  'supabase_realtime_admin',
  'supabase_replication_admin',
  'supabase_storage_admin',
];

// Platform objects that postgres owns (schema.name). Add one when the drift
// guard names a platform object that is not application data.
export const PLATFORM_POSTGRES_OBJECTS = [
  'graphql_public.graphql',
  'supabase_migrations.schema_migrations',
  'supabase_migrations.seed_files',
];

// Roles a fresh Supabase project already has; a missing one refuses the restore.
export const PLATFORM_ROLES = [
  'anon',
  'authenticated',
  'authenticator',
  'dashboard_user',
  'pgbouncer',
  'postgres',
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_read_only_user',
  'supabase_realtime_admin',
  'supabase_replication_admin',
  'supabase_storage_admin',
];

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A URI or keyword conninfo can name another host, or a hostaddr, without the
// first token showing it. The synthetic gate does not try to parse either form.
function connectionDisablesDiagnostics(value) {
  const text = String(value ?? '');
  if (/postgres(?:ql)?:\/\//i.test(text)) {
    return true;
  }
  if (/hostaddr\s*=/i.test(text)) {
    return true;
  }
  return /(?:^|[\s;])(?:host|port|dbname|user|password|sslmode|sslrootcert|sslcert|sslkey|options|application_name|requiressl|gssencmode|channel_binding|target_session_attrs)\s*=/i.test(
    text,
  );
}

// The synthetic gate is the address 127.0.0.1, not a hostname. "localhost"
// stays off: the round-trip test treats it as a production path.
function diagnosticHost(raw) {
  let host = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return host === '127.0.0.1';
}

// Server text may be printed only by the synthetic round trip. Every effective
// host has to be 127.0.0.1: libpq prefers PGHOSTADDR over PGHOST. A service, a
// URI, a conninfo string, or any hostaddr parameter turns this off. An unset
// host is not accepted.
export function diagnosticsAllowed(env = process.env) {
  if (
    env.BACKUP_SYNTHETIC_DIAGNOSTICS !== '1' ||
    env.BACKUP_ALLOW_LOOPBACK !== '1'
  ) {
    return false;
  }
  const hosts = [];
  for (const key of ['PGHOSTADDR', 'PGHOST']) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      hosts.push(...String(value).split(','));
    }
  }
  if (hosts.length === 0 || !hosts.every(diagnosticHost)) {
    return false;
  }
  for (const key of ['PGDATABASE', 'DATABASE_URL']) {
    if (connectionDisablesDiagnostics(env[key])) {
      return false;
    }
  }
  if (env.PGSERVICE) {
    return false;
  }
  return true;
}

export function formatError(error, env = process.env) {
  const known = error instanceof BackupError;
  const code = known ? error.code : 'INTERNAL';
  let message = 'an internal error occurred';
  if (known || diagnosticsAllowed(env)) {
    message = error instanceof Error ? error.message : String(error);
  }
  return `backup: error [${code}]: ${message.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')}`;
}

export function runCli(fn) {
  try {
    const out = fn();
    if (out) {
      console.log(out);
    }
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
}

export function defaultConfigPath(env = process.env) {
  return env.BACKUP_CONFIG_TOML || join(repoRoot, 'supabase', 'config.toml');
}

function dbSection(toml) {
  const values = new Map();
  let inDb = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inDb = section[1].trim() === 'db';
      continue;
    }
    const pair = inDb ? /^([a-z_]+)\s*=\s*(.+)$/.exec(line) : null;
    if (pair) {
      values.set(pair[1], pair[2].trim());
    }
  }
  return values;
}

export function parsePinnedMajor(toml) {
  const value = dbSection(toml).get('major_version');
  if (!value || !/^\d+$/.test(value)) {
    throw new BackupError(
      'CONFIG',
      'major_version not found in the [db] section of config.toml',
    );
  }
  return Number(value);
}

export function parseDbPort(toml) {
  const value = dbSection(toml).get('port');
  if (!value || !/^\d+$/.test(value)) {
    throw new BackupError('CONFIG', 'port not found in [db] of config.toml');
  }
  return Number(value);
}

export function readPinnedMajor(env = process.env) {
  return parsePinnedMajor(readFileSync(defaultConfigPath(env), 'utf8'));
}

export function serverMajor(versionNum) {
  const n = Number(versionNum);
  if (!Number.isInteger(n) || n < 100000) {
    throw new BackupError('CONFIG', 'server_version_num is not a PG10+ value');
  }
  return Math.floor(n / 10000);
}

export function clientMajor(versionText) {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(String(versionText));
  if (!match) {
    throw new BackupError('CONFIG', 'cannot read the client version');
  }
  return Number(match[1]);
}

export function assertMajors({ pinned, serverNum, clientVersions = {} }) {
  const server = serverMajor(serverNum);
  if (server !== pinned) {
    throw new BackupError(
      'MAJOR_MISMATCH',
      `server major ${server} differs from the pinned major ${pinned}`,
    );
  }
  for (const [tool, text] of Object.entries(clientVersions)) {
    const client = clientMajor(text);
    if (client !== pinned) {
      throw new BackupError(
        'CLIENT_MAJOR_MISMATCH',
        `${tool} major ${client} differs from the pinned major ${pinned}`,
      );
    }
  }
}

export function isLoopbackAddress(raw) {
  let host = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (host === '' || host.startsWith('/')) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  host = host.replace(/\.$/, '');
  if (host === 'localhost' || host === '::1' || host === '::') {
    return true;
  }
  if (/^(0{1,4}:){7}0{0,3}1$/.test(host)) {
    return true;
  }
  const mapped = /^::ffff:(\d+(?:\.\d+){3})$/.exec(host);
  if (mapped) {
    host = mapped[1];
  }
  if (host === '0.0.0.0') {
    return true;
  }
  if (!/^127(\.\d{1,3}){0,3}$/.test(host)) {
    return false;
  }
  return host.split('.').every((octet) => Number(octet) <= 255);
}

export function targetHosts(env) {
  const entries = [];
  for (const key of ['PGHOSTADDR', 'PGHOST']) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      entries.push(...value.split(','));
    }
  }
  return entries.length > 0 ? entries : [''];
}

export function classifyTarget(env) {
  const flags = targetHosts(env).map(isLoopbackAddress);
  return {
    allLoopback: flags.every(Boolean),
    anyLoopback: flags.some(Boolean),
  };
}

export function effectiveSslMode(env) {
  return env.PGSSLMODE || 'verify-full';
}

function requireConnectionEnv(env) {
  if (env.PGSERVICE) {
    throw new BackupError(
      'SERVICE_FORBIDDEN',
      'PGSERVICE is set; use explicit PG* variables only',
    );
  }
  for (const key of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
    if (!env[key]) {
      throw new BackupError('ENV_MISSING', `${key} is required`);
    }
  }
}

function requireVerifiedTls(env) {
  const mode = effectiveSslMode(env);
  if (mode !== 'verify-full' && mode !== 'verify-ca') {
    throw new BackupError(
      'SSLMODE_WEAK',
      'a non-loopback host requires PGSSLMODE=verify-full or verify-ca',
    );
  }
}

export function checkDumpTarget(env) {
  requireConnectionEnv(env);
  const { allLoopback, anyLoopback } = classifyTarget(env);
  if (anyLoopback && env.BACKUP_ALLOW_LOOPBACK !== '1') {
    throw new BackupError(
      'LOOPBACK_REFUSED',
      'the dump host is loopback; set BACKUP_ALLOW_LOOPBACK=1 only for local tests',
    );
  }
  if (!allLoopback) {
    requireVerifiedTls(env);
  }
  return {
    loopback: anyLoopback,
    enforceRole: !anyLoopback || env.BACKUP_FORCE_ROLE_CHECK === '1',
  };
}

export function checkRestoreTarget(env) {
  requireConnectionEnv(env);
  const { allLoopback } = classifyTarget(env);
  if (!allLoopback) {
    if (env.BACKUP_RESTORE_CONFIRM !== RESTORE_CONFIRM) {
      throw new BackupError(
        'RESTORE_CONFIRM_REQUIRED',
        `a non-loopback restore needs BACKUP_RESTORE_CONFIRM=${RESTORE_CONFIRM}`,
      );
    }
    requireVerifiedTls(env);
  }
  return { loopback: allLoopback };
}
