#!/usr/bin/env bash
# Runs inside the exported snapshot started by dump.sh (via sql/snapshot-session.sql).
# Not meant to be run by hand. Errors go to $BACKUP_ERRORS_FILE for dump.sh to show.
set -euo pipefail
set +x

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
errors=${BACKUP_ERRORS_FILE:?}
package=${BACKUP_PKG:?}
snapshot=${BACKUP_SNAPSHOT:?}
ok_file=${BACKUP_OK_FILE:?}

inner_fail() {
  printf 'backup: error [%s]: %s\n' "$1" "$2" >>"$errors"
  exit 1
}

# The manifest is read first: sequences only move forward, so the values it
# records are never ahead of the dump taken in the same snapshot afterwards.
cli_log=$(mktemp "${errors}.XXXXXX")
if ! node "$here/manifest.mjs" build "$package/manifest.json" --snapshot "$snapshot" \
  >/dev/null 2>"$cli_log"; then
  grep -E -m 1 '^backup: error \[[A-Z_]+\]: ' "$cli_log" >>"$errors" || true
  cat "$cli_log" >&2
  rm -f "$cli_log"
  inner_fail MANIFEST_FAILED "the manifest could not be built"
fi
cat "$cli_log" >&2
rm -f "$cli_log"

pg_dump \
  --format=custom \
  --no-owner \
  --no-tablespaces \
  --no-publications \
  --no-subscriptions \
  --schema=app \
  --schema=ledger_scratch \
  --exclude-table-data='ledger_scratch.*' \
  --snapshot="$snapshot" \
  --lock-wait-timeout=60s \
  --file="$package/db.dump" ||
  inner_fail PG_DUMP_FAILED "pg_dump failed"

: >"$ok_file"
