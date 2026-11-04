# shellcheck shell=bash
# Shared helpers. Source after "set -euo pipefail". Never enables xtrace.
# All stderr goes to a work-dir file; only "backup: ..." lines reach the user
# channel (fd 3), so row data, connection strings and secrets are never printed.
set +x

backup_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$backup_dir/../.." && pwd)
work_dir=""
current_step="starting"
pinned_major=""

exec 3>&2

fail() {
  local code=$1
  shift
  printf 'backup: error [%s]: %s\n' "$code" "$*" >&3
  if [ -n "$work_dir" ]; then : >"$work_dir/reported"; fi
  exit 1
}

info() {
  printf 'backup: %s\n' "$*" >&3
}

step() {
  current_step=$1
  info "$1"
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    if [ -z "$work_dir" ] || [ ! -e "$work_dir/reported" ]; then
      printf 'backup: error [FAILED]: step "%s" failed\n' "$current_step" >&3
    fi
    if [ "${BACKUP_PRINT_STDERR:-0}" = 1 ] && [ -s "${BACKUP_STDERR_FILE:-/nonexistent}" ]; then
      node "$backup_dir/sanitize.mjs" "$BACKUP_STDERR_FILE" 2>&3 || true
    fi
  fi
  if [ -n "$work_dir" ] && [ "${BACKUP_KEEP_WORK:-0}" != 1 ]; then
    rm -rf "$work_dir"
  fi
  exit "$rc"
}

backup_init() {
  umask 077
  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/backup.XXXXXX")
  BACKUP_STDERR_FILE="$work_dir/stderr.log"
  : >"$BACKUP_STDERR_FILE"
  export BACKUP_STDERR_FILE
  trap on_exit EXIT
  exec 2>>"$BACKUP_STDERR_FILE"
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || fail TOOL_MISSING "$tool is not installed"
  done
}

# Runs a Node CLI. Its stderr goes to the log; only its own
# "backup: error [CODE]: ..." lines are shown to the user.
node_cli() {
  local err rc=0
  err=$(mktemp "$work_dir/cli.XXXXXX")
  "$@" 2>"$err" || rc=$?
  cat "$err" >>"$BACKUP_STDERR_FILE"
  if [ "$rc" -ne 0 ]; then
    if grep -E '^backup: error \[[A-Z_]+\]: ' "$err" >&3; then
      : >"$work_dir/reported"
    fi
  fi
  rm -f "$err"
  return "$rc"
}

guard() {
  node_cli node "$backup_dir/guard.mjs" "$@"
}

setup_pg_path() {
  pinned_major=$(guard pinned-major)
  local bin=${BACKUP_PG_BIN:-/usr/lib/postgresql/$pinned_major/bin}
  if [ -d "$bin" ]; then
    PATH="$bin:$PATH"
    export PATH
  fi
}

# assert_majors <client tool>... : server and every listed client must match the pin.
assert_majors() {
  local server_num tool
  local -a args=()
  server_num=$(guard server-version)
  for tool in "$@"; do
    args+=("$tool=$("$tool" --version)")
  done
  guard assert-major "$server_num" "${args[@]}"
}

# verify_archive <archive.tar.gz> <empty destination dir>
verify_archive() {
  local archive=$1 dest=$2 members expected_hash="" actual_hash
  [ -f "$archive" ] || fail ARCHIVE_MISSING "the archive file does not exist"

  if [ -n "${BACKUP_ARCHIVE_SHA256:-}" ]; then
    expected_hash=$BACKUP_ARCHIVE_SHA256
  elif [ -f "$archive.sha256" ]; then
    expected_hash=$(head -n 1 "$archive.sha256" | cut -d ' ' -f 1)
  fi
  if [ -n "$expected_hash" ]; then
    printf '%s' "$expected_hash" | grep -Eq '^[0-9a-f]{64}$' ||
      fail ARCHIVE_SHA_MISMATCH "the expected archive hash is malformed"
    actual_hash=$(sha256sum "$archive" | cut -d ' ' -f 1)
    [ "$actual_hash" = "$expected_hash" ] ||
      fail ARCHIVE_SHA_MISMATCH "the archive hash differs from the recorded hash"
  fi

  gzip -t "$archive" 2>>"$BACKUP_STDERR_FILE" ||
    fail ARCHIVE_CORRUPT "the archive is not a complete gzip file"
  members=$(tar -tzf "$archive" 2>>"$BACKUP_STDERR_FILE") ||
    fail ARCHIVE_CORRUPT "the archive cannot be listed"
  [ "$(printf '%s\n' "$members" | LC_ALL=C sort)" = $'SHA256SUMS\ndb.dump\nmanifest.json' ] ||
    fail ARCHIVE_LAYOUT "the archive must hold exactly db.dump, manifest.json and SHA256SUMS"

  tar -xzf "$archive" -C "$dest" --no-same-owner 2>>"$BACKUP_STDERR_FILE" ||
    fail ARCHIVE_CORRUPT "the archive cannot be extracted"
  [ "$(awk '{ print $2 }' "$dest/SHA256SUMS" | LC_ALL=C sort)" = $'db.dump\nmanifest.json' ] ||
    fail CHECKSUM_MISMATCH "SHA256SUMS does not list db.dump and manifest.json"
  (cd "$dest" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>>"$BACKUP_STDERR_FILE") ||
    fail CHECKSUM_MISMATCH "a file in the archive does not match SHA256SUMS"
  pg_restore --list "$dest/db.dump" >/dev/null 2>>"$BACKUP_STDERR_FILE" ||
    fail DUMP_UNREADABLE "pg_restore cannot read db.dump"
}
