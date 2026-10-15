# The Shark — inventory and daily profit

Owner-only web app (phone and desktop) that reads sales from the restaurant's POS (read-only), deducts stock by recipe, and reports daily profit after purchases, counts and expenses.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- POS data analysis: [docs/DB-ANALYSIS.md](docs/DB-ANALYSIS.md)
- How we work: [AI-WORKFLOW.md](AI-WORKFLOW.md)

## Development

Node 22 and pnpm 10.34.6. Database commands need Docker.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm format
pnpm format:check
pnpm build
pnpm exec playwright install --with-deps chromium
pnpm e2e
pnpm db:start
pnpm db:stop
pnpm db:reset
pnpm db:test
pnpm db:types
pnpm db:types:check
```
