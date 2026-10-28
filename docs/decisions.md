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

## D-012 · 2026-10-14 · Campaign drafts: one model call, deterministic checks, background function

**Decision:**
- A draft is one call to the `creative` role. The router maps it to Anthropic Sonnet 5.5 by default, and `GENCUT_MODEL_<ROLE>` overrides it.
- The reply must be JSON, and deterministic checks in core decide whether it may be shown:
  - every figure must match a provided fact;
  - no fair-housing, hardship, how-we-found-you or pressure wording;
  - the brokerage name is in the signature.
- A failing draft gets one retry that lists the problems; after that it is marked failed with the reasons.
- Every call is recorded in `model_runs` with provider, model, tokens, cost, latency, prompt version and the fact keys used.
- Drafting runs in a Netlify background function (Free plan; up to 15 minutes), started by the server action, because normal requests time out before a draft finishes.
- Netlify functions are written in `apps/web/functions-src/` and bundled by `apps/web/scripts/bundle-functions.ts` (part of `next build`'s script) into self-contained modules in `apps/web/netlify/functions/`. Netlify's own packaging left imports of the TypeScript workspace packages unresolved (ERR_MODULE_NOT_FOUND in production, even with `node_bundler = "esbuild"`), so the first drafts never started. `apps/web/test/functions-bundle.test.ts` fails if a bundle still imports a workspace package. Netlify functions also bypass the session proxy (`apps/web/proxy.ts` matcher).
- The letter is stored as one outreach action in state DRAFT. Approval and sending come later, through the compliance gate.

**Why:** deterministic checks are free, testable and auditable, unlike a second "checker" model. The facts given to the writer exclude how the owner was found, the roll value and sale history, so the letter cannot reveal them. Netlify's normal function limit is shorter than a typical draft.

**Revisit if:** drafts often fail the checks (tune the prompt or the lists), or a second channel (email) needs its own template rules.

## D-013 · 2026-10-23 · Film Crew slice 1: agent headshot, seller-area social post, illustrative picture

**Decision (with Paul, 22–23 Oct):**
- The agent uploads a real headshot (Profile). GenCut does not generate or restyle a likeness.
- For a campaign whose letter is drafted, the Film Crew writes one social post and generates one picture.
  - The post markets the **agent** to homeowners in the area who may sell. It is given only area facts (ZIP, city when the roll names one, county, home type) and the agent's profile, never the address, the owner or anything about how the owner was selected. Checks in `packages/core/src/campaign/media.ts` reject a post that names the property, its street or its owner, omits the agent's name or brokerage, invents a figure, uses prohibited wording, or has malformed hashtags. One retry with the problems listed, as for letters.
  - The picture is a general scene of the area, generated by Google (`gemini-nano-banana-2.1`, $0.0336 per 1K image, chosen by `GENCUT_IMAGE_MODEL`) from the post's image brief wrapped in fixed rules: no people, no text or signs, never a single identifiable house. It is stored with `illustrative = true` (a database constraint) and always shown labelled "Illustrative image".
- Media budget: $1 per campaign (`MEDIA_BUDGET_USD_PER_CAMPAIGN`), counting every Film Crew call. Each paid step checks the budget first; image calls are logged in `model_runs` with role `image`.
- Images are stored in Postgres (`media_assets`, bytea, ≤ 5 MB, headshots ≤ 3 MB) and served to workspace members by `/media/[id]`.
- Nothing is posted. Publishing would be a new channel behind approval and the gate.

**Why:** the campaign's home is not for sale; advertising it, or "how to buy it", would be misleading advertising (Fla. Stat. §475.25(1)(c)) and would expose an owner who never asked for attention. Florida ads must carry the brokerage name (Fla. Admin. Code R. 61J2-10.025). GenCut has no photos of the home, so any picture of "the house" would be invented. Human models in housing ads raise fair-housing questions, so pictures have no people. Postgres storage needs no new service or secret and keeps tenant checks in one place; images are reached only through `film-crew.ts`, so moving to object storage changes one module.

**Revisit if:** image storage passes ~200 MB (move to Supabase Storage or Netlify Blobs), video is added (budget per run, provider abstraction already in `images.ts`), or posting is enabled (needs approval, platform terms and the gate).

## D-014 · 2026-10-26 · Buyer Radar B1: company buyers from verified roll purchases

**Decision (with Paul, 22 and 26 Oct; plan "Buyer Radar Implementation Plan"):**
- The Buyers tab starts with investor buyers from public records. Inbound buyer leads come later (B5).
- Source: the same Florida DOR NAL roll the seller import reads, in the same pass. A purchase is kept when the latest sale on the roll is qualified (codes 01–06), at least $10,000, dated in the roll year or the year before, and the owner of record is a company (`ownerKindOf`). Individuals, trusts and estates are never stored.
- Purchases live in `property_transactions` (county-wide, shared, one import per roll file in `transaction_imports`). Purchases older than the newest roll's window are deleted on import.
- A buyer is a company with 2+ purchases, grouped by a normalized name (`ownerKey`). Its profile (count, window, ZIPs, home types, prices, tax mailing address) is arithmetic over the cited purchases and nothing else. Each buyer opportunity stores `evidence` with the purchase ids; the database requires evidence for `investor_buyer` opportunities and a source record for every other type.
- Ranking rule `buyer-v1` (purchases, recency against the roll date, focus ZIPs, home type, price range; capped at 100). It is a ranking, not a probability that the company buys again, and is shown with its version.
- Outcomes are recorded and reported per opportunity type, so buyer results never mix with seller results. Outcome list extended with `qualified_conversation`, `offer` and `closed`.
- The page states what the records do not show: current intent, related companies, other counties, contact details. Nothing is sent; no buyer campaign until B2.

**Why:** a qualified sale to a company is a verified fact on a public record; anything about what the company wants next is inference and is labelled as such. Companies only, because building purchase histories of private individuals isn't needed for the investor use case and raises privacy risk. Reusing the roll avoids a new source, licence or secret. One pass keeps the worker within its GitHub Actions budget.

**Revisit if:** the Property Appraiser cross-check (plan criterion 3) shows the 2026 roll does not list buyers as owners on recent sales; deed records become available (Clerk terms or a licensed feed) for faster alerts (B4); or related companies need grouping (registered agent or mailing address — inference, must be labelled).

## D-015 · 2026-10-26 · Buyer Radar B2: buyer introduction letters, checked by the rules they were written under

**Decision:**
- From a buyer, GenCut drafts one letter introducing the agent to the company and offering to share opportunities in the ZIP codes and home types it has bought (`buyer-intro-v1`). Same flow as seller letters: one model call plus one retry, deterministic checks, a mail outreach action in state DRAFT, cost in `model_runs`.
- The writer gets the company name, its top three ZIP codes and home types, and the agent's profile. Never addresses, prices, dates, counts, the mailing address or the score.
- Checks: all seller-letter checks, plus no claimed intent, no claimed availability, and nothing about what the company bought or how it was found (letter text only; the strategy, which only the agent sees, may say what it bought). The company's own name is set aside before checking.
- Each campaign's prompt and checks are looked up by its stored `prompt_version` (`draftKind` in core), so an edit is re-checked under the rules the letter was written with, and an unknown version fails clearly instead of being checked by the wrong rules.
- Social posts stay seller-only: they market the agent around a seller's home, and a buyer has no such area.

**Why:** the plan's evidence labels: past purchases are verified, current intent is not, so the letter is an offer and never a claim. Keying rules to the stored version keeps old campaigns stable when a new kind or version is added.

**Revisit if:** buyer letters are sent (counsel review of mailing companies at their tax-mailing address first), or confirmed intent exists (B5 inbound buyers), which would allow a different letter.

## D-016 · 2026-10-26 · Buyer ranking v2: a multi-parcel deed is one purchase

**Found in production (26 Oct, first import):** 1,530 of 11,474 stored purchases (13%) carry DOR qualification code 05, an arm's-length sale of several parcels on one deed, where the roll prints the deed's full price on every parcel ([DOR sale qualification codes](https://floridarevenue.com/property/Documents/salequalcodes_aft01012025.pdf)). They are 206 deeds. Under `buyer-v1` each parcel counted as a purchase with that full price: one homebuilder showed 237 "purchases" that were 45 deeds, and lots showed prices of $3–5 million each. The same names also appeared under two spellings ("D R HORTON INC" / "DR HORTON INC").

**Decision (`buyer-v2`):**
- A purchase is a deed. Code-05 rows of one company with the same sale month and price are one purchase of several parcels; every other row is its own purchase. Purchase counts, the 2-purchase minimum, recency and ZIP/type counts all use deeds.
- Prices on a profile come from single-parcel purchases only. A multi-parcel sale is shown as "N parcels on one deed, $X total", never as a price per home. A company whose purchases are all multi-parcel has no price range.
- Owner keys drop spaces after normalizing, so spacing variants group. Migration 0010 rewrites stored keys the same way, removes untouched buyer opportunities and re-scores every workspace.

**Why:** the profile must state only what the record supports. A per-parcel copy of a bulk price is not what the company paid for that home.

**Revisit if:** the Property Appraiser cross-check shows other codes (03 new construction, 06 cross-county) distort profiles, or homebuilders crowd the list (a "builder" label from use code 000 lots is possible but would be inference).

## D-017 · 2026-10-27 · WhatsApp assistant, slice 1: agents only, Meta Cloud API, read and draft

**Decision:**
- An agent links their own WhatsApp number to their GenCut account with a one-time code made on the Profile page (6 digits, stored hashed, 15 minutes, single use; 5 wrong codes in an hour block the number). Display names are never trusted. One active link per number and per user; linking and unlinking are audited. "STOP" or Unlink on Profile removes the link.
- Provider: Meta's WhatsApp Cloud API directly (no reseller), behind a `ChatSender` interface so another provider or channel can replace it. Webhook POSTs are checked with the app secret's HMAC-SHA256 signature before anything is read; messages are stored once each by WhatsApp message id and answered by a background function that claims them, so retries never double-answer.
- What an agent can do: what is new; best sellers; best buyers; campaigns; details of a numbered item; save or dismiss; draft a letter (the same `startCampaignDraft` / `generateCampaignDraft` as the web, sent back when written). Every action uses the web app's services with a context built from the linked user (`via: 'whatsapp'`), so permissions and tenant checks are identical.
- Understanding: a deterministic parser first. Text it does not know goes to the fast model, which may only answer with one of the parser's commands; its answer is parsed again and numbers must come from the last list. Linking and unlinking are never inferred. Model calls are logged in `model_runs` (`assistant_intent`).
- Not in slice 1: approving or sending anything (the web has no approval yet either), messages to prospects (D-007 stands), notifications GenCut starts on its own (they need approved templates), media.

**Costs:** Meta bills per delivered message. Since 1 Oct 2026, replies inside the 24-hour window are free only for the first 1,000 per business number per month ([Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)). The fast model costs well under a cent per message it reads, and only for messages the parser does not understand.

**Why:** the spec requires one source of truth for web and WhatsApp and an authenticated association, not display names. Keeping slice 1 to reading and drafting keeps every consequential action behind the web app's review until approvals exist.

**Revisit if:** approvals ship on the web (then "approve" over WhatsApp with a confirmation step), notifications are wanted (template approval with Meta), or message volume passes the free tier.

## D-018 · 2026-10-28 · WhatsApp slice 2: conversation, suggestions, letter edits, debriefs (Boardy-style)

**Decision (Paul, 28 Oct: work like Boardy on WhatsApp, change nothing in the web app):**
- Free text is a conversation. The fast model sees the agent's profile and counts, the last list, what is being discussed, the open question and the last 8 messages, and answers with a short reply plus at most one action from a fixed list (`assistant-chat-v1`). The action goes through the same parser and list check as typed text. The reply is dropped if it claims anything was sent, mailed, called or approved, or states a figure not in the context.
- "next" offers the single best seller or buyer not yet offered (alternating), with its reason and "Should I draft…?"; "yes" drafts it, "no" skips it.
- "shorter", "warmer" or "edit: …" rewrites the letter being discussed under the same rules and facts it was written with, checked the same way, and saved through the same edit path as the app (`reviseCampaignLetter`, `revise-v1`).
- "2 replied", "meeting set" or a plain sentence records an outcome through `recordOutcome`, on the item or letter being discussed.
- Session state per number (migration 0013): the open question, the item in focus, and items already suggested.
- Not yet: a daily top-3 message (needs a Meta-approved template), voice notes (needs a speech-to-text provider), WhatsApp calls.

**Why:** Boardy's WhatsApp experience is a conversation that proposes one thing at a time and asks before acting. The fixed action list and reply checks keep that conversation inside what the agent is allowed to do and what the records say.

## D-019 · 2026-10-28 · Fallback if Meta does not approve WhatsApp (planned, not built)

**Decision (Paul, 28 Oct):** stay on WhatsApp through Meta's official Cloud API. Keep a fallback ready on paper, and do not build it unless Meta refuses the business, the number or the templates.

**Ruled out:** unofficial WhatsApp libraries that drive the WhatsApp Web client (Baileys, whatsapp-web.js, whatsmeow, and tools built on them such as Evolution API or Matrix bridges). They sit outside WhatsApp's terms, Meta detects them, and bans attach to the number, sometimes permanently ([summary with WhatsApp policy quotes](https://www.dragapp.com/blog/whatsapp-mcp-server/)). A banned business number would take the agents' channel down with no way back.

**Fallback order, if needed:**
1. Another official route to WhatsApp: a Business Solution Provider (for example Twilio or 360dialog). Same Meta rules, but they help with verification and templates.
2. Telegram: an official, free [Bot API](https://core.telegram.org/bots/api), no template approval, rich buttons. Weaker in the US than WhatsApp, strong with international buyers.
3. A chat inside the GenCut PWA, with web push for "your letter is ready". Needs nothing from anyone.
4. SMS (Twilio), agent-facing only: needs A2P 10DLC registration; prospects stay out (D-007).
5. Open-source inbox: [Chatwoot](https://github.com/chatwoot/chatwoot) (self-hosted) if agents want one inbox across channels; it uses the official APIs.

**Why this is cheap to switch:** the assistant (commands, conversation, replies, session) lives in `packages/core` and `packages/services/src/whatsapp.ts` behind a `ChatSender` interface; only the webhook parser and the sender are WhatsApp-specific. A second channel is a new webhook route and sender, about a day of work.

**Revisit when:** Meta answers the business verification, or rejects a number or template.

## D-020 · 2026-10-28 · Seller–buyer matching v1 (B3), agent-only, computed on read

**Decision:** a buyer matches a seller opportunity when its verified purchases include the home's ZIP code and its kind of home (`match-v1`: ZIP 40–50, kind 25, roll market value inside 80–120% of its single-home prices 15, latest purchase within 12 months of the roll 10). The seller page lists the five best-fitting investors; the buyer page lists the five best-fitting seller opportunities. Both say a match is a fit with past purchases, not a sign of buying, and not permission to contact anyone; only the agent sees them. Matches are computed from the workspace's own records when the page loads, so they are never stale.

**Not yet:** storing matches with a status ("useful / not useful") to measure them, and offering matches over WhatsApp. Both come next if agents use them.
