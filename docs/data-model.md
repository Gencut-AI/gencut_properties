# Data model

Source of truth: `packages/db/migrations/*.up.sql`. This page explains it.

## Tenancy and people

- `workspaces` — one agent's or team's account. Every business row carries `workspace_id`.
- `users`, `memberships` (role `owner` | `member`).
- `business_profiles` — licensee, **brokerage name (required)**, license number, office
  address, market, specialty, focus (ZIPs, property types, price band), brand.

## Permissions, consent, opt-out

- `workspace_permissions` — grants of `discover`, `generate`, `contact` (+ channel). Revoking
  sets `revoked_at`; history is kept; one active grant per kind/channel.
- `consents` — per address and channel: scopes, signature, disclosure, evidence, dates.
- `suppressions` — opt-outs; `channel` NULL means every channel; addresses compared
  case-insensitively.

## Discovery

- `data_sources` — each source with kind, terms URL and documented restrictions/costs.
- `source_records` — records with file date, situs `zip` and payload (public: shared;
  uploads: per workspace). For the FL DOR roll, `external_id` is `<county>:<parcel>` and
  the payload is a `StoredParcel` (core), not the raw row: current values, both sale slots,
  owner kind and the same parcel's values on the previous final roll.
- `zip_coverage` — per county ZIP: import status (`pending` → `importing` → `ready` /
  `failed`), the roll file and its date, parcel count, and `import_version`. Raising
  `PARCEL_IMPORT_VERSION` in services re-imports every ZIP.
- `workspace_discovery` — per workspace: scoring status, counts considered / qualified /
  kept, scoring version.
- `prospects` — people a workspace may contact, with `contact_basis`.
- `opportunities` — score 0–100, confidence, reasons (with cited fact fields), scoring
  version, status (`new`, `saved`, `dismissed`, `in_campaign`); always linked to a
  `source_records` row; one per `subject_key` (e.g. `fl-dor-nal:23:<parcel>`) and type, so a
  newer roll updates it instead of duplicating it.

- `property_transactions` — county-wide qualified purchases by companies (Buyer Radar):
  parcel, situs, home type, sale year/month, price, qualification code, owner name and
  normalized `owner_key`, tax mailing address, source file and date. Shared public data;
  unique per parcel, sale and price. Never individuals, trusts or estates.
- `transaction_imports` — one row per county roll file read for purchases (`importing` →
  `ready` / `failed`, rows read and kept).
- `workspace_discovery.buyer_*` — buyer scoring status, file date, companies considered and
  kept, last error.
- `opportunities.type` — `potential_seller`, `investor_buyer` (plus `responded_to_ad`,
  `sphere` reserved). A buyer has no source record; it has `evidence` (purchase ids, the
  computed profile, roll file date), enforced by `opportunities_cites_source`.
- `opportunity_outcomes` — contacted, no response, responded, not interested, qualified
  conversation, appointment, offer, listing, closed, wrong address. Reports group by type.

## Campaigns and outreach

- `campaigns` — status `generating` → `review` → `approved` → `active` → `completed`, plus
  `generation_failed` and `archived`.
- `outreach_actions` — channel, content, state `DRAFT` → `READY` → `APPROVED` → `EXECUTING`
  → `COMPLETED` / `FAILED`. A trigger enforces legal transitions, freezes approved content
  and clears approval on return to draft. Approved rows always record approver and time.

## Media (Film Crew)

- `campaigns.media_status` — `none` → `generating` → `ready` / `failed`, with `social_post`
  (the checked post), `media_error` and `media_problems`.
- `media_assets` — images in Postgres: the workspace's headshot (`upload`, one current per
  workspace) and generated neighborhood pictures (`generated`, always `illustrative`, tied to a
  campaign, with provider, model and prompt). ≤ 5 MB each.
- `model_runs.role` includes `image`; Film Crew calls (`social_post`, `neighborhood_image`)
  count against the $1 media budget per campaign.

## Audit

- `audit_events` — append-only (update/delete raise an error): actor type and id,
  interface (`web`, `whatsapp`, `worker`, `api`), entity, action, from/to state, detail
  (e.g. the full gate decision).

## Coming next

`agent_runs`; buyer campaign letters (B2); seller–buyer matches (B3); M6 `experiments`.
