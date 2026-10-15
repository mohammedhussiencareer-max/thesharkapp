# The Shark inventory and profit app

Follow [AI-WORKFLOW.md](AI-WORKFLOW.md) for every task. The approved design is [docs/DESIGN.md](docs/DESIGN.md); the POS data facts are in [docs/DB-ANALYSIS.md](docs/DB-ANALYSIS.md). Current state and next steps: [HANDOFF.md](HANDOFF.md).

## Hard rules

- The POS Firestore project `thesharkrestaurant` is production and strictly read-only for this system: never write documents, rules, indexes or settings there. Sync uses a `roles/datastore.viewer` service account whose key lives only in server secrets.
- Copy only accounting fields from POS orders. Customer names, phones and addresses never enter our database, logs, fixtures, briefs or chat.
- No secrets in the repo. Seed and fixture data are synthetic.
- Stock movements are append-only; corrections are new movements. All stock/cost writes go through the single server-side posting path.
- Money is EGP, rounded to the piaster per posted movement; quantities keep full precision. Times are stored in UTC and shown in `Africa/Cairo`.
- This is a standalone project. Do not reuse code, data or decisions from any other project.
