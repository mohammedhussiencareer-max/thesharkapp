# Handoff

Updated: 2026-10-16.

## Rules

See [CLAUDE.md](CLAUDE.md) and [AI-WORKFLOW.md](AI-WORKFLOW.md). Design approved by Codex Sol (session `01a14189-4c9a-72d1-94c4-9bad82785382`) after 5 rounds; owner gave the go on 2026-10-16. Owner decisions since: desktop (Tauri) first, browser/phone last; data in online Supabase (free plan).

## Hosted Supabase

- Project `theshark`, ref `pltkoohfodvvmymlsycz`, region `eu-central-1`, free plan. URL and publishable key are in `apps/web/.env.production` (public values).
- Migrations reach the hosted project through the Supabase MCP `apply_migration`, named after the file's suffix, only after the PR is merged. Applied: `baseline`, `owner_access`, `stock_ledger_core` (2026-10-16; hosted schema fingerprint matches local for functions, columns, constraints, triggers, policies and grants). Advisors: `authenticated` may execute `is_owner`, `post_movements`, `post_sort` (intended: the posting functions check the owner themselves); leaked-password protection needs a paid plan.
- Dashboard settings done by the owner: signups disabled, schema `app` exposed in the Data API. Recommended but optional: turn off "Automatically expose new tables".
- Owner account linked in `app.owner`. Verified from outside: signup returns `signup_disabled`; anon gets `permission denied for schema app`.

## POS access

- Read-only service account `theshark-pos-reader@thesharkrestaurant.iam.gserviceaccount.com` exists with no roles. The POS GCP project owner (our owner's account is only Editor) must grant `roles/datastore.viewer`. Needed for the POS sync task.

## Open PRs

- Task 11 (issue #11, owner item catalog screen): implementing on `task/11-item-catalog` (Grok 4.7 via Cursor).

Merged: PR #8 (task 6, stock ledger core) → eb11b95. Implementer: Grok 4.7 via Cursor; the Argon trial is over (paused, low weekly quota).

## Next

- Task 11 item catalog, then purchases + opening stock, sorting, and count screens on the ledger.
- POS sync once the read-only role is granted.

## Needs the owner

- Ask the POS project owner to grant the read-only role above.
