# Opportunity scoring: what it does and does not mean

GenCut's score **ranks** the signals it finds in public property records. It is **not** a
probability that an owner will sell, and its weights have **not** been checked against real
outcomes. Treat a high score as a parcel worth researching, not a qualified seller.

Current rule: `seller-v3` (`packages/core/src/opportunity/scoring.ts`).

## Signals

| Reason | Points | What it rests on | What it does not show |
| --- | --- | --- | --- |
| In focus | +20 | Situs ZIP and property type match the profile | Anything about the owner |
| Absentee owner | +25 | Tax mail goes to another street address **and** no homestead exemption | Whether the owner rents it out, uses it seasonally or just gets mail elsewhere |
| Owner out of state | +10 | Absentee, with a mailing state other than Florida | The owner's residence |
| Long held | +30 | Assessed value is far below market value on the current **and** the previous roll | Exact tenure. The two-roll gap shows only that no sale reset the assessment for at least two years |
| Held 2+ years | +15 | A moderate gap on both rolls | Same as above |
| Assessed below market | +10 | A deep gap on the current roll, with no previous roll available | Tenure. One sharp revaluation produces the same gap; this reason says so |
| Estate | +15 | Owner of record is named as an estate | Probate status, family circumstances |
| Recently sold | −30 | A sale on either roll in the last three years (qualified, or $10,000+) | Older sales: the rolls carry only the last two years of sales each |
| In / outside price range | +10 / −15 | Market value against the profile's range | Listing price |

A parcel must reach **55** points to become an opportunity. In practice that takes two signals
beyond being in focus. A workspace keeps its best **100**. Ties go to the wider assessment gap.

## Left out entirely

- **Confidential owners** (Fla. Stat. 119.071): blank names on the roll.
- **Institutional owners:** charitable, religious, educational, hospital, government,
  affordable-housing and similar exemptions (DOR exemption fields 09–21, 29, 30, 36, 37, 42–46).
- **Buildings of 10 or more units**, unless the profile turns them on.
- **Personal characteristics:** the roll's exemptions for seniors, widows, blind or disabled
  owners and veterans are proxies for protected classes. The importer never reads them, and
  no rule may use them or any other proxy (Fair Housing Act).

## Known limitations

1. **No purchase date.** Florida's roll records only the last two years of sales. The
   assessment-gap method was wrong for 1 of 10 parcels in the
   [14 Oct 2026 cross-check](validation/2026-10-14-property-appraiser-crosscheck.md). Version 3
   now requires the gap on two rolls.
2. **Weights are a starting heuristic.** No outcome data exists yet. Outcome tracking (M3)
   records contact, response, appointment and listing against the scoring version, so later
   versions can be compared against what actually happened.
3. **Absentee owners dominate.** The signals favour investors and second-home owners. Their
   reasons to sell differ from owner-occupants', and campaigns should address them differently.
4. **Owner type comes from the name.** "LLC", "TRUST" and similar words decide it. Some
   family trusts are effectively individuals.
5. **No contact details.** The roll has a tax-mailing address only, so direct mail is the only
   channel these records support.

## Changing the rule

A new rule gets a new version string. Its tests must keep every case above, including the
revaluation case from the cross-check. Re-scoring happens automatically for workspaces whose
records or profile change; the score shown always names its version.
