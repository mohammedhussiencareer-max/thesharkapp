# AI team workflow

How work is done on The Shark inventory and profit app. `CLAUDE.md` points here. Templates in `<angle brackets>` below are filled per task.

## Roles

| Role | Who | Does |
|---|---|---|
| Owner | The Shark restaurant owner (the app's only user) | Decides business rules, approves sensitive changes, starts production releases |
| Orchestrator | Claude Code | Plans, writes briefs, runs every check, judges review findings, commits, pushes, opens PRs, merges |
| Implementer | Grok 4.7 in Cursor (`cursor-agent`) | Writes code from a brief, in a worktree, never commits |
| Reviewer | Codex `gpt-6.1-sol`, reasoning effort xhigh, read-only | Reviews diffs; never writes code |

- Implementer effort: `grok-4.7-xhigh` for complex or risky work (database, migrations, permissions/RLS, auth, concurrency, money, webhooks, scheduling); `grok-4.7-high` for everything else (UI, docs, small fixes).
- Fixes of about five lines that a reviewer pinpointed, test-only adjustments after a merge, and doc wording can be done by Claude directly; they still go through checks and review.
- Implementer and reviewer sandboxes may not reach Docker or the git index: Claude runs the database, end-to-end tests and all git writes.

## Per-task workflow

Every task is one issue, one git worktree under `C:\Users\UTD\Downloads\thesharkapp-worktrees`, one short-lived branch `task/<n>-<slug>`, one pull request. Nobody pushes to `main`.

1. **Brief.** Claude writes a self-contained brief: goal, current state, files to read first, exact acceptance criteria, what not to touch, the project's known pitfalls, and the rules below. Then dispatches the implementer in the task's worktree.
2. **Checks.** Claude runs the full suite on a fresh database: reset, lint, tests, type generation and drift check, app lint, typecheck, unit tests, format check, full end-to-end. Fix or send back anything red before review.
3. **Fresh review.** A brand-new Codex session reviews `git diff origin/main...HEAD` (prompt template below).
4. **Triage.** Claude checks every finding against the code:
   - fix the real ones;
   - reject only findings shown to be wrong or pointless, and write down why;
   - always fix permissions/RLS, privacy, locking/deadlocks/concurrency, and data loss;
   - for an edge case in code added during an earlier fix round, first ask whether that code is needed at all; removing it can beat patching it.
5. **Fix.** The implementer fixes (delta brief), then Claude reruns the full checks.
6. **Verify.** Resume the SAME Codex session (`codex exec resume <session-id>`) with what changed and the reasons for any rejection. Repeat 4–6 until it approves.
7. **Final approval.** A brand-new Codex session reviews the exact head commit. If it finds something, go back to step 4.
8. **Merge.** Only when that final approval and green CI are on the same commit. Squash-merge pinned to that SHA. If the PR has a migration, apply it to staging right after.

Review prompts quote only test results from the current head commit, never older numbers.

## Rules for every implementer brief

- Edit files only. Do not commit, push, or run git write commands.
- Do not run the database, Docker or end-to-end tests (Claude does).
- Run lint, typecheck, unit tests and format check yourself and report the results.
- Fix each finding at its root and add a test that would have failed before the fix.
- Keep scope minimal: no features or content nobody asked for.
- Report: files changed, what was done per item, gate results, anything you could not do.

## Needs the owner's explicit OK

- CI/workflow file changes, production deploys and releases.
- New accounts, secrets or credentials.
- Open business decisions and new product features or workflows.
- Irreversible or bulk deletes.
- Migrations follow expand/contract; an applied migration is never edited; a change goes in a new migration.

## Safety

- No secrets in commits, chat, briefs or logs. Seed data never goes to a hosted project.
- Never delete worktrees or branches without the owner.
- After every implementer run, check `git reflog main` to confirm it did not touch `main`.

## Running it

- Run independent tasks in parallel without asking (separate worktrees). Serialize anything that shares the local database.
- Migrations: only one open PR changes migrations at a time, or merge them in timestamp order.
- Keep a handoff file (`HANDOFF.md` in the repo root) current: rules, open PRs with head SHAs, what is running, what is next, what needs the owner.
- Pacing: stop at 90% of Claude's 5-hour usage window, update the handoff, schedule a resume after the reset, continue.
- If Codex is out of quota, wait for its reset (background timer) instead of skipping review.
- Report to the owner briefly: what merged, what is blocked, what needs them.

## Commands

Implementer (Cursor):

```bash
node ~/.claude/skills/cursor-delegate/scripts/relay.mjs --brief <brief.md> --cd <worktree> --model grok-4.7-xhigh --timeout 3h --out-dir <dir>
```

Run it from PowerShell on Windows; read `<dir>/result.json` → `finalMessage`.

Fresh review (`review.sh <worktree> <prompt-file> <log>`):

```bash
codex exec -m gpt-6.1-sol -c model_reasoning_effort=xhigh --sandbox read-only -C "$1" - < "$2" > "$3" 2>&1
```

The session id is in the log header (`session id: …`). Add `--skip-git-repo-check` outside a git repo.

Resume the same review (`review-resume.sh <worktree> <session-id> <prompt-file> <log>`):

```bash
cd "$1" && codex exec resume -c model_reasoning_effort=xhigh -c sandbox_mode='"read-only"' "$2" - < "$3" > "$4" 2>&1
```

Merge pinned to the reviewed commit:

```bash
gh api -X PUT repos/mohammedhussiencareer-max/thesharkapp/pulls/<n>/merge -f merge_method=squash -f sha=<full-sha>
```

## Review prompt template

```
Review this branch fresh: git diff origin/main...HEAD at head <sha> (PR #<n>, <task>: <one line>).
[Earlier reviews flagged: <findings> — verify each fix.]
Read <docs>. Check: <the risks specific to this change: permissions, privacy, concurrency, idempotency, error text, edge cases, tests that would really fail, scope>.
Current head results on a fresh DB: <exact numbers from this head>.
Do not modify files. Output findings ranked by severity with file:line, then a final line exactly
'VERDICT: APPROVE' or 'VERDICT: CHANGES REQUESTED'.
```

## Design and big decisions

For a design direction or a hard decision: ask the implementer (read-only) and a fresh Codex session independently, verify their claims yourself, merge the findings, then debate the disagreements in the resumed Codex session until you agree. Give the owner one recommendation with what was accepted, what was rejected, and why. New feature ideas go to the owner as decisions, not into the build.
