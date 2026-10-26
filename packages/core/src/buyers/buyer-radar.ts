/**
 * Buyer Radar: companies with observable purchasing activity, from the public
 * roll's sale records.
 *
 * Evidence comes in three kinds, and only these three exist here:
 *   - verified transaction: a qualified sale on the roll, with the company as
 *     owner of record afterwards (`PropertyTransaction`);
 *   - derived pattern: arithmetic over those transactions (`BuyerProfile`);
 *   - hypothesis: anything about future buying, always worded as a possibility.
 * Confirmed buying intent only ever comes from the buyer (inquiries,
 * registrations), never from records, and is not modelled here.
 *
 * Only companies are profiled. Individuals' and personal trusts' purchase
 * histories are never collected: the importer drops them before storage.
 */
import { type AgentFocus, matchesPropertyFocus } from '../opportunity/scoring.ts';
import { DOR_USE_LABELS, isQualifiedSale, nalRowToParcel, propertyUseOf } from '../sources/fl-dor-nal.ts';

/** Opportunity types; mirrors the CHECK on opportunities.type. */
export const OPPORTUNITY_TYPES = ['potential_seller', 'responded_to_ad', 'sphere', 'investor_buyer'] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/** Version of the buyer rule; recorded on every buyer opportunity and outcome. */
export const BUYER_SCORING_VERSION = 'buyer-v1';
/** A company needs this many qualified purchases in the window to be a buyer. */
export const MIN_BUYER_PURCHASES = 2;
/** A purchase below this price is treated as a nominal transfer, not a market purchase. */
export const MIN_PURCHASE_PRICE = 10_000;

/** One verified purchase: a qualified sale whose owner of record afterwards is a company. */
export interface PropertyTransaction {
  readonly countyCode: string;
  readonly parcelId: string;
  /** Assessment year of the roll the sale was read from. */
  readonly rollYear: number;
  readonly situs: { readonly address: string; readonly city: string; readonly zip: string };
  readonly useCode: string;
  readonly units: number | null;
  readonly livingArea: number | null;
  readonly yearBuilt: number | null;
  /** Owner of record as printed on the roll. */
  readonly ownerName: string;
  /** Normalized owner name; purchases are grouped by it. */
  readonly ownerKey: string;
  /** The company's tax-mailing address on the roll. */
  readonly ownerMailing: { readonly address1: string; readonly address2: string; readonly city: string; readonly state: string; readonly zip: string };
  readonly saleYear: number;
  readonly saleMonth: number | null;
  readonly price: number;
  readonly qualificationCode: string;
}

const SUFFIXES: readonly [RegExp, string][] = [
  [/\bL\s?L\s?C\b/g, 'LLC'],
  [/\bLIMITED LIABILITY (COMPANY|CO)\b/g, 'LLC'],
  [/\bINCORPORATED\b/g, 'INC'],
  [/\bCORPORATION\b/g, 'CORP'],
  [/\bCOMPANY\b/g, 'CO'],
  [/\bLIMITED PARTNERSHIP\b/g, 'LP'],
  [/\bL\s?P\b/g, 'LP'],
  [/\bLIMITED\b/g, 'LTD'],
];

/**
 * Group key for an owner name: upper case, "&" as AND, punctuation dropped,
 * entity suffixes spelled one way ("L.L.C." and "Limited Liability Company" →
 * LLC). Different companies are never merged, even if one investor owns both.
 */
export function ownerKey(name: string): string {
  let n = name.toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of SUFFIXES) n = n.replace(re, to);
  return n.replace(/\s+/g, ' ').trim();
}

/**
 * The company purchase on one roll row, or null. Kept only when the row is a
 * residential parcel GenCut may store (not confidential, not institutional),
 * its owner of record is a company, and its latest sale is a qualified sale of
 * at least $10,000 in the roll's sale window (the roll year and the year before).
 */
export function nalRowToTransaction(fields: readonly string[], index: Map<string, number>): PropertyTransaction | null {
  const parcel = nalRowToParcel(fields, index);
  if (!parcel || parcel.ownerKind !== 'company') return null;
  const sale = parcel.sales[0];
  if (!sale || !isQualifiedSale(sale.qualificationCode) || (sale.price ?? 0) < MIN_PURCHASE_PRICE) return null;
  if (!parcel.assessmentYear || sale.year < parcel.assessmentYear - 1 || sale.year > parcel.assessmentYear) return null;
  return {
    countyCode: parcel.countyCode,
    parcelId: parcel.parcelId,
    rollYear: parcel.assessmentYear,
    situs: parcel.situs,
    useCode: parcel.useCode,
    units: parcel.units,
    livingArea: parcel.livingArea,
    yearBuilt: parcel.yearBuilt,
    ownerName: parcel.owner.name,
    ownerKey: ownerKey(parcel.owner.name),
    ownerMailing: parcel.owner,
    saleYear: sale.year,
    saleMonth: sale.month,
    price: sale.price ?? 0,
    qualificationCode: sale.qualificationCode,
  };
}

const monthIndex = (year: number, month: number | null) => year * 12 + ((month ?? 1) - 1);

/** A month as "Mar 2025", or the year alone when the month is unknown. */
export function monthLabel(year: number, month: number | null): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return month ? `${names.at(month - 1)} ${year}` : String(year);
}

/** Derived pattern: arithmetic over one company's verified purchases, nothing else. */
export interface BuyerProfile {
  readonly ownerKey: string;
  /** The name on the company's most recent purchase. */
  readonly name: string;
  readonly countyCode: string;
  readonly purchases: number;
  readonly first: { readonly year: number; readonly month: number | null };
  readonly latest: { readonly year: number; readonly month: number | null };
  /** ZIP codes bought in, most purchases first. */
  readonly zips: readonly { readonly zip: string; readonly count: number }[];
  /** Home types bought, most purchases first. */
  readonly homeTypes: readonly { readonly useCode: string; readonly label: string; readonly count: number }[];
  readonly price: { readonly min: number; readonly median: number; readonly max: number };
  /** The tax-mailing address on the most recent purchase. */
  readonly mailing: PropertyTransaction['ownerMailing'];
}

function counts<K extends string>(items: readonly K[]): { key: K; count: number }[] {
  const m = new Map<K, number>();
  for (const k of items) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** The profile of one company from its purchases (all with the same owner key). */
export function buyerProfile(txs: readonly PropertyTransaction[]): BuyerProfile {
  if (txs.length === 0) throw new Error('A buyer profile needs at least one purchase.');
  const byDate = [...txs].sort((a, b) => monthIndex(a.saleYear, a.saleMonth) - monthIndex(b.saleYear, b.saleMonth) || a.parcelId.localeCompare(b.parcelId));
  const first = byDate.at(0)!;
  const latest = byDate.at(-1)!;
  const prices = txs.map((t) => t.price).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices.at(mid)! : Math.round((prices.at(mid - 1)! + prices.at(mid)!) / 2);
  return {
    ownerKey: latest.ownerKey,
    name: latest.ownerName,
    countyCode: latest.countyCode,
    purchases: txs.length,
    first: { year: first.saleYear, month: first.saleMonth },
    latest: { year: latest.saleYear, month: latest.saleMonth },
    zips: counts(txs.map((t) => t.situs.zip)).map((c) => ({ zip: c.key, count: c.count })),
    homeTypes: counts(txs.map((t) => t.useCode)).map((c) => ({ useCode: c.key, label: DOR_USE_LABELS[c.key] ?? 'Residential', count: c.count })),
    price: { min: prices.at(0)!, median, max: prices.at(-1)! },
    mailing: latest.ownerMailing,
  };
}

export interface BuyerReason {
  readonly code: 'purchases' | 'recent' | 'focus_zip' | 'mostly_focus_zip' | 'focus_type' | 'focus_price';
  readonly points: number;
  readonly text: string;
}

export type BuyerScore =
  | { readonly eligible: true; readonly score: number; readonly reasons: readonly BuyerReason[]; readonly version: string }
  | { readonly eligible: false; readonly why: string; readonly version: string };

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * Rank a company by how much verified buying it did and how well it fits the
 * agent's focus. A ranking, not a probability of buying again. Recency is
 * measured against the roll's file date (`rollDate`, YYYY-MM-DD), not today.
 */
export function scoreBuyer(p: BuyerProfile, focus: AgentFocus, rollDate: string): BuyerScore {
  if (p.purchases < MIN_BUYER_PURCHASES) {
    return { eligible: false, why: `${p.purchases} qualified purchase; a buyer needs ${MIN_BUYER_PURCHASES}.`, version: BUYER_SCORING_VERSION };
  }
  const reasons: BuyerReason[] = [];
  const window = `${monthLabel(p.first.year, p.first.month)} to ${monthLabel(p.latest.year, p.latest.month)}`;
  const buys = p.purchases >= 5 ? 50 : p.purchases >= 3 ? 40 : 30;
  reasons.push({ code: 'purchases', points: buys, text: `${p.purchases} qualified purchases on the county roll, ${window}.` });

  const roll = monthIndex(Number(rollDate.slice(0, 4)), Number(rollDate.slice(5, 7)));
  const age = roll - monthIndex(p.latest.year, p.latest.month);
  if (age <= 6) reasons.push({ code: 'recent', points: 20, text: `Latest purchase ${monthLabel(p.latest.year, p.latest.month)}, within 6 months of the roll.` });
  else if (age <= 12) reasons.push({ code: 'recent', points: 10, text: `Latest purchase ${monthLabel(p.latest.year, p.latest.month)}, within 12 months of the roll.` });

  const inFocus = p.zips.filter((z) => focus.zips.includes(z.zip)).reduce((a, z) => a + z.count, 0);
  if (inFocus > 0) {
    reasons.push({ code: 'focus_zip', points: 15, text: `${inFocus} of ${p.purchases} purchases in your ZIP codes.` });
    if (inFocus * 2 >= p.purchases) reasons.push({ code: 'mostly_focus_zip', points: 10, text: 'Half or more of its purchases are in your ZIP codes.' });
  }
  const typeFit = p.homeTypes.filter((t) => matchesPropertyFocus(propertyUseOf(t.useCode), focus.propertyUses));
  if (typeFit.length) reasons.push({ code: 'focus_type', points: 10, text: `Bought ${typeFit.map((t) => t.label.toLowerCase()).join(' and ')} homes, which you work.` });
  const inRange = (focus.minValue === undefined || p.price.median >= focus.minValue) && (focus.maxValue === undefined || p.price.median <= focus.maxValue);
  if ((focus.minValue !== undefined || focus.maxValue !== undefined) && inRange) {
    reasons.push({ code: 'focus_price', points: 5, text: `Median purchase price ${usd(p.price.median)}, inside your price range.` });
  }
  return { eligible: true, score: Math.min(100, reasons.reduce((a, r) => a + r.points, 0)), reasons, version: BUYER_SCORING_VERSION };
}
