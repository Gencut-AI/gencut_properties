# Architecture decisions

Each entry: date, decision, why, and what would make us revisit it. Newest last.

## D-001 · 2026-10-10 · One TypeScript monorepo, shared domain package

**Decision:** pnpm workspace with `apps/web`, `apps/worker`, `packages/core`, `packages/db`.
All business rules live in `packages/core` and are called by the web app, the WhatsApp
webhook and the worker.
**Why:** the spec requires web and WhatsApp to share business logic; one package makes
that structural rather than a convention.
**Revisit if:** a second deployable needs a different language or release cadence.

## D-002 · 2026-10-10 · Next.js on Netlify, Supabase for Postgres/Auth/Storage

**Decision:** Next.js (App Router) PWA hosted on Netlify; Supabase for Postgres, email-link
auth and file storage.
**Why:** both accounts already exist and are connected; one deploy target serves UI, API
routes and webhooks.
**Revisit if:** Netlify Free-plan limits or function timeouts block the web tier.

## D-003 · 2026-10-10 · Separate worker for long jobs, pg-boss queue

**Decision:** agent runs, video renders and outreach execution run in a Node worker
container that pulls jobs from a Postgres-backed queue (pg-boss).
**Why:** renders and multi-step agent runs exceed serverless limits; a Postgres queue adds
no vendor. Host chosen at M4 with measured render times.
**Revisit if:** job volume or scheduling needs outgrow pg-boss.

## D-004 · 2026-10-10 · SQL-first migrations with a psql runner

**Decision:** schema changes are reviewed SQL files with up and down scripts, applied by
`packages/db/src/migrate.ts`, which shells out to `psql`. The application query layer
(Drizzle, planned) reads the same schema but does not own migrations.
**Why:** SQL is the most reviewable form for constraints and triggers (the outreach guard,
the append-only audit log). It also let M0 proceed while this session's network policy
blocked the npm registry.
**Revisit if:** keeping Drizzle's schema types in sync by hand becomes error-prone — then
generate types from the database (`drizzle-kit pull`).

## D-005 · 2026-10-10 · Models chosen by configuration only

**Decision:** agents request a role (reasoning, fast, creative); a ModelRouter maps roles to
provider + model in configuration. Model names are banned from `packages/core` by lint.
**Why:** the model/provider spec requires provider independence.

## D-006 · 2026-10-10 · Database guards mirror domain state machines

**Decision:** a trigger on `outreach_actions` enforces the same legal transitions as
`packages/core`, freezes content once approved and clears approval when an action returns
to draft. A test compares all 36 transition pairs.
**Why:** "nothing sends without approval" must hold even if a future code path bypasses
the service layer.

## D-007 · 2026-10-10 · SMS and WhatsApp-to-prospect unavailable in MVP

**Decision:** `MVP_AVAILABLE_CHANNELS` is email, mail and call tasks. Email sending is
behind `GENCUT_LIVE_EMAIL_SENDING`, off by default.
**Why:** SMS needs A2P 10DLC registration and prior express written consent
(Fla. Stat. 501.059(8)); WhatsApp needs opt-in and templates; counsel review comes first.

## D-008 · 2026-10-10 · Opportunity data starts with Florida DOR assessment rolls

**Decision:** first source adapter reads the Florida Department of Revenue NAL/SDF files;
paid sources (Miami-Dade Clerk, RentCast) are add-ons behind the same interface after
approval.
**Why:** statewide, public, documented, exempt records already removed.
