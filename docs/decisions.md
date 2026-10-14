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

## D-009 · 2026-10-13 · Discovery runs on GitHub Actions; one roll serves every workspace

**Decision:** the Florida DOR roll is imported by a scheduled GitHub Actions workflow
(`.github/workflows/discovery.yml`, every 10 minutes, idle when nothing is due) running
`apps/worker`. Parcels are stored once per county ZIP as shared public `source_records`
(residential parcels only, only the columns GenCut uses) and scored per workspace.
**Why:** GitHub's runners can reach the DOR portal; Netlify functions are too short-lived
for a 59 MB download and a 938,000-row parse, and the development workspaces cannot reach
the portal at all. Importing per requested ZIP keeps the free database tier small.
**Revisit if:** imports need to start within seconds of a profile save (trigger the
workflow from the app), or the D-003 worker host exists.

## D-010 · 2026-10-13 · Seller scoring v2: tenure from the assessment gap

**Decision:** `seller-v2` drops the purchase-date tenure signal and reads long ownership
from the ratio of non-school assessed value (`AV_NSD`) to market value (`JV`): Florida
caps annual assessment increases at 3% for homesteads and 10% for other residential
property, so a wide gap builds only over years. Absentee means a different tax-mail street
line **and** no homestead exemption. A sale on the roll in the last two years subtracts
points. Opportunities need 55 points (two signals beyond the focus match); a workspace
keeps its best 100, ties broken by the wider gap.
**Why:** the NAL roll's sale fields cover only the current and previous year, so v1's
tenure signal had no data. The school assessed value (`AV_SD`) is not capped for
non-homestead property and would hide the gap. The bar of 40 qualified 42% of 33180's
parcels in the dry run, which is not a useful filter.
**Revisit if:** recorded campaign outcomes (M6) show which signals predict listings.

## D-011 · 2026-10-14 · Scoring v3: tenure only from two rolls; institutions and large buildings out

**Decision:**
- Claim long ownership only when the assessment gap appears on two consecutive rolls. DOR
  publishes only the current year's rolls, so the previous roll is GenCut's own stored import.
- Skip parcels with institutional exemptions, and never read personal exemptions.
- Leave 10+ unit buildings out unless the profile includes them.
- Keep investor-owned parcels, with filters for owner type and signals.

**Why:** a cross-check against the Miami-Dade Property Appraiser
(`docs/validation/2026-10-14-property-appraiser-crosscheck.md`) found the facts right for 10 of
10 parcels, but one false tenure claim caused by a one-year revaluation, and one religious owner.
Personal exemptions (seniors, disability, widows, veterans) would be protected-class proxies.

**Revisit if:** a licensed deed-history source (Clerk records, the Property Appraiser's bulk data)
can give exact purchase dates.

