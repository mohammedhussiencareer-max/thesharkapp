#!/usr/bin/env bash
# Takes one verified backup of schema app (data) and ledger_scratch (structure).
#   dump.sh <output-directory>
# Connection: libpq variables only (PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE,
# PGSSLMODE defaults to verify-full, PGSSLROOTCERT for a private CA).
# Optional: BACKUP_RUN_ID, BACKUP_APP_COMMIT, BACKUP_ALLOW_LOOPBACK=1 (local tests only).
# Prints the archive path on stdout. Never prints row data or secrets.
set -euo pipefail
set +x

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$here/lib.sh"
backup_init

# A failed run must not leave a partial or unverified archive in the output directory.
archive=""
dump_done=0
dump_cleanup() {
  if [ "$dump_done" != 1 ] && [ -n "$archive" ] && [ "${BACKUP_KEEP_WORK:-0}" != 1 ]; then
    rm -f "$archive" "$archive.sha256"
  fi
}
exit_hook=dump_cleanup

out_dir=${1:-}
[ -n "$out_dir" ] || fail USAGE "usage: dump.sh <output-directory>"

run_id=${BACKUP_RUN_ID:-${GITHUB_RUN_ID:-0}}
printf '%s' "$run_id" | grep -Eq '^[0-9]+(-[0-9]+)?$' ||
  fail USAGE "BACKUP_RUN_ID must be digits, optionally followed by -digits"

require_tools node tar gzip sha256sum
setup_pg_path
require_tools pg_dump pg_restore psql

step "checking the target"
enforce_role=$(guard dump-target)
export PGSSLMODE=${PGSSLMODE:-verify-full}
assert_majors pg_dump pg_restore psql
if [ "$enforce_role" = 1 ]; then
  step "checking the backup role is read-only"
  guard role-check
fi

tag="backup-$(date -u +%Y%m%dT%H%M%SZ)-$run_id"
package="$work_dir/package"
mkdir -p "$package" "$out_dir"
export BACKUP_PKG="$package"
export BACKUP_INNER="$here/dump-inner.sh"
export BACKUP_ERRORS_FILE="$work_dir/inner-errors.log"
export BACKUP_OK_FILE="$work_dir/inner.ok"
: >"$BACKUP_ERRORS_FILE"

step "taking the snapshot, manifest and dump"
rc=0
psql -X -q -v ON_ERROR_STOP=1 -f "$here/sql/snapshot-session.sql" >/dev/null || rc=$?
if [ "$rc" -ne 0 ] || [ ! -e "$BACKUP_OK_FILE" ]; then
  if [ -s "$BACKUP_ERRORS_FILE" ]; then
    cat "$BACKUP_ERRORS_FILE" >&3
    : >"$work_dir/reported"
    exit 1
  fi
  fail SNAPSHOT_FAILED "the snapshot session failed"
fi

step "packaging"
(cd "$package" && sha256sum db.dump manifest.json >SHA256SUMS)
archive="$out_dir/$tag.tar.gz"
tar -C "$package" -czf "$archive" db.dump manifest.json SHA256SUMS
(cd "$out_dir" && sha256sum "$tag.tar.gz" >"$tag.tar.gz.sha256")

step "verifying the new archive"
verify_dir="$work_dir/verify"
mkdir -p "$verify_dir"
verify_archive "$archive" "$verify_dir"
dump_done=1

info "wrote $tag.tar.gz"
printf '%s\n' "$archive"
