# Backup and restore

The database holds the only copy of the owner's stock ledger, costs and expenses, so it is backed up every day and the backup is proven by restoring it. This page explains how. Emergency steps in Egyptian Arabic are in [RESTORE-RUNBOOK.md](RESTORE-RUNBOOK.md).

## How it works

- The code is in `scripts/backup/` in this public repo. The schedule runs from a separate private repo `thesharkapp-backups` (cron 02:17 UTC) that checks out a reviewed, pinned commit of this repo and runs these scripts. The private repo's workflows are not part of this repo.
- The dump connects as `backup_reader`, a read-only role created outside the migrations. It is never the `postgres` role and never the service-role key.
- One snapshot is exported (`REPEATABLE READ READ ONLY`). The manifest and one `pg_dump -Fc` both read that snapshot, so they describe the same moment.
- The archive `backup-<UTC time>-<run id>.tar.gz` holds exactly `db.dump`, `manifest.json` and `SHA256SUMS`. A `.sha256` file sits next to it. The archive is checked right after it is written (hash, gzip, member list, checksums, `pg_restore --list`).
- A restore only ever goes into an empty project. After it, the manifest is rebuilt from the restored database and compared with the backup's manifest. Any difference fails the restore and names the object.

| Script                                                  | Job                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `dump.sh <dir>`                                         | Take, package and verify one backup                                                     |
| `verify-archive.sh <archive>`                           | Re-check an archive without a database                                                  |
| `restore.sh <archive> preserve`                         | Restore; the old owner must already exist in `auth.users`                               |
| `restore.sh <archive> remap <uuid>`                     | Restore; the old owner id is replaced by an existing user                               |
| `manifest.mjs build / drift`                            | Row counts, content hashes, sequence values, schema fingerprint; scope drift check      |
| `compare.mjs <expected> <actual>`                       | Names every differing object, exit 1 on any difference                                 |
| `retention.mjs --input <list.json> --dry-run`           | Plans deletions: 14 daily, 8 weekly, 24 monthly, never fewer than the 7 newest verified |
| `ci-roundtrip.sh full / restore-archive <archive>`      | The CI proof, and the restore step of the private workflow                              |
| `provision-backup-reader.sql`                           | Creates the read-only role (no password)                                                |

Retention keeps the newest 7 verified backups no matter what, deletes at most 5 per run, and deletes nothing when the current run failed. A backup that is not verified is never counted.

## What is in a backup

- Schema `app`: structure and all data. Schema `ledger_scratch`: structure only (it is scratch space).
- Inside `manifest.json`: server and client versions, the app commit, installed extensions, migration versions (names only, not their SQL), the owner's UUID, which columns hold the owner's id (foreign keys to `auth.users` plus an allowlist of audit columns), database size, exact row counts and content hashes per table, sequence values, and a fingerprint of every function (ACL, security definer, settings), view, column, constraint, index, trigger, policy, table ACL, RLS flag, extension and schema ACL.
- No customer names, phones or addresses exist in `app` (they are never copied from the POS), so none are in a backup.

## What is NOT in a backup

- `auth.users` and everything else in `auth`: the owner's login. After a disaster the owner signs in to the new project, which creates a user; the restore then uses `remap` to point the data at that user. Passwords and sessions are not restored.
- Dashboard settings: signups disabled, Data API exposed schemas (`app` must be exposed), network restrictions, SMTP, JWT settings, API keys.
- Storage objects, Edge Function code and secrets, cron jobs. The drift guard fails the backup if storage objects or cron jobs ever appear, so they cannot be silently missing.
- `supabase_migrations` rows (only the versions are saved, as metadata).
- Roles and passwords (only placeholder `NOLOGIN` roles are created so ACLs match).
- Anything outside `app` and `ledger_scratch`. The drift guard fails the backup when an application schema, a table or function in `public`, or an unknown extension appears: update `scripts/backup/config.mjs` and this page, then run again.

## Failure modes

The scripts print `backup: error [CODE]: ...` and never row data, connection strings or secrets. stderr is kept in a temp file that is removed on exit.

| Code                                                | Meaning                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `LOOPBACK_REFUSED`                                  | The dump host is localhost. Only local tests set `BACKUP_ALLOW_LOOPBACK=1`.              |
| `SSLMODE_WEAK`                                      | A remote host needs `PGSSLMODE=verify-full` (or `verify-ca`).                            |
| `MAJOR_MISMATCH`, `CLIENT_MAJOR_MISMATCH`           | Server or `pg_dump`/`pg_restore`/`psql` major differs from `supabase/config.toml`.       |
| `ROLE_UNSAFE`                                       | The role is not login+bypassrls, is superuser, or has a write privilege on `app`.        |
| `DRIFT`                                             | Something outside the scope exists. The message says what and where to update.           |
| `NO_OWNER`                                          | `app.owner` is empty; the backup would not be restorable.                                |
| `ARCHIVE_SHA_MISMATCH`, `ARCHIVE_CORRUPT`           | The archive changed or is incomplete.                                                    |
| `ARCHIVE_LAYOUT`, `CHECKSUM_MISMATCH`, `DUMP_UNREADABLE` | The archive content is wrong.                                                       |
| `TARGET_NOT_EMPTY`                                  | `app` or `ledger_scratch` already exists in the restore target.                          |
| `RESTORE_CONFIRM_REQUIRED`                          | A non-local restore needs `BACKUP_RESTORE_CONFIRM=RESTORE-INTO-EMPTY-PROJECT`.           |
| `OWNER_MISSING`, `REMAP_SUBSET`                     | The owner user is missing in the target, or the owner id is not the only value replaced. |
| `COMPARE_DIFF`                                      | The restored database differs from the manifest. `DIFF` lines name the objects.          |
| `FUNCTIONAL_FAILED`                                 | After the restore, the owner is not `app.is_owner()` or anon can read `app.stock_items`.  |

A restore that fails after its first step leaves a partial restore. Drop schemas `app` and `ledger_scratch` in the target and start again (the runbook has the command). The scripts never do this on their own because the target may be a real project.

## Connection settings

The scripts read libpq variables only: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE` (default `verify-full`) and optionally `PGSSLROOTCERT`. `PGSERVICE` is rejected. Other settings: `BACKUP_RUN_ID` (digits; defaults to `GITHUB_RUN_ID`), `BACKUP_APP_COMMIT`, `BACKUP_ARCHIVE_SHA256`, `BACKUP_STRICT_SEQUENCES=1`, `BACKUP_PG_BIN`, `BACKUP_KEEP_WORK=1`.

The three repo secrets the owner pastes into `thesharkapp-backups` (the workflow maps them to `PGHOST`, `PGUSER`, `PGPASSWORD`; port `5432` and database `postgres` are plain values):

| Secret              | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| `BACKUP_PGHOST`     | The session-pooler host from the dashboard (Connect, Session pooler)        |
| `BACKUP_PGUSER`     | `backup_reader.<project ref>` (the pooler needs the ref after the dot)      |
| `BACKUP_PGPASSWORD` | The password the owner sets for `backup_reader` (below)                     |

Never put these in a connection URI, a command line argument, a log, or a file in either repo.

## Create the backup role

Run `scripts/backup/provision-backup-reader.sql` once as `postgres` (dashboard SQL editor) on the hosted project. It creates `backup_reader` with `LOGIN BYPASSRLS`, no superuser, no write privilege, read-only default transactions, and `SELECT` on `app` and `ledger_scratch` (plus default privileges for future tables). It sets no password. It is safe to run again, and must be run again after a restore into a new project.

The owner then sets the password from their own machine, so it never appears in a chat, a file or the SQL editor history:

```
psql "host=<pooler host> port=5432 dbname=postgres user=postgres.<project ref> sslmode=verify-full"
\password backup_reader
```

`psql` asks twice for the password and sends it hashed. Use a long random one from a password manager, then paste the same value into the secret `BACKUP_PGPASSWORD`.

## Restore

1. Create a new empty Supabase project (or use the existing one after a reset) and apply no migrations to it. Turn signups off and expose schema `app` in the Data API.
2. Sign in once (or create the owner user in Authentication) so the target has an owner user. Copy its UUID.
3. Set `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE=verify-full` (and `PGSSLROOTCERT` for the pooler CA) for the target, plus `BACKUP_RESTORE_CONFIRM=RESTORE-INTO-EMPTY-PROJECT`.
4. `scripts/backup/restore.sh <archive.tar.gz> remap <owner uuid>` (or `preserve` when the old owner's UUID already exists in the target).
5. The script verifies the archive, checks the server major, checks `app` and `ledger_scratch` are absent, pre-creates extensions and placeholder roles, restores pre-data, data and sequences, replaces the old owner id (only values equal to it), then restores constraints, indexes, triggers and policies, rebuilds the manifest and compares, and finally checks that the owner passes `app.is_owner()` and anon is denied on `app.stock_items`.

Triggers and foreign keys arrive in the post-data step, after the owner remap, so the remap runs without triggers firing. This direct row load is the owner-approved exception to the posting-path rule in `CLAUDE.md` and is allowed only into an empty database.

### Repair the migration history

The restored project has the schema but an empty `supabase_migrations.schema_migrations`. Without a repair, the next `supabase db push` tries to run every migration again. Link the project and mark each saved version as applied:

```
supabase link --project-ref <ref>
supabase migration repair --status applied $(node -p "require('./manifest.json').metadata.migrations.join(' ')")
supabase migration list
```

`manifest.json` is the one inside the archive. The list must show local and remote in sync.

## Free-plan pause

A free project pauses after a period without activity, and a paused project cannot be dumped. The daily backup connection should count as activity; this is one of the open checks below. If the project is paused: open the dashboard, press Restore project, wait until it is healthy, then run the backup workflow by hand. The dashboard only offers to un-pause for a limited time (read the notice on the paused project); after that the latest archive is the only copy and a restore into a new project is the way back, so never delete the retention set in the private repo by hand.

## Dashboard checklist after any restore

- Authentication: signups disabled; the owner user exists and signs in.
- Data API: schema `app` exposed; "Automatically expose new tables" off.
- Run `provision-backup-reader.sql` again and set the password with `\password`; update `BACKUP_PGHOST` if the project ref changed.
- Update `apps/web/.env.production` (URL and publishable key) if the project changed.
- Repair the migration history (above).
- Run the app's own checks as the owner: stock levels, a purchase preview, the expense month.

## CI proof

The `backup-roundtrip` job (only when `supabase/**`, `scripts/backup/**` or the workflow change) installs PostgreSQL 17 client tools from PGDG, then `ci-roundtrip.sh full`:

1. Fresh local stack, migrations applied, synthetic data posted through the real RPCs (`scripts/backup/testdata/seed.sql`).
2. `backup_reader` provisioned; one dump as `postgres` and one as `backup_reader` with the role check enforced. The two manifests must be identical.
3. Second fresh stack with no migrations; restore with the owner remapped; the script compares and runs the functional checks; the second restore uses `preserve`.
4. Negative cases that must fail with a named error: localhost refused, wrong server major, rogue schema, rogue `public` table, truncated archive, wrong checksum, wrong archive hash, owner missing, non-empty target, modified row, dropped function.

Dumps and logs stay in a temp directory and are never uploaded. The job has no secrets. The private workflow runs `ci-roundtrip.sh restore-archive <archive>` for its daily restore test.

## Open checks (need a real run)

These could not be run in the sandbox where this was written; the first CI run or the owner's drill settles them:

- The daily dump counts as activity for the free-plan pause.
- The session pooler accepts the user `backup_reader.<ref>` and `verify-full` works against the pooler's CA (`PGSSLROOTCERT`).
- The hosted `postgres` role can create a `BYPASSRLS` role.
- `SELECT` on the `ledger_scratch` tables is what `pg_dump` needs to lock them.
- The exported snapshot flow (`psql` `\!` with `\setenv`) behaves the same on the GitHub runner.
- `supabase start --workdir` with only `config.toml` really gives an empty database.
- The platform extension and schema allowlists in `config.mjs` cover the hosted project (a false `DRIFT` on the first hosted run is expected to be fixed by adding an entry).
- ACLs and default privileges are identical between the hosted origin and a local target; whether policies and RLS flags land in pre-data or post-data in `pg_dump`.
- The synthetic seed's POS payload shape and the `set_item_opening_price` constraints.
- Three green daily runs, then one full restore into a temporary second free project, then delete that project with the owner's approval.
