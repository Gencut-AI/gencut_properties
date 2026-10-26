# Compliance rules implemented by the gate

`packages/core/src/compliance/gate.ts`, policy version `2026-10-10`. These are engineering
requirements taken from primary sources; they are **not legal advice**. Live sending stays
off until counsel reviews the consent and outreach design.

| Rule | Gate check(s) | Source |
| --- | --- | --- |
| Only approved actions execute | `action_approved` | GenCut policy |
| Contact permission per channel | `contact_permission` | GenCut policy |
| Opt-outs honored on every channel | `not_suppressed` | CAN-SPAM; FCC TCPA revocation rules; WhatsApp policy |
| Licensed brokerage name in every ad | `brokerage_name_present` | Fla. Admin. Code 61J2-10.025 |
| Email: truthful sender, postal address, opt-out link, ad disclosure | `email_*` | FTC CAN-SPAM compliance guide |
| Calls: Florida no-sales-solicitation list (with real-estate, request and relationship exemptions) | `florida_do_not_call` | Fla. Stat. 501.059(1)(k), (4) |
| Calls: national registry (only an express request overrides, pending counsel) | `national_do_not_call` | Conservative default |
| Calls: 8 a.m.–8 p.m. recipient local time | `calling_hours` | Fla. Stat. 501.616(6)(a) |
| Calls: ≤ 3 per 24 h on the same subject | `call_frequency` | Fla. Stat. 501.616(6)(b) |
| Texts / automated calls: prior express written consent naming the number | `written_consent` | Fla. Stat. 501.059(8) |
| WhatsApp: opt-in first; templates for business-initiated messages | `whatsapp_opt_in`, `whatsapp_template` | WhatsApp Business Messaging Policy |

Pending regulatory change: the FCC adopted a revised TCPA consent-revocation order on
30 Sep 2026, effective 30 days after Federal Register publication. Review the opt-out
handling against the published text before enabling texts.

## Generated copy

Campaign drafts must pass the checks in `packages/core/src/campaign/draft.ts` before they are
shown, and again after every edit:

- **Grounding:** every figure and year must come from the facts the writer was given.
- **Fair housing:** no words for protected characteristics or their proxies (families,
  children, seniors, religion, national origin, disability…).
- **Sensitivity:** no death, probate, divorce, debt, foreclosure or hardship language.
- **How the owner was found:** nothing about absentee or out-of-state ownership, homestead,
  assessments or records.
- **Pressure:** no guarantees and no "act now".
- **Florida advertising:** the brokerage name is in the signature (Fla. Admin. Code 61J2-10.025).

The writer is never given the owner's mailing location, the roll value, sale history or the
signals that selected the owner. Nothing is sent: letters stay outreach actions in state DRAFT.

Social posts (`packages/core/src/campaign/media.ts`) pass the same grounding, wording and
fair-housing checks, and three more:

- **No subject:** the post never names the campaign's property, its street or its owner. That
  home is not for sale; marketing it would be misleading advertising (Fla. Stat. §475.25(1)(c)).
- **Florida advertising:** the caption carries the agent's name and the brokerage name.
- **Pictures:** generated neighborhood pictures have no people, no text and no identifiable
  house, and are always labelled "Illustrative image". Agents' photos are their own uploads.

Nothing is posted; publishing will be a separate, approved channel.

## Data sources

| Source | Basis | What GenCut keeps | What it authorizes |
| --- | --- | --- | --- |
| Florida DOR NAL assessment roll | Public record, Fla. Stat. ch. 119; free from the DOR data portal | Residential parcels in requested ZIPs: owner of record, tax mailing address, situs, values, homestead flag, last roll sale | Discovery and research only. No phone or email; contact needs consent or another lawful basis per channel (gate) |

| Florida DOR NAL roll — sales (Buyer Radar) | Same | Qualified purchases by companies, county-wide: parcel, situs, home type, month, price, owner name, tax mailing address | Research on a company's past purchases only. Not evidence of current intent; no contact details; any outreach needs approval and a lawful basis per channel |

Buyer Radar never stores purchases by individuals, trusts or estates. Buyer pages say what
the records do not show (current intent, related companies, other counties, contact details).

Owner records made confidential under Fla. Stat. 119.071 appear without a name and are not
imported. Institutional owners (charitable, religious, educational, government and similar
exemptions) are not imported. Scoring uses property facts only — never protected
characteristics or proxies. The roll's personal exemptions (seniors, widows, blind or disabled
owners, veterans) are never read. See `docs/scoring.md`.

## Sources

- FTC — CAN-SPAM Act: A Compliance Guide for Business — https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- Florida Statutes §501.059 — http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.059.html
- Florida Statutes §501.616 — http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.616.html
- FCC fact sheet (Sept 2026) — https://docs.fcc.gov/public/attachments/DOC-424844A1.pdf
- WhatsApp Business Messaging Policy — https://business.whatsapp.com/policy
- Fla. Admin. Code R. 61J2-10.025 (advertising) — https://www.law.cornell.edu/regulations/florida/Fla-Admin-Code-Ann-R-61J2-10-025
- Florida Realtors on Rule 61J2-10.025 — https://www.floridarealtors.org/law-ethics/library/realtor-advertising-rules-florida
