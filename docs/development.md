# Development

## Requirements

- Node ≥ 22.18 (runs TypeScript directly), pnpm 10
- PostgreSQL 16 server and client binaries (`pg_config`, `initdb`, `pg_ctl`, `psql`), or
  Docker for a Postgres container

## First run

```bash
pnpm install
scripts/dev-db.sh start                    # prints: export TEST_DATABASE_URL=...
export TEST_DATABASE_URL='...'
pnpm check                                 # lint + typecheck + all tests
```

With Docker instead of local binaries:

```bash
docker run -d --name gencut-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

## Tests

| Suite | Where | Needs |
| --- | --- | --- |
| Domain | `packages/core/test` | nothing |
| Schema and migrations | `packages/db/test` | `TEST_DATABASE_URL` (each file creates and drops its own database) |
| Repository lint | `scripts/lint.test.ts` | nothing |

Coming: Playwright end-to-end at 390 px and 1440 px (M1), recorded-response agent tests (M3).

## Workflow

Branch `m<milestone>/<topic>` → small commits → `pnpm check` green → pull request → CI green
→ merge. Update `docs/` in the same pull request when architecture changes.

## Secrets

Never commit real values. `.env.example` lists the variable names. Production values live
in Netlify, Supabase and GitHub secret stores. `pnpm lint` and CI gitleaks both scan.
