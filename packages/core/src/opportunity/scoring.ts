/**
 * Seller-opportunity scoring, version 2.
 *
 * Inputs are property facts from public assessment rolls — never personal or
 * protected characteristics (race, religion, national origin, sex, familial
 * status, disability, age…). The type below has no field for them, and the
 * scorer must not be extended with any proxy for them (Fair Housing Act).
 *
 * Weights are an explicit, documented heuristic: a baseline for the learning
 * loop to evaluate against recorded campaign outcomes, not a claim that they
 * predict listings. Every point comes with a plain-language reason and the
 * fact fields it rests on.
 *
 * v2 vs v1: the Florida roll does not record when the current owner bought
 * the property (its sale fields cover only the last year or two), so tenure is
 * read from the gap between assessed and market value. Florida caps annual
 * increases in assessed value (3% for homesteads, 10% for other residential),
 * so a wide gap builds up only over years of continuous ownership.
 */
export const SCORING_VERSION = 'seller-v2';

export const PROPERTY_USES = ['single_family', 'condo', 'townhouse', 'multifamily', 'vacant_land', 'other'] as const;
export type PropertyUse = (typeof PROPERTY_USES)[number];

export interface RecentSale {
  readonly year: number;
  /** 1–12 when known. */
  readonly month?: number;
  readonly price?: number;
  /** Arm's-length sale per the roll's qualification code. */
  readonly qualified: boolean;
}

/** Normalized parcel facts. Field names are what reasons cite as provenance. */
export interface ParcelFacts {
  readonly parcelId: string;
  readonly countyCode: string;
  readonly situsAddress: string;
  readonly situsCity?: string;
  readonly situsZip: string;
  readonly ownerName: string;
  readonly ownerMailingAddress: string;
  readonly ownerMailingCity?: string;
  readonly ownerMailingState: string;
  readonly ownerMailingZip?: string;
  /** Homestead exemption on this parcel: the owner declared it their permanent residence. */
  readonly homestead: boolean;
  readonly propertyUse: PropertyUse;
  /** Market ("just") value. */
  readonly justValue?: number;
  /** School-district assessed value, after Florida's assessment caps. */
  readonly assessedValue?: number;
  readonly recentSale?: RecentSale;
  readonly units?: number;
  readonly yearBuilt?: number;
  readonly livingArea?: number;
  /** Owner record is confidential under Fla. Stat. 119.071; never surfaced. */
  readonly confidential?: boolean;
}

/** What the agent told GenCut about their business. */
export interface AgentFocus {
  readonly zips: readonly string[];
  readonly propertyUses: readonly PropertyUse[];
  readonly minValue?: number;
  readonly maxValue?: number;
  /** Where "out of state" is measured from. Defaults to FL. */
  readonly homeState?: string;
}

export interface ScoreReason {
  readonly code: string;
  readonly points: number;
  readonly text: string;
  readonly facts: readonly (keyof ParcelFacts)[];
}

export type ScoreResult =
  | {
      readonly eligible: true;
      readonly score: number;
      readonly confidence: number;
      readonly reasons: readonly ScoreReason[];
      readonly version: string;
    }
  | { readonly eligible: false; readonly why: string; readonly version: string };

/**
 * The state roll does not separate townhouses from single-family homes, so a
 * townhouse focus matches single-family parcels.
 */
export function matchesPropertyFocus(use: PropertyUse, focus: readonly PropertyUse[]): boolean {
  return focus.includes(use) || (use === 'single_family' && focus.includes('townhouse'));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pct = (r: number) => `${Math.round(r * 100)}%`;

export function scoreSellerOpportunity(p: ParcelFacts, focus: AgentFocus, asOf: Date): ScoreResult {
  if (p.confidential || !p.ownerName.trim()) {
    return { eligible: false, why: 'Owner record is confidential under Florida law.', version: SCORING_VERSION };
  }
  if (!focus.zips.includes(p.situsZip)) {
    return { eligible: false, why: `ZIP ${p.situsZip} is outside the agent's focus area.`, version: SCORING_VERSION };
  }
  if (!matchesPropertyFocus(p.propertyUse, focus.propertyUses)) {
    return {
      eligible: false,
      why: `Property type ${p.propertyUse} is outside the agent's specialty.`,
      version: SCORING_VERSION,
    };
  }

  const reasons: ScoreReason[] = [];
  const add = (code: string, points: number, text: string, facts: (keyof ParcelFacts)[]) =>
    reasons.push({ code, points, text, facts });

  add('in_focus', 20, `In the agent's focus area (${p.situsZip}) and property type.`, ['situsZip', 'propertyUse']);

  const mailingDiffers = normalizeAddress(p.ownerMailingAddress) !== normalizeAddress(p.situsAddress);
  if (p.ownerMailingAddress.trim() && mailingDiffers && !p.homestead) {
    add('absentee_owner', 25, 'Owner receives tax mail at another address and claims no homestead here.', [
      'ownerMailingAddress',
      'situsAddress',
      'homestead',
    ]);
    const home = (focus.homeState ?? 'FL').toUpperCase();
    const state = p.ownerMailingState.trim().toUpperCase();
    if (state && state !== home) {
      add('out_of_state_owner', 10, `Owner's mailing address is outside Florida (${state}).`, ['ownerMailingState']);
    }
  }

  if (/\b(ESTATE OF|EST OF)\b|\bESTATE\b$/.test(p.ownerName.toUpperCase())) {
    add('estate_owner', 15, 'Owner of record is listed as an estate.', ['ownerName']);
  }

  if (p.justValue && p.assessedValue && p.justValue > 0 && p.assessedValue > 0 && p.assessedValue < p.justValue) {
    const ratio = p.assessedValue / p.justValue;
    const capNote = p.homestead
      ? "Florida's 3% Save Our Homes cap only builds a gap like this over many years of ownership."
      : "Florida's 10% cap on non-homestead increases only builds a gap like this over years of ownership.";
    const text = `Assessed at ${pct(ratio)} of market value. ${capNote}`;
    const facts: (keyof ParcelFacts)[] = ['assessedValue', 'justValue', 'homestead'];
    if (p.homestead ? ratio <= 0.5 : ratio <= 0.6) add('long_held_strong', 30, text, facts);
    else if (p.homestead ? ratio <= 0.75 : ratio <= 0.8) add('long_held', 15, text, facts);
  }

  const sale = p.recentSale;
  if (sale && (sale.qualified || (sale.price ?? 0) >= 10_000)) {
    const soldAt = new Date(Date.UTC(sale.year, (sale.month ?? 6) - 1, 15));
    if (asOf.getTime() - soldAt.getTime() < 2 * 365.25 * 24 * 3600 * 1000) {
      const when = sale.month ? `${MONTHS[sale.month - 1]} ${sale.year}` : String(sale.year);
      add('recent_purchase', -30, `Sold in ${when}; a sale is unlikely soon.`, ['recentSale']);
    }
  }

  if (p.justValue !== undefined && (focus.minValue !== undefined || focus.maxValue !== undefined)) {
    const aboveMin = focus.minValue === undefined || p.justValue >= focus.minValue;
    const belowMax = focus.maxValue === undefined || p.justValue <= focus.maxValue;
    if (aboveMin && belowMax) add('value_in_band', 10, "Market value is within the agent's price range.", ['justValue']);
    else add('value_out_of_band', -15, "Market value is outside the agent's price range.", ['justValue']);
  }

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  return {
    eligible: true,
    score: Math.max(0, Math.min(100, raw)),
    confidence: completeness(p),
    reasons,
    version: SCORING_VERSION,
  };
}

/** Share of the scoring inputs that were present (0–1), rounded to 2 decimals. */
function completeness(p: ParcelFacts): number {
  const inputs = [p.justValue, p.assessedValue, p.ownerMailingAddress.trim() || undefined];
  const present = inputs.filter((v) => v !== undefined).length;
  return Math.round((present / inputs.length) * 100) / 100;
}

function normalizeAddress(a: string): string {
  return a
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(APT|UNIT|STE|SUITE)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
