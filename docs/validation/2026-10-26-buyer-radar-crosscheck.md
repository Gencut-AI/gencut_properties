# Cross-check: 10 Buyer Radar purchases vs the Miami-Dade Property Appraiser

**Date:** 26 Oct 2026. **Workspace:** founder test profile (ZIP 33180).
**GenCut source:** Florida DOR 2026 preliminary NAL roll, "Dade 23 Preliminary NAL 2026.zip"
(dated 27 Jul 2026), first production import (11,474 company purchases), scoring `buyer-v1`.
**Sample:** 5 purchases from 2025 and 5 from 2026, drawn by a hash of the row id from the
purchases cited by the 200 kept buyers.
**Reference:** Miami-Dade Property Appraiser property search (apps.miamidadepa.gov), read on
26 Oct 2026 for each folio.

Company names were compared but are not reproduced here: the repository is public. No
individual's name is recorded.

## Result

**10 of 10 purchases match** the Property Appraiser's sales history: the buying company, the sale
month and the price. Acceptance criterion 3 (at least 9 of 10) holds.

- **2026 sales list the buyer.** All five 2026 sales on the roll (Jan–May 2026) show the company
  as the buyer and owner of record. The plan's open question is answered: 2026 sales stay in.
- **6 of the 10 are multi-parcel sales** ("Qual on DOS, multi-parcel sale", DOR code 05), priced
  $2.2–5.2 million: the deed's total for many lots, printed on each parcel. Under `buyer-v1` each
  lot counted as a purchase at that price. This is the problem `buyer-v2` fixes (D-016).
- **The roll can be behind.** One lot bought by a builder in Jan 2025 was resold to individuals on
  30 Jun 2026, after the roll was prepared. The purchase is still a true fact; the company may no
  longer own the parcel. Buyer pages say purchases are past events.
- **Builders' lots.** Five of the six multi-parcel purchases are vacant townhouse lots bought by
  national homebuilders. They are real purchases but not what a resale agent means by an investor
  buyer; `buyer-v2` ranks them by deeds, which moves them down.

| Folio | Sale year | Code | GenCut: buyer, month, price | Property Appraiser |
| --- | --- | --- | --- | --- |
| 1678250401770 | 2025 | 05 | Jan 2025, $4,200,000 | ✓ multi-parcel; resold Jun 2026 |
| 3530290770070 | 2025 | 01 | Feb 2025, $595,000 | ✓ |
| 1079170312340 | 2025 | 05 | Apr 2025, $5,172,200 | ✓ multi-parcel |
| 1679190330640 | 2025 | 05 | Oct 2025, $2,198,300 | ✓ multi-parcel |
| 1678250430550 | 2025 | 05 | Oct 2025, $4,815,000 | ✓ multi-parcel |
| 3122110691650 | 2026 | 01 | Jan 2026, $205,000 | ✓ |
| 1079170310690 | 2026 | 05 | Feb 2026, $3,199,400 | ✓ multi-parcel |
| 3122110462660 | 2026 | 01 | Apr 2026, $270,000 | ✓ |
| 3411350330430 | 2026 | 01 | Apr 2026, $175,000 | ✓ |
| 1679300042840 | 2026 | 05 | May 2026, $5,060,300 | ✓ multi-parcel |

"✓" means the Property Appraiser lists a qualified sale to the same company in the same month at
the same price.
