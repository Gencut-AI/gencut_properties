# Cross-check: top 10 opportunities vs the Miami-Dade Property Appraiser

**Date:** 14 Oct 2026. **Workspace:** founder test profile (ZIP 33180, single-family and multifamily).
**GenCut source:** Florida DOR 2026 preliminary NAL roll, file "Dade 23 Preliminary NAL 2026.zip"
(dated 27 Jul 2026), scoring `seller-v2`.
**Reference:** Miami-Dade Property Appraiser property search (apps.miamidadepa.gov), read on
14 Oct 2026 for each folio.

Owner names are compared but not reproduced here: the repository is public.

## Result

The public-record facts matched for **10 of 10**: 2026 market value, assessed value, homestead
status, property use, owner of record and mailing state. The *interpretation* was wrong or weak for
3 of 10:

- **Long ownership was wrong for 1** (folio 3022040000350). It was bought for $2.4 million in
  June 2022. Its assessment gap comes from a single-year revaluation: market value rose from
  $1.76 million (2025) to $2.66 million (2026). One roll cannot tell that apart from years of
  ownership.
- **Long ownership was partly right for 1** (0722040141670). It was bought in January 2018, and
  a partial interest changed hands in September 2021.
- **One owner is an institution** (3012340150320). It has a constitutional religious exemption, so
  it is not a realistic seller lead and should be excluded.

| Folio | Use | Market value (DOR = PA) | Assessed, non-school (DOR = PA) | Homestead | Owner and mailing state | Last priced sale (PA) | GenCut's long-ownership signal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3022040000350 | Single family | $2,664,071 ✓ | $1,555,860 ✓ | No ✓ | ✓ (NY) | Jun 2022, $2,400,000 | **Wrong**: held about 4 years |
| 0722040141670 | Single family | $2,029,129 ✓ | $979,620 ✓ | No ✓ | ✓ (FL) | Sep 2021, partial interest $1,000,000; Jan 2018, $650,000 | Partly right |
| 2812340080360 | Single family | $604,399 ✓ | $222,850 ✓ | No ✓ | ✓ (FL) | Dec 1986, $43,000 | Right |
| 3012340030170 | Multifamily, 2 units | $596,687 ✓ | $344,781 ✓ | No ✓ | ✓ (FL) | Jul 2004, $210,000 (non-sale transfer 2008) | Right |
| 3012340030260 | Multifamily, 2 units | $634,801 ✓ | $366,529 ✓ | No ✓ | ✓ (FL) | Sep 2009, $137,000 | Right |
| 3012340030620 | Single family | $556,957 ✓ | $325,146 ✓ | No ✓ | ✓ (FL) | Nov 2011, $105,000 | Right |
| 3012340030650 | Multifamily, 2 units | $577,144 ✓ | $320,597 ✓ | No ✓ | ✓ (FL) | Jul 1994, $68,000 (non-sale transfer 2006) | Right |
| 3012340031254 | Multifamily, 2 units | $582,451 ✓ | $314,738 ✓ | No ✓ | ✓ (FL) | Jul 1987, $68,000 (non-sale transfer 2004) | Right |
| 3012340150320 | Single family | $660,183 ✓ | $261,714 ✓ | No ✓ | ✓ (FL) | Jan 2005, $60,000 | Right, but **religious exemption: exclude** |
| 3012340510020 | Multifamily, 2 units | $828,784 ✓ | $493,713 ✓ | No ✓ | ✓ (FL) | Sep 2013, $275,000 | Right |

The Property Appraiser shows a "Non-Homestead Cap" assessment reduction on all 10. That confirms the
gap GenCut reads is the statutory 10% cap, and not another discount.

## Changes made because of this check

1. **Two rolls, not one.** Long ownership is claimed only when assessed value sat well below
   market value on *two consecutive* rolls. A gap that appears in one year only (as for folio
   3022040000350) earns no tenure points. The DOR portal publishes only the current year's
   rolls (checked 14 Oct 2026: the NAL folder holds 2026P and 2026F only), so the previous roll
   comes from GenCut's own stored import of last year. Until a second year exists, the reason
   is the weaker "assessed below market" (+10 instead of +30), and it says that one roll cannot
   show tenure.
2. **Recent sales from both sale slots.** Both of the roll's sale slots are read, and sales from
   the previous roll once it exists. Any sale in the last three years counts against a parcel. DOR qualification codes 01–06 are treated as qualified sales, per the 2025 NAL
   user's guide.
3. **Institutional owners excluded.** Parcels with a charitable, religious, educational,
   governmental, hospital or similar exemption (DOR exemption fields 09, 12–20, 29, 30, 36, 37, 42–46)
   are not imported as seller opportunities.
4. **Personal exemptions never read.** Exemptions for seniors, widows, blind or disabled owners and
   veterans are proxies for protected characteristics. The importer neither reads nor stores them.

## Not verified by this check

- Whether any of these owners intends to sell. The scores rank signals in public records and are
  not probabilities.
- Owners' current mailing addresses beyond what both public sources agree on.
- Any folio outside the top 10.
