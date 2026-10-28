/**
 * Seller–buyer matching (Buyer Radar B3): which investor companies' past
 * purchases fit a home that may come to market. Shown to the agent only.
 *
 * A match is a recommendation for the agent to review: it says the company
 * bought homes like this one, where this one is. It is not evidence that the
 * company is buying now, and it is not permission to contact anyone.
 */
import type { BuyerProfile } from '../buyers/buyer-radar.ts';
import { monthLabel } from '../buyers/buyer-radar.ts';
import { DOR_USE_LABELS, propertyUseOf } from '../sources/fl-dor-nal.ts';

export const MATCH_VERSION = 'match-v1';

/** The facts of a seller opportunity a match uses: where, what, and its value on the roll. */
export interface MatchHome {
  readonly zip: string;
  readonly useCode: string;
  /** Market (just) value on the roll; not a price. */
  readonly marketValue: number | null;
}

export interface MatchReason {
  readonly code: 'zip' | 'type' | 'price' | 'recent';
  readonly points: number;
  readonly text: string;
}

export interface Match {
  readonly score: number;
  readonly reasons: readonly MatchReason[];
  readonly version: string;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const monthIndex = (y: number, m: number | null) => y * 12 + ((m ?? 1) - 1);

/**
 * How well a buyer's past purchases fit a home, or null when they do not:
 * the company must have bought in the home's ZIP code and bought its kind of home.
 * `rollDate` (YYYY-MM-DD) is the roll the purchases were read from.
 */
export function matchBuyerToHome(home: MatchHome, buyer: BuyerProfile, rollDate: string): Match | null {
  const inZip = buyer.zips.find((z) => z.zip === home.zip);
  const kind = propertyUseOf(home.useCode);
  const sameKind = buyer.homeTypes.filter((t) => propertyUseOf(t.useCode) === kind);
  if (!inZip || sameKind.length === 0) return null;

  const reasons: MatchReason[] = [];
  reasons.push({ code: 'zip', points: inZip.count >= 2 ? 50 : 40, text: `Bought ${inZip.count === 1 ? 'a home' : `${inZip.count} homes`} in ${home.zip}.` });
  const label = (DOR_USE_LABELS[home.useCode] ?? sameKind[0]?.label ?? 'homes').toLowerCase();
  reasons.push({ code: 'type', points: 25, text: `Buys ${label} homes.` });
  if (buyer.price && home.marketValue !== null && home.marketValue >= buyer.price.min * 0.8 && home.marketValue <= buyer.price.max * 1.2) {
    reasons.push({
      code: 'price',
      points: 15,
      text: `Paid ${usd(buyer.price.min)} to ${usd(buyer.price.max)} for single homes; this one's market value on the roll is ${usd(home.marketValue)}.`,
    });
  }
  const roll = monthIndex(Number(rollDate.slice(0, 4)), Number(rollDate.slice(5, 7)));
  if (roll - monthIndex(buyer.latest.year, buyer.latest.month) <= 12) {
    reasons.push({ code: 'recent', points: 10, text: `Latest purchase ${monthLabel(buyer.latest.year, buyer.latest.month)}.` });
  }
  return { score: Math.min(100, reasons.reduce((a, r) => a + r.points, 0)), reasons, version: MATCH_VERSION };
}
