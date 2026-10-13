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
  the payload is a `StoredParcel` (core), not the raw row.
- `zip_coverage` — per county ZIP: import status (`pending` → `importing` → `ready` /
  `failed`), the roll file and its date, parcel count.
- `workspace_discovery` — per workspace: scoring status, counts considered / qualified /
  kept, scoring version.
- `prospects` — people a workspace may contact, with `contact_basis`.
- `opportunities` — score 0–100, confidence, reasons (with cited fact fields), scoring
  version, status (`new`, `saved`, `dismissed`, `in_campaign`); always linked to a
  `source_records` row; one per `subject_key` (e.g. `fl-dor-nal:23:<parcel>`) and type, so a
  newer roll updates it instead of duplicating it.

## Campaigns and outreach

- `campaigns` — status `generating` → `review` → `approved` → `active` → `completed`, plus
  `generation_failed` and `archived`.
- `outreach_actions` — channel, content, state `DRAFT` → `READY` → `APPROVED` → `EXECUTING`
  → `COMPLETED` / `FAILED`. A trigger enforces legal transitions, freezes approved content
  and clears approval on return to draft. Approved rows always record approver and time.

## Audit

- `audit_events` — append-only (update/delete raise an error): actor type and id,
  interface (`web`, `whatsapp`, `worker`, `api`), entity, action, from/to state, detail
  (e.g. the full gate decision).

## Coming next

M3 `agent_runs`; M4 `campaign_assets`; M6 `campaign_outcomes`, `experiments`.
