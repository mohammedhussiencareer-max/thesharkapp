#!/usr/bin/env bash
# Backup round trip on a throwaway LOCAL Supabase stack. Used by CI and by the
# private workflow's restore step.
#   ci-roundtrip.sh full                     seed, dump, restore into a second empty stack, compare, negatives
#   ci-roundtrip.sh restore-archive <file>   start an empty stack and restore one archive (owner remap)
# It runs "supabase stop --no-backup", which wipes the local stack of this
# checkout, so it needs CI=true or BACKUP_ROUNDTRIP_CONFIRM=DESTROY-LOCAL-SUPABASE.
# It only ever connects to 127.0.0.1 and ignores any ambient PG* host settings.
# Data is synthetic. Dumps and logs stay in a temp dir that is removed on exit.
set -euo pipefail
set +x

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$here/lib.sh"
backup_init
cd "$repo_root"

mode=${1:-}
confirm_value=DESTROY-LOCAL-SUPABASE
old_owner=a17e0000-0000-4000-8000-000000000001
new_owner=a17e0000-0000-4000-8000-000000000002
# Stack B (the empty restore target) skips storage-api; stack A keeps it so the
# drift guard reads a real storage.buckets.
stack_a_exclude=studio,imgproxy,mailpit,edge-runtime,vector,logflare,realtime
stack_exclude=$stack_a_exclude,storage-api
stack_workdir=""
archives="$work_dir/archives"
neg_dir="$work_dir/negatives"

usage="usage: ci-roundtrip.sh full | restore-archive <archive.tar.gz>"
case "$mode" in
  full) ;;
  restore-archive) [ -n "${2:-}" ] || fail USAGE "$usage" ;;
  *) fail USAGE "$usage" ;;
esac
if [ "${CI:-}" != true ] && [ "${BACKUP_ROUNDTRIP_CONFIRM:-}" != "$confirm_value" ]; then
  fail ROUNDTRIP_CONFIRM "this wipes the local Supabase stack; set BACKUP_ROUNDTRIP_CONFIRM=$confirm_value"
fi

require_tools node tar gzip sha256sum awk sed
setup_pg_path
require_tools psql pg_dump pg_restore

unset PGSERVICE PGSERVICEFILE PGHOSTADDR PGSSLROOTCERT PGSSLCERT PGSSLKEY PGOPTIONS PGPASSFILE
PGHOST=127.0.0.1
PGPORT=$(guard db-port)
PGUSER=postgres
PGPASSWORD=postgres
PGDATABASE=postgres
PGSSLMODE=disable
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
export BACKUP_ALLOW_LOOPBACK=1
export BACKUP_STRICT_SEQUENCES=1
# Server text is printed only by the synthetic "full" run. restore-archive loads
# a real archive and prints fixed messages and SQLSTATE codes only.
unset BACKUP_PRINT_STDERR
if [ "$mode" = full ]; then
  export BACKUP_SYNTHETIC_DIAGNOSTICS=1
else
  unset BACKUP_SYNTHETIC_DIAGNOSTICS
fi

supa() {
  if command -v supabase >/dev/null 2>&1; then
    supabase "$@"
  else
    pnpm exec supabase "$@"
  fi
}

stack_stop() {
  local -a wd=()
  if [ -n "$stack_workdir" ]; then wd=(--workdir "$stack_workdir"); fi
  supa stop --no-backup ${wd[@]+"${wd[@]}"} >/dev/null || true
}

wait_db() {
  local i
  for i in $(seq 1 45); do
    if psql -X -q -c 'select 1' >/dev/null; then return 0; fi
    sleep 2
  done
  fail STACK_START "the local database did not become ready"
}

wait_storage() {
  local i found
  for i in $(seq 1 30); do
    found=$(psql -X -q -A -t -c "select to_regclass('storage.buckets') is not null" || true)
    if [ "$found" = t ]; then return 0; fi
    sleep 2
  done
  fail STACK_START "storage.buckets did not appear in stack A"
}

# stack_start [workdir] [exclude] : a fresh local stack; with a workdir it holds config.toml only (no migrations).
stack_start() {
  stack_stop
  stack_workdir=${1:-}
  local exclude=${2:-$stack_exclude}
  local -a wd=()
  if [ -n "$stack_workdir" ]; then wd=(--workdir "$stack_workdir"); fi
  if ! supa start --exclude "$exclude" ${wd[@]+"${wd[@]}"} >"$work_dir/start.log" 2>&1; then
    # The CLI log can hold server text, so only the synthetic run shows it.
    if [ "${BACKUP_SYNTHETIC_DIAGNOSTICS:-0}" = 1 ]; then
      tail -n 20 "$work_dir/start.log" >&3 || true
    fi
    fail STACK_START "supabase start failed"
  fi
  wait_db
}

make_empty_project() {
  local dir=$1
  mkdir -p "$dir/supabase"
  # The API does not expose app yet: PostgREST fails its health check on a
  # schema that does not exist, and the restore creates app later.
  awk '
    /^\[/ { in_seed = ($0 == "[db.seed]"); in_api = ($0 == "[api]") }
    in_seed && /^enabled[ ]*=/ { print "enabled = false"; next }
    in_api && /^schemas[ ]*=/ { print "schemas = [\"public\", \"graphql_public\"]"; next }
    { print }
  ' "$repo_root/supabase/config.toml" >"$dir/supabase/config.toml"
}

writer_pid=""
writer_stop="$work_dir/writer.stop"
writer_log="$work_dir/writer.err"
reader_password=""

# The writer is a background loop that inserts one expense per round through
# the real RPC. It ends when the stop file appears, or on its first failure.
start_writer() {
  rm -f "$writer_stop"
  : >"$writer_log"
  (
    while [ ! -e "$writer_stop" ]; do
      psql -X -q -v ON_ERROR_STOP=1 -v "owner=$old_owner" \
        -f "$here/testdata/writer.sql" >/dev/null 2>>"$writer_log" || exit 1
      sleep 0.1
    done
  ) &
  writer_pid=$!
}

stop_writer() {
  if [ -n "$writer_pid" ]; then
    : >"$writer_stop"
    wait "$writer_pid" 2>/dev/null || true
    writer_pid=""
  fi
}

writer_rows() {
  psql -X -q -A -t -v ON_ERROR_STOP=1 -c \
    "select count(*) from app.expense_entries where note = 'ci-writer'"
}

# Installed only after the confirm check, so an unconfirmed run never stops the stack.
stack_cleanup() {
  stop_writer
  if [ "${BACKUP_ROUNDTRIP_KEEP_STACK:-0}" != 1 ]; then stack_stop; fi
}
exit_hook=stack_cleanup

sql() {
  psql -X -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null
}

create_user() {
  psql -X -q -v ON_ERROR_STOP=1 -v "uid=$1" -v "email=$2" \
    -f "$here/testdata/create-user.sql" >/dev/null
}

assert_target_empty() {
  local present
  present=$(psql -X -q -A -t -v ON_ERROR_STOP=1 -c \
    "select count(*) from pg_catalog.pg_namespace where nspname in ('app','ledger_scratch')")
  [ "$present" = 0 ] || fail NEGATIVE_LEFT_DATA "a refused restore left schema app or ledger_scratch behind"
}

# expect_fail <label> <expected text> <command>... : the command must fail and print the text.
expect_fail() {
  local label=$1 needle=$2 rc=0
  shift 2
  "$@" >"$work_dir/neg.out" 2>"$work_dir/neg.err" || rc=$?
  if [ "$rc" -eq 0 ]; then
    fail NEGATIVE_PASSED "$label: the command succeeded but must fail"
  fi
  if ! grep -Fq -- "$needle" "$work_dir/neg.out" "$work_dir/neg.err"; then
    node "$backup_dir/sanitize.mjs" "$work_dir/neg.err" 2>&3 || true
    fail NEGATIVE_WRONG "$label: expected $needle in the output"
  fi
  info "negative ok: $label"
}

reader_psql() {
  PGUSER=backup_reader PGPASSWORD=$reader_password \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate "$@"
}

# expect_denied <label> <SQLSTATE or a|b> <sql> : backup_reader must be refused with that code.
# A write is refused with 25006 by the read-only default; "begin read write"
# gets past it, so the privilege check (42501) is what stops the statement.
expect_denied() {
  local label=$1 codes=$2 rc=0
  reader_psql -c "$3" >"$work_dir/den.out" 2>"$work_dir/den.err" || rc=$?
  if [ "$rc" -eq 0 ]; then
    fail DENIAL_PASSED "$label: backup_reader was allowed"
  fi
  if ! grep -Eq "(^|[^0-9A-Za-z])($codes)([^0-9A-Za-z]|\$)" "$work_dir/den.err"; then
    node "$backup_dir/sanitize.mjs" "$work_dir/den.err" 2>&3 || true
    fail DENIAL_WRONG "$label: expected SQLSTATE $codes"
  fi
  info "denied ok: $label"
}

# expect_reader_zero <label> <sql> : backup_reader must read exactly 0.
expect_reader_zero() {
  local label=$1 out
  out=$(reader_psql -c "$2") || fail DENIAL_CONTROL "$label: the query failed"
  [ "$out" = 0 ] || fail DENIAL_PASSED "$label: expected 0"
  info "none ok: $label"
}

# expect_reader_count <label> <sql> : backup_reader must read a positive number.
expect_reader_count() {
  local label=$1 out
  out=$(reader_psql -c "$2") || fail DENIAL_CONTROL "$label: backup_reader could not read it"
  case "$out" in
    '' | *[!0-9]* | 0) fail DENIAL_CONTROL "$label: expected a positive count" ;;
  esac
  info "allowed ok: $label"
}

extract_manifest() {
  mkdir -p "$2"
  tar -xzf "$1" -C "$2" --no-same-owner manifest.json
}

check_migration_metadata() {
  node -e '
    const fs = require("node:fs");
    const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).metadata;
    const files = fs.readdirSync(process.argv[2])
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => [name.split("_")[0], name.slice(name.indexOf("_") + 1, -4)]);
    const recorded = (metadata.migrationEntries ?? []).map((e) => [e.version, e.name]);
    if (
      metadata.migrations.length === 0 ||
      JSON.stringify(metadata.migrations) !== JSON.stringify(files.map((f) => f[0])) ||
      JSON.stringify(recorded) !== JSON.stringify(files)
    ) {
      process.exit(1);
    }
  ' "$1" "$repo_root/supabase/migrations" ||
    fail MIGRATIONS_METADATA "migration versions and names in the manifest differ from supabase/migrations"
}

# mutate_manifest <in> <out> <hash | rename | versions | drop-last> : writes a changed copy;
# drop-last also prints the name of the removed migration.
mutate_manifest() {
  node -e '
    const fs = require("node:fs");
    const [src, dst, mode] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(src, "utf8"));
    const entries = manifest.metadata.migrationEntries;
    if (entries.length === 0) process.exit(1);
    if (mode === "hash") entries[0].hash = "0".repeat(32);
    else if (mode === "rename") entries[0].name += "_renamed";
    else if (mode === "versions") for (const e of entries) e.version = "9" + e.version;
    else if (mode === "drop-last") process.stdout.write(entries.pop().name);
    else process.exit(1);
    fs.writeFileSync(dst, JSON.stringify(manifest));
  ' "$1" "$2" "$3"
}

# expect_unsafe_grant <label> <needle> <grant sql> <revoke sql> [<proof sql>]
# After the grant the reader dump must fail the role check and print the needle.
# The optional proof must succeed as backup_reader, so the grant is known to be live.
expect_unsafe_grant() {
  local label=$1 needle=$2 grant_sql=$3 revoke_sql=$4 proof=${5-}
  sql "$grant_sql"
  if [ -n "$proof" ]; then
    reader_psql -c "$proof" >/dev/null 2>"$work_dir/proof.err" ||
      fail DENIAL_CONTROL "$label: the grant did not give backup_reader the privilege"
  fi
  expect_fail "role check rejects $label" "$needle" \
    env PGUSER=backup_reader PGPASSWORD="$reader_password" BACKUP_FORCE_ROLE_CHECK=1 \
    "$here/dump.sh" "$neg_dir/out"
  sql "$revoke_sql"
}

# restore_archive <archive> <preserve | remap uuid>
restore_archive() {
  "$here/restore.sh" "$@" 2>&3 >/dev/null
}

run_restore_archive() {
  local archive=$1
  make_empty_project "$work_dir/stack-b"
  step "starting an empty stack"
  stack_start "$work_dir/stack-b"
  assert_target_empty
  create_user "$new_owner" "restore-owner@theshark.test"
  step "restoring the archive (remap)"
  env BACKUP_STRICT_SEQUENCES=0 "$here/restore.sh" "$archive" remap "$new_owner" 2>&3 >/dev/null
  info "restore-archive ok"
}

run_full() {
  mkdir -p "$archives/admin" "$archives/reader" "$neg_dir"

  step "stack A: fresh start and migrations"
  stack_start "" "$stack_a_exclude"
  supa --yes db reset >/dev/null || fail STACK_RESET "supabase db reset failed"
  wait_db
  wait_storage

  step "stack A: seeding synthetic data through the real RPCs"
  create_user "$old_owner" "seed-owner@theshark.test"
  psql -X -q -1 -v ON_ERROR_STOP=1 -v "owner=$old_owner" -f "$here/testdata/seed.sql" >/dev/null ||
    fail SEED_FAILED "the synthetic seed failed"

  step "stack A: provisioning backup_reader"
  reader_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')
  psql -X -q -v ON_ERROR_STOP=1 -f "$here/provision-backup-reader.sql" >/dev/null ||
    fail PROVISION_FAILED "provision-backup-reader.sql failed"
  printf "alter role backup_reader password '%s';\n" "$reader_password" |
    psql -X -q -v ON_ERROR_STOP=1 >/dev/null

  step "stack A: dump as the admin role"
  local archive reader_archive
  archive=$("$here/dump.sh" "$archives/admin" 2>&3)
  step "stack A: dump as backup_reader (role check enforced)"
  reader_archive=$(PGUSER=backup_reader PGPASSWORD=$reader_password BACKUP_FORCE_ROLE_CHECK=1 \
    "$here/dump.sh" "$archives/reader" 2>&3)

  extract_manifest "$archive" "$archives/admin-x"
  extract_manifest "$reader_archive" "$archives/reader-x"
  node_cli node "$here/compare.mjs" --strict-sequences \
    "$archives/admin-x/manifest.json" "$archives/reader-x/manifest.json" >/dev/null
  check_migration_metadata "$archives/admin-x/manifest.json"
  info "the admin and backup_reader manifests are identical"

  step "stack A: migration history matches the manifest by name and statements"
  local admin_manifest="$archives/admin-x/manifest.json"
  local repair_versions pending removed version_report
  node_cli node "$here/manifest.mjs" migrations-check "$admin_manifest" >/dev/null
  mutate_manifest "$admin_manifest" "$work_dir/mutated-hashes.json" hash ||
    fail MIGRATIONS_METADATA "the manifest holds no migration entries"
  expect_fail "migration statements changed" "has different statements" \
    node "$here/manifest.mjs" migrations-check "$work_dir/mutated-hashes.json"
  mutate_manifest "$admin_manifest" "$work_dir/mutated-name.json" rename
  expect_fail "migration name changed" "is not in this database" \
    node "$here/manifest.mjs" migrations-check "$work_dir/mutated-name.json"
  mutate_manifest "$admin_manifest" "$work_dir/other-versions.json" versions
  version_report=$(node_cli node "$here/manifest.mjs" migrations-check "$work_dir/other-versions.json")
  case "$version_report" in
    *"different version id than the backup (informational)"*) ;;
    *) fail MIGRATIONS_METADATA "different version ids were not reported as informational" ;;
  esac
  repair_versions=$(node_cli node "$here/manifest.mjs" migrations-check "$work_dir/other-versions.json" --repair-versions)
  node -e '
    const fs = require("node:fs");
    const versions = fs.readdirSync(process.argv[1])
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0])
      .sort();
    process.exit(process.argv[2] === versions.join(" ") ? 0 : 1);
  ' "$repo_root/supabase/migrations" "$repair_versions" ||
    fail MIGRATIONS_METADATA "the repair versions are not the repository migration versions"
  info "the same migrations under other version ids match; repair uses the repository versions"
  pending=$(node_cli node "$here/manifest.mjs" migrations-pending "$admin_manifest")
  [ -z "$pending" ] || fail MIGRATIONS_METADATA "a backup of the current schema reports pending migrations"
  removed=$(mutate_manifest "$admin_manifest" "$work_dir/missing-last.json" drop-last)
  pending=$(node_cli node "$here/manifest.mjs" migrations-pending "$work_dir/missing-last.json")
  case "$pending" in
    *_"$removed".sql) ;;
    *) fail MIGRATIONS_METADATA "the migration missing from the manifest was not reported as pending" ;;
  esac

  step "stack A: backup_reader is refused outside its grant"
  expect_reader_count "app tables" "select count(*) from app.stock_items"
  expect_reader_count "migration versions, names and statements" \
    "select least(count(version), count(name), count(statements)) from supabase_migrations.schema_migrations"
  expect_reader_zero "migration columns beyond version, name and statements" \
    "select count(*) from pg_catalog.pg_attribute a where a.attrelid = 'supabase_migrations.schema_migrations'::regclass and a.attnum > 0 and not a.attisdropped and a.attname not in ('version', 'name', 'statements') and has_column_privilege(a.attrelid, a.attnum, 'select')"
  expect_denied "auth.users" 42501 "select 1 from auth.users limit 1"
  reader_psql -c "select count(id) from storage.buckets" >/dev/null ||
    fail DENIAL_CONTROL "storage.buckets(id): backup_reader could not read it"
  info "allowed ok: storage.buckets(id)"
  expect_denied "storage.buckets other columns" 42501 "select name from storage.buckets limit 1"
  expect_denied "storage.buckets all columns" 42501 "select * from storage.buckets limit 1"
  expect_denied "storage.buckets insert" 42501 \
    "begin read write; insert into storage.buckets (id, name) values ('ci-reader-bucket', 'ci-reader-bucket'); rollback"
  expect_denied "storage.buckets delete" 42501 \
    "begin read write; delete from storage.buckets where false; rollback"
  expect_denied "storage.objects" 42501 "select 1 from storage.objects limit 1"
  expect_denied "vault.secrets" '42501|3F000' "select 1 from vault.secrets limit 1"
  # pg_cron and pg_net are absent here (the drift guard fails if either is
  # installed), so a missing table also proves the reader cannot read it.
  expect_denied "cron.job" '42501|3F000|42P01' "select 1 from cron.job limit 1"
  expect_denied "net.http_request_queue" '42501|3F000|42P01' "select 1 from net.http_request_queue limit 1"
  expect_denied "pg_authid" 42501 "select rolpassword from pg_catalog.pg_authid limit 1"
  expect_denied "write under the read-only default" 25006 \
    "update app.stock_items set name = name where false"
  expect_denied "update without privilege" 42501 \
    "begin read write; update app.stock_items set name = name where false; rollback"
  expect_denied "insert without privilege" 42501 \
    "begin read write; insert into app.stock_items (id) values (gen_random_uuid()); rollback"
  expect_denied "delete without privilege" 42501 \
    "begin read write; delete from app.stock_items where false; rollback"
  expect_denied "create table in app" 42501 \
    "begin read write; create table app.rogue_reader_write (id int); rollback"
  expect_denied "create role" 42501 "begin read write; create role rogue_reader_role; rollback"
  expect_denied "call an app RPC" 42501 \
    "begin read write; select app.add_expense_entry(p_category_id => gen_random_uuid(), p_request_id => gen_random_uuid()); rollback"

  step "stack A: the role check rejects column, sequence and storage grants"
  expect_unsafe_grant "an UPDATE column grant" "tables or columns: stock_items" \
    "grant update (name) on app.stock_items to backup_reader" \
    "revoke update (name) on app.stock_items from backup_reader" \
    "begin read write; update app.stock_items set name = name where false; rollback"
  expect_unsafe_grant "an INSERT column grant" "tables or columns: stock_items" \
    "grant insert (name) on app.stock_items to backup_reader" \
    "revoke insert (name) on app.stock_items from backup_reader"
  expect_unsafe_grant "a REFERENCES column grant" "tables or columns: stock_items" \
    "grant references (id) on app.stock_items to backup_reader" \
    "revoke references (id) on app.stock_items from backup_reader"
  expect_unsafe_grant "a table DELETE grant" "tables or columns: stock_items" \
    "grant delete on app.stock_items to backup_reader" \
    "revoke delete on app.stock_items from backup_reader"
  expect_unsafe_grant "sequence USAGE" "sequences: app.stock_movements_id_seq" \
    "grant usage on sequence app.stock_movements_id_seq to backup_reader" \
    "revoke usage on sequence app.stock_movements_id_seq from backup_reader"
  expect_unsafe_grant "sequence UPDATE" "sequences: app.stock_movements_id_seq" \
    "grant update on sequence app.stock_movements_id_seq to backup_reader" \
    "revoke update on sequence app.stock_movements_id_seq from backup_reader"
  expect_unsafe_grant "another storage.buckets column" "beyond buckets(id): buckets.name" \
    "grant select (name) on storage.buckets to backup_reader" \
    "revoke select (name) on storage.buckets from backup_reader"
  expect_unsafe_grant "storage.objects" "beyond buckets(id): objects" \
    "grant select on storage.objects to backup_reader" \
    "revoke select on storage.objects from backup_reader"
  expect_reader_zero "write privileges left on app tables or sequences" \
    "select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in ('app', 'ledger_scratch') and ((c.relkind in ('r', 'p') and has_any_column_privilege(c.oid, 'insert,update,references')) or (c.relkind = 'S' and (has_sequence_privilege(c.oid, 'usage') or has_sequence_privilege(c.oid, 'update'))))"

  step "stack A: dump as backup_reader while a writer inserts expenses"
  start_writer
  local i rows_before rows_after
  for i in $(seq 1 30); do
    if ! kill -0 "$writer_pid" 2>/dev/null; then
      node "$backup_dir/sanitize.mjs" "$writer_log" 2>&3 || true
      fail WRITER_FAILED "the concurrent writer stopped (is app.add_expense_entry accepted?)"
    fi
    rows_before=$(writer_rows)
    if [ "$rows_before" -ge 3 ]; then break; fi
    sleep 1
  done
  [ "$rows_before" -ge 3 ] || fail WRITER_FAILED "the concurrent writer inserted fewer than 3 rows in 30 s"
  local concurrent_archive
  concurrent_archive=$(PGUSER=backup_reader PGPASSWORD=$reader_password BACKUP_FORCE_ROLE_CHECK=1 \
    "$here/dump.sh" "$archives/concurrent" 2>&3)
  rows_after=$(writer_rows)
  if ! kill -0 "$writer_pid" 2>/dev/null; then
    node "$backup_dir/sanitize.mjs" "$writer_log" 2>&3 || true
    fail WRITER_FAILED "the concurrent writer stopped during the dump"
  fi
  stop_writer
  [ "$rows_after" -gt "$rows_before" ] ||
    fail WRITER_IDLE "the writer inserted nothing while the dump ran ($rows_before -> $rows_after)"
  info "the writer inserted $((rows_after - rows_before)) rows while the dump ran"
  extract_manifest "$concurrent_archive" "$archives/concurrent-x"
  node_cli node "$here/manifest.mjs" build "$work_dir/live-manifest.json" --skip-drift >/dev/null
  expect_fail "the live database moved on after the snapshot" "DIFF data app.expense_entries" \
    node "$here/compare.mjs" --strict-sequences "$archives/concurrent-x/manifest.json" "$work_dir/live-manifest.json"

  step "stack A: negative cases for the dump"
  expect_fail "loopback refused" "[LOOPBACK_REFUSED]" \
    env BACKUP_ALLOW_LOOPBACK=0 "$here/dump.sh" "$neg_dir/out"
  sed 's/^major_version[ ]*=.*/major_version = 16/' "$repo_root/supabase/config.toml" \
    >"$work_dir/config-wrong-major.toml"
  grep -q '^major_version = 16$' "$work_dir/config-wrong-major.toml" ||
    fail ROUNDTRIP_SETUP "could not build the wrong-major config"
  expect_fail "wrong server major" "[MAJOR_MISMATCH]" \
    env BACKUP_CONFIG_TOML="$work_dir/config-wrong-major.toml" "$here/dump.sh" "$neg_dir/out"
  sql 'create schema rogue_scope_test'
  expect_fail "rogue schema" "[DRIFT]" "$here/dump.sh" "$neg_dir/out"
  sql 'drop schema rogue_scope_test'
  sql 'create table public.rogue_scope_test (id int)'
  expect_fail "rogue public table" "[DRIFT]" "$here/dump.sh" "$neg_dir/out"
  sql 'drop table public.rogue_scope_test'
  sql "insert into storage.buckets (id, name) values ('ci-rogue-bucket', 'ci-rogue-bucket')"
  expect_fail "storage bucket present (admin role)" "storage holds 1 bucket" "$here/dump.sh" "$neg_dir/out"
  expect_fail "storage bucket present (backup_reader)" "storage holds 1 bucket" \
    env PGUSER=backup_reader PGPASSWORD="$reader_password" BACKUP_FORCE_ROLE_CHECK=1 \
    "$here/dump.sh" "$neg_dir/out"
  sql "set storage.allow_delete_query = 'true'; delete from storage.buckets where id = 'ci-rogue-bucket'"
  local buckets
  buckets=$(psql -X -q -A -t -v ON_ERROR_STOP=1 -c 'select count(*) from storage.buckets')
  [ "$buckets" = 0 ] || fail NEGATIVE_LEFT_DATA "the test bucket could not be removed from storage.buckets"
  sql "revoke select (id) on storage.buckets from backup_reader"
  expect_fail "storage bucket count unavailable to backup_reader" "storage bucket count is unavailable" \
    env PGUSER=backup_reader PGPASSWORD="$reader_password" BACKUP_FORCE_ROLE_CHECK=1 \
    "$here/dump.sh" "$neg_dir/out"
  sql "grant select (id) on storage.buckets to backup_reader"

  step "stack B: empty project"
  make_empty_project "$work_dir/stack-b"
  stack_start "$work_dir/stack-b"
  assert_target_empty

  step "stack B: negative cases for the archive"
  local size
  size=$(wc -c <"$archive")
  head -c "$((size / 2))" "$archive" >"$neg_dir/truncated.tar.gz"
  expect_fail "truncated archive" "[ARCHIVE_CORRUPT]" \
    "$here/restore.sh" "$neg_dir/truncated.tar.gz" preserve
  assert_target_empty

  mkdir -p "$neg_dir/tamper"
  tar -xzf "$archive" -C "$neg_dir/tamper" --no-same-owner
  {
    printf '%064d  db.dump\n' 0
    grep ' manifest.json$' "$neg_dir/tamper/SHA256SUMS"
  } >"$neg_dir/tamper/SHA256SUMS.new"
  mv "$neg_dir/tamper/SHA256SUMS.new" "$neg_dir/tamper/SHA256SUMS"
  tar -C "$neg_dir/tamper" -czf "$neg_dir/tampered.tar.gz" db.dump manifest.json SHA256SUMS
  expect_fail "wrong checksum inside the archive" "[CHECKSUM_MISMATCH]" \
    "$here/restore.sh" "$neg_dir/tampered.tar.gz" preserve
  assert_target_empty

  expect_fail "wrong archive hash" "[ARCHIVE_SHA_MISMATCH]" \
    env BACKUP_ARCHIVE_SHA256="$(printf '%064d' 0)" "$here/restore.sh" "$archive" preserve
  assert_target_empty

  expect_fail "wrong major on restore" "[MAJOR_MISMATCH]" \
    env BACKUP_CONFIG_TOML="$work_dir/config-wrong-major.toml" "$here/restore.sh" "$archive" preserve
  assert_target_empty

  expect_fail "owner missing in the target (preserve)" "[OWNER_MISSING]" \
    "$here/restore.sh" "$archive" preserve
  assert_target_empty

  step "stack B: restore with the owner remapped to a new user"
  create_user "$new_owner" "restore-owner@theshark.test"
  restore_archive "$archive" remap "$new_owner"

  step "stack B: negative cases on the restored database"
  expect_fail "restore into a non-empty target" "[TARGET_NOT_EMPTY]" \
    "$here/restore.sh" "$archive" remap "$new_owner"
  sql "update app.stock_items set name = name || '-changed' where id = 'b4c00000-0000-4000-8000-000000000001'"
  sql "do \$\$ declare f regprocedure; begin
         select p.oid::regprocedure into f from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'record_opening_stock' limit 1;
         execute 'drop function ' || f;
       end \$\$"
  node_cli node "$here/manifest.mjs" build "$work_dir/mutated-manifest.json" --skip-drift >/dev/null
  expect_fail "modified row" "DIFF data app.stock_items" \
    node "$here/compare.mjs" --strict-sequences "$archives/admin-x/manifest.json" "$work_dir/mutated-manifest.json"
  expect_fail "dropped function" "record_opening_stock" \
    node "$here/compare.mjs" --strict-sequences "$archives/admin-x/manifest.json" "$work_dir/mutated-manifest.json"

  step "stack B: restore again with the owner preserved"
  sql 'drop schema app, ledger_scratch cascade'
  assert_target_empty
  create_user "$old_owner" "seed-owner-original@theshark.test"
  restore_archive "$archive" preserve

  step "stack B: restore the backup_reader archive taken during writes"
  sql 'drop schema app, ledger_scratch cascade'
  assert_target_empty
  restore_archive "$concurrent_archive" preserve
  node_cli node "$here/manifest.mjs" build "$work_dir/restored-concurrent.json" --skip-drift >/dev/null
  node_cli node "$here/compare.mjs" --strict-sequences \
    "$archives/concurrent-x/manifest.json" "$work_dir/restored-concurrent.json" >/dev/null
  info "the restored manifest equals the manifest of the dump taken during writes"

  info "round trip ok"
}

case "$mode" in
  full) run_full ;;
  restore-archive) run_restore_archive "$2" ;;
esac
