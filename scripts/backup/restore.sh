#!/usr/bin/env bash
# Restores one backup archive into an EMPTY project (schemas app and ledger_scratch absent).
#   restore.sh <archive.tar.gz> preserve
#   restore.sh <archive.tar.gz> remap <new-owner-uuid>
# preserve: the old owner UUID must already exist in the target auth.users.
# remap:    the new owner must exist; only values equal to the old owner are replaced.
# Connection: libpq variables for the TARGET. A non-loopback host also needs
#   BACKUP_RESTORE_CONFIRM=RESTORE-INTO-EMPTY-PROJECT and PGSSLMODE=verify-full (default).
# Optional: BACKUP_ARCHIVE_SHA256, BACKUP_STRICT_SEQUENCES=1.
# On failure after the first restore step the target holds a partial restore: drop
# schemas app and ledger_scratch (see docs/RESTORE-RUNBOOK.md) before trying again.
set -euo pipefail
set +x

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$here/lib.sh"
backup_init

archive=${1:-}
mode=${2:-}
new_owner=${3:-}
usage="usage: restore.sh <archive.tar.gz> preserve | remap <new-owner-uuid>"
[ -n "$archive" ] || fail USAGE "$usage"
case "$mode" in
  preserve) [ -z "$new_owner" ] || fail USAGE "$usage" ;;
  remap) [ -n "$new_owner" ] || fail USAGE "$usage" ;;
  *) fail USAGE "$usage" ;;
esac

require_tools node pg_restore psql tar gzip sha256sum

step "checking the restore target"
guard restore-target >/dev/null
export PGSSLMODE=${PGSSLMODE:-verify-full}
setup_pg_path

step "verifying the archive"
package="$work_dir/package"
mkdir -p "$package"
verify_archive "$archive" "$package"

step "checking versions"
assert_majors pg_restore psql

step "checking the target is empty"
guard target-empty

step "checking the owner exists in the target"
node_cli node "$here/remap.mjs" --check-only "$package/manifest.json" "$mode" ${new_owner:+"$new_owner"} >/dev/null

step "preparing extensions and placeholder roles"
guard restore-prep "$package/manifest.json" >/dev/null

restore_section() {
  pg_restore --single-transaction --exit-on-error --no-owner \
    --section="$1" --dbname="$PGDATABASE" "$package/db.dump" ||
    fail "RESTORE_$2_FAILED" "pg_restore --section=$1 failed; the target holds a partial restore"
}

step "restoring the schema (pre-data)"
restore_section pre-data PRE_DATA

step "restoring the data and sequences"
restore_section data DATA

step "mapping the owner ($mode)"
node_cli node "$here/remap.mjs" "$package/manifest.json" "$mode" ${new_owner:+"$new_owner"} >/dev/null

step "restoring constraints, indexes, triggers and policies (post-data)"
restore_section post-data POST_DATA

step "comparing the restored database with the backup manifest"
node_cli node "$here/manifest.mjs" build "$work_dir/restored-manifest.json" --skip-drift >/dev/null
compare_args=()
if [ "${BACKUP_STRICT_SEQUENCES:-0}" = 1 ]; then compare_args+=(--strict-sequences); fi
node_cli node "$here/compare.mjs" "$package/manifest.json" "$work_dir/restored-manifest.json" ${compare_args[@]+"${compare_args[@]}"}

step "running functional checks"
owner_uuid=$(psql -X -q -A -t -v ON_ERROR_STOP=1 -c 'select user_id from app.owner') ||
  fail FUNCTIONAL_FAILED "cannot read the restored owner"
psql -X -q -v ON_ERROR_STOP=1 -v "owner=$owner_uuid" -f "$here/sql/functional-checks.sql" >/dev/null ||
  fail FUNCTIONAL_FAILED "the owner or anon access check failed"

info "restore complete: manifest matches, owner is app.is_owner(), anon is denied"
