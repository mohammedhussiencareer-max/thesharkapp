# Handoff

Updated: 2026-10-21.

## Rules

See [CLAUDE.md](CLAUDE.md) and [AI-WORKFLOW.md](AI-WORKFLOW.md). Design approved by Codex Sol (session `01a14189-4c9a-72d1-94c4-9bad82785382`) after 5 rounds; owner gave the go on 2026-10-16. Owner decisions since: desktop (Tauri) first, browser/phone last; data in online Supabase (free plan).

## Hosted Supabase

- Project `theshark`, ref `pltkoohfodvvmymlsycz`, region `eu-central-1`, free plan. URL and publishable key are in `apps/web/.env.production` (public values).
- Migrations reach the hosted project through the Supabase MCP `apply_migration`, named after the file's suffix, only after the PR is merged. Applied: `baseline`, `owner_access`, `stock_ledger_core`, `owner_item_catalog`, `pos_sales` (2026-10-16) `pos_refunds_drawer`, `purchases_opening` and `expenses` (2026-10-21; hosted fingerprints match local, views included). `sorting` (2026-10-22). `counts` is applied after the task 19 PR merges. Advisors: `authenticated` may execute `is_owner`, `post_movements`, `post_sort`, `record_purchase`, `record_opening_stock`, the expense write RPCs, `record_sort`, `record_count` and the POS sync RPCs (intended: each checks the owner or service_role itself); `pos_sync_run_orders` has RLS with no policy (internal, no grants); leaked-password protection needs a paid plan.
- Dashboard settings done by the owner: signups disabled, schema `app` exposed in the Data API. Recommended but optional: turn off "Automatically expose new tables".
- Owner account linked in `app.owner`. Verified from outside: signup returns `signup_disabled`; anon gets `permission denied for schema app`.

## POS access

- Read-only service account `theshark-pos-reader@thesharkrestaurant.iam.gserviceaccount.com` has `roles/datastore.viewer` only (granted by the POS project owner, verified 2026-10-16). No key exists for it yet; a key for a server-side sync needs the owner's OK.
- The POS Firestore (`thesharkrestaurant`) is production: read-only, accounting fields only, never any customer data.

## POS sync (local runner)

- `pnpm pos:sync -- --mode recent|window35|full` (default `recent` = the last 4 shifts). Reads the POS with GET list/get and POST `:runQuery` only, writes only to the LOCAL Supabase (non-loopback targets are refused).
- Token: `POS_ACCESS_TOKEN`, else `gcloud auth print-access-token` under gcloud config `theshark` (on Windows through ComSpec with fixed arguments).
- One sync at a time (55P03 `another POS sync is running`; runs older than 30 minutes are failed as abandoned first). Orders missing from a complete scoped read are marked `missing_from_pos`, never deleted.
- Real run 2026-10-16: 4 shifts / 216 orders inserted; rerun 216 unchanged, 0 missing.

## Open PRs

- Task 19 (issue #23, daily stock count) is in review. Implementer: grok CLI (grok-4.7) until its weekly quota ends, then Grok via Cursor.

Merged: PR #8 (task 6, stock ledger core) → eb11b95; PR #12 (task 11, owner item catalog screen) → bae0ebe; PR #14 (task 13, POS sales sync) → c052d70; PR #17 (task 15, shift sales with refunds and drawer reconciliation) → e7d6068; PR #18 (task 16, purchases and opening stock with idempotent saves) → 3e40613; PR #20 (task 17, expenses with exact daily allocation) → 3b44997; PR #22 (task 18, fish sorting screen) → 4617b29; PR #25 (expense writes pin only on an unknown outcome) → b33f27b. Implementer: Grok 4.7 via Cursor; the Argon trial is over (paused, low weekly quota).

## Repository

- Public since 2026-10-16 (free unlimited CI minutes); the owner wants it private again when the project is finished. While public: no real recipes, POS data, customer data or secrets in the repo.

## Next

- Back-dated movements: recompute instead of refusing.
- Recipes (import + add/edit screen) and POS→recipe mapping; deduction engine (cancel/refund cost decisions, waste); daily profit report; weekly count; server-side sync (Edge Function); PWA; daily backup with a restore test.

## Needs the owner

- OK for a service-account key before the server-side sync (Edge Function) task.
