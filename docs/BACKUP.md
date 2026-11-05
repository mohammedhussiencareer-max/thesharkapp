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
- Inside `manifest.json`: server and client versions, the app commit, installed extensions, every applied migration's version, name and an md5 hash of its statements (whitespace ignored; the SQL itself is not stored), the owner's UUID, which columns hold the owner's id (foreign keys to `auth.users` plus an allowlist of audit columns), database size, exact row counts and content hashes per table, sequence values, and a fingerprint of every function (ACL, security definer, settings), view, column, constraint, index, trigger, policy, table ACL, RLS flag, extension and schema ACL.
- No customer names, phones or addresses exist in `app` (they are never copied from the POS), so none are in a backup.

## What is NOT in a backup

- `auth.users` and everything else in `auth`: the owner's login. After a disaster the owner signs in to the new project, which creates a user; the restore then uses `remap` to point the data at that user. Passwords and sessions are not restored.
- Dashboard settings: signups disabled, Data API exposed schemas (`app` must be exposed), network restrictions, SMTP, JWT settings, API keys.
- Storage objects, Edge Function code and secrets, cron jobs. They cannot be silently missing: the drift guard fails the backup if `pg_cron` or `pg_net` is installed (the app uses neither; a future need must update this design first), and fails it if `storage.buckets` has any row. The guard counts the buckets as `backup_reader`, which can read the `id` column of `storage.buckets` and nothing else in `storage`. A count that cannot be read is a failure, never a pass (see "Storage buckets").
- `supabase_migrations` rows (only each version, name and an md5 of its normalised statements are saved, as metadata; the SQL text itself is not).
- Roles and passwords (only placeholder `NOLOGIN` roles are created so ACLs match).
- Anything outside `app` and `ledger_scratch`. The drift guard fails the backup when it finds an application-owned table, view, materialized view, sequence or function in any schema that is not dumped (`public`, `extensions` and every other schema), an application schema, or an unknown extension. Objects that belong to a recognised extension (`pg_depend` type `e`) or are owned by a platform role are ignored. Update `scripts/backup/config.mjs` and this page, then run again.

## Failure modes

The scripts print `backup: error [CODE]: ...` and never row data, connection strings or secrets. stderr is kept in a temp file that is removed on exit.

Server text is never printed by a production run, including `ci-roundtrip.sh restore-archive`, which loads a real archive. `psql` runs with `VERBOSITY=sqlstate`, so a failure shows a fixed message and the SQLSTATE code (for example `psql failed (exit 3, SQLSTATE 42501)`), and an unexpected internal error shows a fixed text. Only the synthetic `ci-roundtrip.sh full` against `127.0.0.1` prints sanitized server text (it needs `BACKUP_SYNTHETIC_DIAGNOSTICS=1`, `BACKUP_ALLOW_LOOPBACK=1` and `PGHOST=127.0.0.1` together). The sanitizer is only a second line of defense for that case: a value crafted to look like a complete message cannot be told apart from one.

| Code                                                | Meaning                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `LOOPBACK_REFUSED`                                  | The dump host is localhost. Only local tests set `BACKUP_ALLOW_LOOPBACK=1`.              |
| `SSLMODE_WEAK`                                      | A remote host needs `PGSSLMODE=verify-full` (or `verify-ca`).                            |
| `MAJOR_MISMATCH`, `CLIENT_MAJOR_MISMATCH`           | Server or `pg_dump`/`pg_restore`/`psql` major differs from `supabase/config.toml`.       |
| `ROLE_UNSAFE`                                       | The role is not login+bypassrls, is superuser, or can write (table, column, sequence) in `app`, or reach `storage` beyond `buckets(id)`. |
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

The scripts read libpq variables only: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE` (default `verify-full`) and optionally `PGSSLROOTCERT`. `PGSERVICE` is rejected. Other settings: `BACKUP_RUN_ID` (digits; defaults to `GITHUB_RUN_ID`), `BACKUP_APP_COMMIT`, `BACKUP_ARCHIVE_SHA256`, `BACKUP_STRICT_SEQUENCES=1`, `BACKUP_PG_BIN` (a directory with `psql`, `pg_dump` and `pg_restore`; added to `PATH` before the tools are checked), `BACKUP_KEEP_WORK=1`.

The three repo secrets the owner pastes into `thesharkapp-backups` (the workflow maps them to `PGHOST`, `PGUSER`, `PGPASSWORD`; port `5432` and database `postgres` are plain values):

| Secret              | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| `BACKUP_PGHOST`     | The session-pooler host from the dashboard (Connect, Session pooler)        |
| `BACKUP_PGUSER`     | `backup_reader.<project ref>` (the pooler needs the ref after the dot)      |
| `BACKUP_PGPASSWORD` | The password the owner sets for `backup_reader` (below)                     |

Never put these in a connection URI, a command line argument, a log, or a file in either repo.

## Create the backup role

Run `scripts/backup/provision-backup-reader.sql` once as `postgres` (dashboard SQL editor) on the hosted project. It creates `backup_reader` with `LOGIN BYPASSRLS`, no superuser, no write privilege, read-only default transactions, and `SELECT` on `app` and `ledger_scratch` (plus default privileges for future tables), plus read access to the `id` column of `storage.buckets`. It sets no password. It stops with an error if that storage grant does not take effect. It is safe to run again, and must be run again after a restore into a new project.

The owner then sets the password from their own machine, so it never appears in a chat, a file or the SQL editor history:

```
psql "host=<pooler host> port=5432 dbname=postgres user=postgres.<project ref> sslmode=verify-full"
\password backup_reader
```

`psql` asks twice for the password and sends it hashed. Use a long random one from a password manager, then paste the same value into the secret `BACKUP_PGPASSWORD`.

`backup_reader` has no access to the schemas `auth`, `vault`, `cron` or `net` (the dump's role check fails if it has `USAGE` on any of them). In `storage` it has `USAGE` on the schema and `SELECT (id)` on `storage.buckets`, and nothing else: no object rows and no bucket settings (the role check fails on any other table or column privilege in `storage`). On `supabase_migrations.schema_migrations` it can read only `version`, `name` and `statements`.

The role check also fails when the role holds any `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `TRIGGER` or `REFERENCES` privilege on a table, view or column of `app` or `ledger_scratch`, or `USAGE` or `UPDATE` on one of their sequences. A column grant such as `GRANT UPDATE (name) ON app.stock_items` would otherwise let the role write after `BEGIN READ WRITE`.

### Storage buckets

The app does not use Supabase Storage, and Storage objects are not in the backup. An upload needs a bucket, so a bucket is the signal. Every dump counts `storage.buckets` as `backup_reader` and fails with `DRIFT` when the count is not `0`, and also when the count cannot be read (for example after a restore into a new project, before `provision-backup-reader.sql` has been run again). If a bucket exists, stop: the objects in it are not backed up, and the design needs to change before anything is stored there. If the count is unavailable, run `provision-backup-reader.sql` again as `postgres`.

## Restore

1. Create a new empty Supabase project (or use the existing one after a reset) and apply no migrations to it. Turn signups off and expose schema `app` in the Data API.
2. Sign in once (or create the owner user in Authentication) so the target has an owner user. Copy its UUID.
3. Set `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE=verify-full` (and `PGSSLROOTCERT` for the pooler CA) for the target, plus `BACKUP_RESTORE_CONFIRM=RESTORE-INTO-EMPTY-PROJECT`.
4. `scripts/backup/restore.sh <archive.tar.gz> remap <owner uuid>` (or `preserve` when the old owner's UUID already exists in the target).
5. The script verifies the archive, checks the server major, checks `app` and `ledger_scratch` are absent, pre-creates extensions and placeholder roles, restores pre-data, data and sequences, replaces the old owner id (only values equal to it), then restores constraints, indexes, triggers and policies, rebuilds the manifest and compares, and finally checks that the owner passes `app.is_owner()` and anon is denied on `app.stock_items`.

Triggers and foreign keys arrive in the post-data step, after the owner remap, so the remap runs without triggers firing. This direct row load is the owner-approved exception to the posting-path rule in `CLAUDE.md` and is allowed only into an empty database.

### Repair the migration history

The restored project has the schema but an empty `supabase_migrations.schema_migrations`. Without a repair, the next `supabase db push` tries to run every migration again. `migration repair` only writes version numbers, so first prove that your checkout holds the same migration SQL as the backup. `manifest.json` is the one inside the archive.

Migrations are compared by name and statement hash, not by version id. Migrations deployed through the Supabase MCP `apply_migration` (see `HANDOFF.md`) get a timestamp from the server that differs from the repository file `<version>_<name>.sql`; the name is the file's suffix and is the same on both sides.

The statement hash is computed in Node (`scripts/backup/migration-hash.mjs`); the database only returns the raw statements, so there is one implementation. The history can hold the same migration as one chunk (MCP) or as one element per statement with the outer semicolon removed (CLI), so the SQL is normalised before it is hashed. Only this changes: whitespace and comments between tokens (one space where there was any) and the top-level `;` that ends a statement (empty statements are dropped). String literals (including `E'..'` escapes), quoted identifiers and dollar-quoted bodies are kept byte for byte, so `'a b'` and `'ab'`, or a changed space inside a function body, are different migrations. It assumes `standard_conforming_strings = on`, the default.

```
# Docker must be running
git checkout "$(node -p "require('./manifest.json').metadata.appCommit")"
git switch -c "restore-$(date +%Y%m%d)"
supabase start
supabase db reset
PGHOST=127.0.0.1 PGPORT=55422 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres PGSSLMODE=disable \
  node scripts/backup/manifest.mjs migrations-check manifest.json
```

This builds a local database from the backup's own commit and compares every migration's name and statements with the backup. It must print `migration history matches the backup`. Migrations whose version id differs from the backup's are listed as informational; that is expected for hosted history. If it names a migration as different, missing or extra, the checkout is not the code that produced the backup: do not run the repair; find the right commit first. Then link the project and mark each migration as applied under the repository's version, which `--repair-versions` prints after the same check (it maps each hosted version to the repository file with the same name):

```
supabase link --project-ref <ref>
supabase migration repair --status applied $(
  PGHOST=127.0.0.1 PGPORT=55422 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres PGSSLMODE=disable \
    node scripts/backup/manifest.mjs migrations-check manifest.json --repair-versions)
supabase migration list
```

The list must show local and remote in sync. Stay on this checkout: it is the application revision that matches the restored schema (next section).

### Which application revision to build

A restore brings back the backup's schema exactly. It does not move it to a newer migration level. The desktop app calls database functions whose signatures change with migrations: for example, the current client sends `p_expected_identity` to `app.set_item_opening_price`, which the older five-argument function does not accept. Building current `main` against an older restored schema therefore produces an app that fails on those calls.

- **Default: build the revision the backup came from.** After the repair above you are on the branch made from `appCommit` (the manifest's `metadata.appCommit`). Do the next section's edits and `pnpm desktop:build` there.
- **Moving to current `main` is a separate step**, and only after the intervening migrations are applied and verified:
  1. `git checkout main`, then list the migration files `main` has that the backup lacks, by name, in order:

     ```
     node scripts/backup/manifest.mjs migrations-pending manifest.json
     ```

     It fails if the backup holds a migration that `main` does not have.

  2. Apply each listed file, in that order, to the restored project the way migrations are normally deployed (`HANDOFF.md`: MCP `apply_migration`, named after the file's suffix).
  3. Verify: reset a local database from `main`, export its migrations, and check the restored project against them. The second command uses the restored project's connection variables:

     ```
     supabase db reset
     PGHOST=127.0.0.1 PGPORT=55422 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres PGSSLMODE=disable \
       node scripts/backup/manifest.mjs migrations-export main-migrations.json
     node scripts/backup/manifest.mjs migrations-check main-migrations.json
     ```

     It must print `migration history matches the backup`. Any difference means a migration was missed or applied differently: stop and do not build.

  4. Repeat the dashboard edits of the next section on `main` and build there.

## Free-plan pause

A free project pauses after a period without activity, and a paused project cannot be dumped. The daily backup connection should count as activity; this is one of the open checks below. If the project is paused: open the dashboard, press Restore project, wait until it is healthy, then run the backup workflow by hand. The dashboard only offers to un-pause for a limited time (read the notice on the paused project); after that the latest archive is the only copy and a restore into a new project is the way back, so never delete the retention set in the private repo by hand.

## Dashboard checklist after any restore

- Authentication: signups disabled; the owner user exists and signs in.
- Data API: schema `app` exposed; "Automatically expose new tables" off.
- Run `provision-backup-reader.sql` again and set the password with `\password`; update `BACKUP_PGHOST` if the project ref changed.
- Repair the migration history (above), after the migration check passes.
- Build the app at the revision that matches the restored schema (above): the backup's `appCommit` by default.
- If the project changed, rebuild and reinstall the desktop app (next section). Updating `.env.production` alone does nothing for the installed app.
- Run the app's own checks as the owner: stock levels, a purchase preview, the expense month.

### Point the desktop app at the restored project

The installed desktop app has the project URL and the public key compiled in at build time (`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `apps/web/.env.production`), and its content security policy only allows connections to the original project. A restored project with a new URL therefore needs a new build. Make it on the restore branch made from the backup's `appCommit` (or on `main`, once the intervening migrations are applied and verified; see "Which application revision to build"):

1. Edit `apps/web/.env.production`: the new project URL and its public (anon) key.
2. Edit `apps/desktop/src-tauri/tauri.conf.json`: in `app.security.csp`, replace the project URL in `connect-src` with the new one (`'self' https://<new project ref>.supabase.co`). Leave `devCsp` alone.
3. Build the installer: `pnpm desktop:build`, then run the new setup file on the owner's computer. It installs over the old app for the same user.
4. Verify the endpoint before trusting it: open the app, sign in as the owner, and check that a stock level matches the restored data. If the page stays empty or the sign-in fails with a network error, the CSP or the URL is still the old one. Do not enter new data until this works.

Commit the `.env.production` and `tauri.conf.json` changes on the restore branch. To keep them on `main`, carry the same two edits there only after `main`'s migrations have been applied to the restored project and verified; do not merge the restore branch into `main`.

## CI proof

The `backup-roundtrip` job (only when `supabase/**`, `scripts/backup/**` or the workflow change) installs PostgreSQL 17 client tools from PGDG, then `ci-roundtrip.sh full`:

1. Fresh local stack, migrations applied, synthetic data posted through the real RPCs (`scripts/backup/testdata/seed.sql`).
2. `backup_reader` provisioned; one dump as `postgres` and one as `backup_reader` with the role check enforced. The two manifests must be identical. The manifest's migrations (name, version, statement hash) must match the stack's `schema_migrations` and the repository files by name; the hash of each repository file taken as one chunk must equal the hash of the statements the CLI stored. A changed statement, a renamed or dropped migration must be reported; the same statements under other version ids must pass with the version difference listed as informational. `--repair-versions` must print exactly the repository's versions, and `migrations-pending` must list what a shorter history lacks.
3. `backup_reader` is tried against real tables: it reads `app`, the migration `version`/`name`/`statements` columns and `storage.buckets(id)`, and is refused (SQLSTATE `42501`, or `25006` under its read-only default) on `auth`, other `storage` tables and columns, `vault`, `cron`, `net`, other migration columns, `pg_authid`, and every write, DDL and RPC call.
   The role check is then proved against grants it must reject: column `UPDATE`, `INSERT` and `REFERENCES` on `app` tables, table `DELETE`, `USAGE` and `UPDATE` on an `app` sequence, column `SELECT` on `storage.buckets(name)` and `SELECT` on `storage.objects`. Each is granted, the reader dump must fail the role check naming it, and the grant is revoked.
4. A background loop inserts expenses through the real RPC while a `backup_reader` dump runs. The database must have moved on during the dump, the live manifest must differ from the archive's, and that archive is later restored and must match its own manifest exactly.
5. Second fresh stack with no migrations; restore with the owner remapped; the script compares and runs the functional checks; the second restore uses `preserve`; the last restore loads the archive taken during writes.
6. Negative cases that must fail with a named error: localhost refused, wrong server major, rogue schema, rogue `public` table, a row in `storage.buckets` (created as the admin role, and the dump as `backup_reader` must fail with the drift message; the bucket is then removed), `backup_reader` without `select (id)` on `storage.buckets` (the count is unavailable, so the dump fails), truncated archive, wrong checksum, wrong archive hash, owner missing, non-empty target, modified row, dropped function.

Stack A keeps `storage-api` so `storage.buckets` is real and the bucket checks run against the real table; the empty restore stack skips it. Dumps and logs stay in a temp directory and are never uploaded. The job has no secrets. The private workflow runs `ci-roundtrip.sh restore-archive <archive>` for its daily restore test.

The PostgreSQL 17 client is installed from PGDG without pinning an exact package version: an exact apt version disappears from PGDG and would break CI, the manifest already records the full client and server versions, and dump and restore require the same major.

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
- The synthetic seed inside the round trip. It ran clean once on the local database after the costing cutover (`add_custom_unit`, `set_item_conversion`, `set_item_loss`, the six-argument `set_item_opening_price`, the POS payload shape); the seed must follow any later change to those RPCs.
- The drift query's lists of platform-owned objects (`PLATFORM_OBJECT_OWNERS`, `PLATFORM_POSTGRES_OBJECTS` in `config.mjs`) against a live local and hosted stack; a false `DRIFT` names the object to add. The local stack must not install `pg_net` or `pg_cron`.
- `psql` with `VERBOSITY=sqlstate` prints `ERROR:  <code>` as the denial checks and the failure messages expect.
- Stack A runs `storage-api` (CI needs a real `storage.buckets`), and the background expense writer is accepted by `app.add_expense_entry`.
- The `postgres` role (local and hosted) can grant `usage` on schema `storage` and `select (id)` on `storage.buckets` to `backup_reader`. Provisioning fails loudly if the grant does not take effect.
- `USAGE` on schema `storage` lets `backup_reader` call storage functions that `PUBLIC` may execute. The role check does not inspect function execution; a `SECURITY DEFINER` function there could write. The app uses no storage, so this is a residual risk to review on the hosted project.
- The migration name the hosted history stores equals the repository file's suffix (`<version>_<name>.sql`), for both the MCP `apply_migration` and the CLI.
- The normalised statement hash (SQL-aware, in `migration-hash.mjs`) makes one chunk stored by MCP and the same SQL split by the CLI compare equal. CI proves it for the CLI against the repository files; confirm it against the real hosted `schema_migrations` rows.
- Three green daily runs, then one full restore into a temporary second free project, then delete that project with the owner's approval.
