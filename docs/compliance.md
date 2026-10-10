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

## Sources

- FTC — CAN-SPAM Act: A Compliance Guide for Business — https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- Florida Statutes §501.059 — http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.059.html
- Florida Statutes §501.616 — http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.616.html
- FCC fact sheet (Sept 2026) — https://docs.fcc.gov/public/attachments/DOC-424844A1.pdf
- WhatsApp Business Messaging Policy — https://business.whatsapp.com/policy
- Florida Realtors on Rule 61J2-10.025 — https://www.floridarealtors.org/law-ethics/library/realtor-advertising-rules-florida
