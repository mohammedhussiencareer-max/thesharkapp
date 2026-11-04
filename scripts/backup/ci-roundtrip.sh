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
stack_exclude=studio,imgproxy,mailpit,edge-runtime,vector,logflare,realtime,storage-api
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

require_tools node psql tar gzip sha256sum awk sed
setup_pg_path
require_tools pg_dump pg_restore

unset PGSERVICE PGSERVICEFILE PGHOSTADDR PGSSLROOTCERT PGSSLCERT PGSSLKEY PGOPTIONS PGPASSFILE
PGHOST=127.0.0.1
PGPORT=$(guard db-port)
PGUSER=postgres
PGPASSWORD=postgres
PGDATABASE=postgres
PGSSLMODE=disable
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
export BACKUP_ALLOW_LOOPBACK=1
export BACKUP_PRINT_STDERR=1
export BACKUP_STRICT_SEQUENCES=1

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

# stack_start [workdir] : a fresh local stack; with a workdir it holds config.toml only (no migrations).
stack_start() {
  stack_stop
  stack_workdir=${1:-}
  local -a wd=()
  if [ -n "$stack_workdir" ]; then wd=(--workdir "$stack_workdir"); fi
  supa start --exclude "$stack_exclude" ${wd[@]+"${wd[@]}"} >/dev/null ||
    fail STACK_START "supabase start failed"
  wait_db
}

make_empty_project() {
  local dir=$1
  mkdir -p "$dir/supabase"
  awk '
    /^\[/ { in_seed = ($0 == "[db.seed]") }
    in_seed && /^enabled[ ]*=/ { print "enabled = false"; next }
    { print }
  ' "$repo_root/supabase/config.toml" >"$dir/supabase/config.toml"
}

rt_exit() {
  local rc=$?
  trap - EXIT
  if [ "${BACKUP_ROUNDTRIP_KEEP_STACK:-0}" != 1 ]; then stack_stop; fi
  (exit "$rc")
  on_exit
}
trap rt_exit EXIT

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

extract_manifest() {
  mkdir -p "$2"
  tar -xzf "$1" -C "$2" --no-same-owner manifest.json
}

check_migration_metadata() {
  node -e '
    const fs = require("node:fs");
    const recorded = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).metadata.migrations;
    const files = fs.readdirSync(process.argv[2])
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0])
      .sort();
    if (recorded.length === 0 || JSON.stringify(recorded) !== JSON.stringify(files)) {
      process.exit(1);
    }
  ' "$1" "$repo_root/supabase/migrations" ||
    fail MIGRATIONS_METADATA "migration versions in the manifest differ from supabase/migrations"
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
  stack_start ""
  supa --yes db reset >/dev/null || fail STACK_RESET "supabase db reset failed"
  wait_db

  step "stack A: seeding synthetic data through the real RPCs"
  create_user "$old_owner" "seed-owner@theshark.test"
  psql -X -q -1 -v ON_ERROR_STOP=1 -v "owner=$old_owner" -f "$here/testdata/seed.sql" >/dev/null ||
    fail SEED_FAILED "the synthetic seed failed"

  step "stack A: provisioning backup_reader"
  local reader_password
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

  info "round trip ok"
}

case "$mode" in
  full) run_full ;;
  restore-archive) run_restore_archive "$2" ;;
esac
