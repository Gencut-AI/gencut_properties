/**
 * Recent sales of homes like the owner's, in the owner's ZIP code, for the
 * seller letter (D-035): context that gives an owner a reason to reply, from
 * the whole county roll. Never the owner's own record.
 */
import { DOR_USE_LABELS, isQualifiedSale } from '../sources/fl-dor-nal.ts';

export interface RollSale {
  readonly parcelId: string;
  readonly year: number;
  readonly month: number | null;
  readonly price: number | null;
  readonly qualificationCode: string;
}

/** Fewer sales than this say nothing reliable about a ZIP code; the fact is left out. */
export const MIN_RECENT_SALES = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const usd = (n: number) => `$${(Math.round(n / 1000) * 1000).toLocaleString('en-US')}`;

/**
 * "12 condominium sales in ZIP 33156 from Aug 2025 to Jul 2026, median price $412,000", or null.
 *
 * Qualified sales only, in the 12 months ending with the newest one; a deed that
 * covers several parcels (the same month and price on more than one parcel) is
 * left out, since its price is not the price of one home; `ownParcelId` is never counted.
 */
export function recentSalesSummary(sales: readonly RollSale[], zip: string, useCode: string, ownParcelId: string): string | null {
  const usable = sales.filter((s) => s.parcelId !== ownParcelId && s.month !== null && (s.price ?? 0) >= 10_000 && isQualifiedSale(s.qualificationCode));
  const deedKey = (s: RollSale) => `${s.year}-${s.month}-${s.price}`;
  const parcelsPerDeed = new Map<string, Set<string>>();
  for (const s of usable) parcelsPerDeed.set(deedKey(s), (parcelsPerDeed.get(deedKey(s)) ?? new Set()).add(s.parcelId));
  const single = usable.filter((s) => (parcelsPerDeed.get(deedKey(s))?.size ?? 0) === 1);
  if (single.length === 0) return null;
  const idx = (s: RollSale) => s.year * 12 + ((s.month as number) - 1);
  const newest = Math.max(...single.map(idx));
  const window = single.filter((s) => idx(s) > newest - 12);
  if (window.length < MIN_RECENT_SALES) return null;
  const prices = window.map((s) => s.price as number).sort((a, b) => a - b);
  const mid = prices.length / 2;
  const median = prices.length % 2 ? (prices[Math.floor(mid)] as number) : ((prices[mid - 1] as number) + (prices[mid] as number)) / 2;
  const oldest = Math.min(...window.map(idx));
  const label = (i: number) => `${MONTHS[i % 12]} ${Math.floor(i / 12)}`;
  const kind = (DOR_USE_LABELS[useCode] ?? 'home').toLowerCase();
  return `${window.length} ${kind} sales in ZIP ${zip} from ${label(oldest)} to ${label(newest)}, median price ${usd(median)}`;
}
