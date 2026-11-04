#!/usr/bin/env bash
# Verifies an archive without touching any database: gzip, exact members,
# SHA256SUMS, the optional recorded archive hash (BACKUP_ARCHIVE_SHA256 or the
# adjacent .sha256 file) and that pg_restore can read the dump.
#   verify-archive.sh <archive.tar.gz>
set -euo pipefail
set +x

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/backup/lib.sh
. "$here/lib.sh"
backup_init

archive=${1:-}
[ -n "$archive" ] || fail USAGE "usage: verify-archive.sh <archive.tar.gz>"
require_tools node pg_restore tar gzip sha256sum
setup_pg_path

package="$work_dir/package"
mkdir -p "$package"
verify_archive "$archive" "$package"
info "archive verified"
