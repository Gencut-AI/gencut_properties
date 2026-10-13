# AGENTS.md — working in the GenCut repository

Instructions for AI coding agents and human contributors. Keep this file accurate;
update it in the same pull request as any change it describes.

## What this is

GenCut is an AI customer-acquisition workforce for real-estate agents and brokers,
starting in Miami / South Florida. The product loop is: business profile → opportunity
discovery → research → strategy → campaign → Film Crew media → approval → authorized
execution → follow-up → results. The **campaign** is the central object.

Plan and acceptance criteria: the "GenCut MVP Execution Plan" doc (claude.ai artifact).
Architecture decisions: `docs/decisions.md`.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Domain services shared by every interface: state machines, permissions, compliance gate, scoring, audit events. No I/O, no npm dependencies. |
| `packages/db` | Postgres schema as SQL migrations (`migrations/NNNN_name.{up,down}.sql`), the `psql`-based runner, schema tests. |
| `apps/web` | Next.js 16 PWA: pages, API routes (`/api/health`), later the WhatsApp webhook. Deployed to Netlify project `gencut` (`apps/web/netlify.toml`). |
| `apps/worker` | Background jobs. Now: discovery (FL DOR roll import + scoring, `.github/workflows/discovery.yml`). Later: agent runs, rendering, approved outreach execution. |
| `scripts/` | Repository lint and local tooling. |
| `docs/` | Architecture, product, agents, data model, decisions, development. |

## Commands

```bash
scripts/dev-db.sh start          # local Postgres; prints TEST_DATABASE_URL to export
export TEST_DATABASE_URL=...     # from the line above
pnpm lint                        # repo rules: secrets, no model names / console in core
pnpm typecheck                   # tsc --strict, no emit
pnpm test                        # node:test — core, db (needs TEST_DATABASE_URL), scripts
pnpm check                       # all three; must pass before every commit
pnpm dev / pnpm build            # run or build the web app
DATABASE_URL=... pnpm db:migrate # apply pending migrations
DATABASE_URL=... pnpm --filter @gencut/worker discover   # one discovery pass (needs DOR portal access)
```

The DOR portal (floridarevenue.com) is reachable from GitHub Actions but not from every
development environment. Pull requests that touch discovery code run `Discovery / dry-run`:
the real roll into a throwaway database, aggregates only. Test fixtures are synthetic; never
commit rows from a real roll.

TypeScript runs directly on Node ≥ 22.18 (type stripping). Therefore:
- import local files with the `.ts` extension;
- use only erasable syntax — no `enum`, no `namespace`, no constructor parameter properties
  (`erasableSyntaxOnly` enforces this). Use `as const` arrays and union types instead.

## Rules that are not negotiable

1. **Business logic lives in `packages/core`.** The web app, WhatsApp webhook and worker call
   the same functions. Never re-implement a rule in an interface.
2. **Nothing external happens without approval and the gate.** Outreach actions move
   DRAFT → READY → APPROVED → EXECUTING → COMPLETED/FAILED. Only a user approves; only the
   executor executes, and it calls `evaluateGate` immediately before sending and records the
   full decision in `audit_events`. The database trigger enforces the same transitions.
3. **Three separate permissions:** discover, generate, contact (per channel). Public data
   authorizes discovery only.
4. **Never fabricate.** No invented leads, facts, contact details, results or integration
   status. Every opportunity fact cites its source record.
5. **No protected characteristics** (or proxies) in scoring, targeting or copy.
6. **Models are chosen by configuration** via the ModelRouter; `pnpm lint` rejects model
   names in `packages/core`.
7. **Secrets** only in platform secret stores; `.env.example` holds names, never values.
8. **Agents never modify production code, prompts, permissions or policies.** Improvements
   go through the experiment registry and human approval.

## Changing the schema

Add a new numbered pair `NNNN_name.up.sql` / `NNNN_name.down.sql`; never edit an applied
migration. If you add a state, channel or scope, change `packages/core` and the CHECK
constraint together — `packages/db/test/schema.test.ts` fails if they drift.

## Git

- Branch per slice: `m<milestone>/<topic>`. `main` is protected; merge by pull request with
  green CI.
- Commit messages: imperative subject ≤ 72 chars, body says what and why.
- Never claim something works without the command output that shows it.

## Compliance references

`docs/compliance.md` lists the rules the gate implements and their primary sources.
They are engineering requirements, not legal advice; live sending stays off until counsel
reviews the consent and outreach design.
