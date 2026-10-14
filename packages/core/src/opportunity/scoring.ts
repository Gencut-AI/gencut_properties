/**
 * Seller-opportunity scoring, version 3.
 *
 * Inputs are property facts from public assessment rolls — never personal or
 * protected characteristics (race, religion, national origin, sex, familial
 * status, disability, age…). The types below have no field for them, and the
 * scorer must not be extended with any proxy for them (Fair Housing Act). The
 * importer does not even read the roll's personal exemptions (seniors,
 * widows, disability, veterans).
 *
 * A score RANKS signals found in public records. It is not a probability that
 * an owner will sell, and its weights have not been validated against
 * outcomes yet (see docs/scoring.md). Every point comes with a plain-language
 * reason and the fact fields it rests on.
 *
 * Tenure: the roll has no purchase date. Florida caps yearly increases in
 * assessed value (3% for homesteads, 10% for other residential) and resets the
 * assessment to market value after a change of ownership, so assessed value
 * far below market value means no sale reset it. One roll cannot tell years of
 * ownership from one sharp revaluation (found in the 14 Oct 2026 cross-check,
 * docs/validation), so v3 claims ownership tenure only when the gap appears in
 * two consecutive rolls.
 */
export const SCORING_VERSION = 'seller-v3';

export const PROPERTY_USES = ['single_family', 'condo', 'townhouse', 'multifamily', 'vacant_land', 'other'] as const;
export type PropertyUse = (typeof PROPERTY_USES)[number];

/** Who the owner of record is, read from the name only. */
export const OWNER_KINDS = ['individual', 'company', 'trust', 'estate'] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

export interface RecentSale {
  readonly year: number;
  /** 1–12 when known. */
  readonly month?: number;
  readonly price?: number;
  /** Arm's-length sale per the roll's qualification code. */
  readonly qualified: boolean;
}

export interface PriorAssessment {
  readonly year: number;
  readonly justValue?: number;
  readonly assessedValue?: number;
  readonly homestead: boolean;
}

/** Normalized parcel facts. Field names are what reasons cite as provenance. */
export interface ParcelFacts {
  readonly parcelId: string;
  readonly countyCode: string;
  readonly situsAddress: string;
  readonly situsCity?: string;
  readonly situsZip: string;
  readonly ownerName: string;
  readonly ownerKind?: OwnerKind;
  readonly ownerMailingAddress: string;
  readonly ownerMailingCity?: string;
  readonly ownerMailingState: string;
  readonly ownerMailingZip?: string;
  /** Homestead exemption on this parcel: the owner declared it their permanent residence. */
  readonly homestead: boolean;
  readonly propertyUse: PropertyUse;
  /** A building of 10 or more residential units. */
  readonly largeBuilding?: boolean;
  /** Market ("just") value. */
  readonly justValue?: number;
  /** Non-school assessed value, after Florida's assessment caps. */
  readonly assessedValue?: number;
  /** The same parcel on the previous year's final roll, when it was read. */
  readonly priorAssessment?: PriorAssessment;
  /** Sales recorded on the current and previous rolls, newest first. */
  readonly recentSales?: readonly RecentSale[];
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
  /** Buildings of 10+ units are left out unless the agent asks for them. */
  readonly includeLargeBuildings?: boolean;
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

/** Reason codes, for filters and labels. */
export const SIGNAL_CODES = [
  'absentee_owner',
  'out_of_state_owner',
  'long_held_strong',
  'long_held',
  'assessment_gap',
  'estate_owner',
] as const;
export type SignalCode = (typeof SIGNAL_CODES)[number];

/**
 * The state roll does not separate townhouses from single-family homes, so a
 * townhouse focus matches single-family parcels.
 */
export function matchesPropertyFocus(use: PropertyUse, focus: readonly PropertyUse[]): boolean {
  return focus.includes(use) || (use === 'single_family' && focus.includes('townhouse'));
}

// A life estate (LIFE EST, LE) is a living owner's interest, not a deceased owner's estate.
const ESTATE = /\b(ESTATE OF|EST OF)\b|(?<!LIFE |REAL )\bESTATE$/;
const COMPANY =
  /\b(LLC|L L C|INC|CORP|CORPORATION|COMPANY|LTD|LP|LLP|PLLC|HOLDINGS?|PROPERT(Y|IES)|INVESTMENTS?|GROUP|PARTNERS(HIP)?|ASSOC(IATION)?|ENTERPRISES?|REALTY|DEVELOPMENT|VENTURES?|FUND|BANK|MANAGEMENT|CAPITAL|TRUST CO|CONDOMINIUM|ASSN)\b/;
const TRUST = /\b(TRUST|TRUSTS|TR|TRS|TRUSTEE|TRUSTEES|TRSTEE)\b/;

/** Classify the owner of record from the name alone. Never a person's traits. */
export function ownerKindOf(name: string): OwnerKind {
  const n = name.toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ESTATE.test(n)) return 'estate';
  if (COMPANY.test(n)) return 'company';
  if (TRUST.test(n)) return 'trust';
  return 'individual';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pct = (r: number) => `${Math.round(r * 100)}%`;
const ratio = (assessed?: number, just?: number) =>
  assessed && just && just > 0 && assessed > 0 ? Math.min(1, assessed / just) : undefined;

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
  if (p.largeBuilding && !focus.includeLargeBuildings) {
    return {
      eligible: false,
      why: 'Building with 10 or more units; turn on large buildings in the profile to include these.',
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

  if ((p.ownerKind ?? ownerKindOf(p.ownerName)) === 'estate') {
    add('estate_owner', 15, 'Owner of record is listed as an estate.', ['ownerName']);
  }

  addTenure(p, add);

  const sale = p.recentSales?.find((s) => s.qualified || (s.price ?? 0) >= 10_000);
  if (sale) {
    const soldAt = new Date(Date.UTC(sale.year, (sale.month ?? 6) - 1, 15));
    if (asOf.getTime() - soldAt.getTime() < 3 * 365.25 * 24 * 3600 * 1000) {
      const when = sale.month ? `${MONTHS[sale.month - 1]} ${sale.year}` : String(sale.year);
      add('recent_purchase', -30, `Sold in ${when}; a sale is unlikely soon.`, ['recentSales']);
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

/** Long-ownership reasons from the assessment gap, claimed only as far as the rolls support. */
function addTenure(
  p: ParcelFacts,
  add: (code: string, points: number, text: string, facts: (keyof ParcelFacts)[]) => void,
): void {
  const now = ratio(p.assessedValue, p.justValue);
  if (now === undefined) return;
  // A homestead's 3% cap builds a gap more slowly than the 10% non-homestead cap.
  const deep = p.homestead ? 0.5 : 0.6;
  const wide = p.homestead ? 0.75 : 0.8;
  if (now > wide) return;

  const prior = p.priorAssessment;
  const before = prior ? ratio(prior.assessedValue, prior.justValue) : undefined;
  const facts: (keyof ParcelFacts)[] = ['assessedValue', 'justValue', 'homestead', 'priorAssessment'];
  if (prior && before !== undefined) {
    const both = `Assessed at ${pct(now)} of market value now and ${pct(before)} on the ${prior.year} roll.`;
    const why =
      ' Florida resets the assessment when a property changes hands, so no sale has reset it for at least two years.';
    if (now <= deep && before <= deep + 0.1) add('long_held_strong', 30, both + why, facts);
    else if (before <= wide + 0.1) add('long_held', 15, both + why, facts);
    // A gap that appeared only this year comes from a revaluation, not tenure: no points.
    return;
  }
  if (now <= deep) {
    add(
      'assessment_gap',
      10,
      `Assessed at ${pct(now)} of market value. One roll cannot show how long the owner has held it.`,
      ['assessedValue', 'justValue', 'homestead'],
    );
  }
}

/** Share of the scoring inputs that were present (0–1), rounded to 2 decimals. */
function completeness(p: ParcelFacts): number {
  const inputs = [p.justValue, p.assessedValue, p.ownerMailingAddress.trim() || undefined, p.priorAssessment];
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
