/**
 * Seller-opportunity scoring, version 1.
 *
 * Inputs are property facts from public assessment rolls — never personal or
 * protected characteristics (race, religion, national origin, sex, familial
 * status, disability, age…). The type below has no field for them, and the
 * scorer must not be extended with any proxy for them (Fair Housing Act).
 *
 * Weights are an explicit, documented heuristic. They are a baseline for the
 * learning loop to evaluate against recorded campaign outcomes, not a claim
 * that they predict listings. Every point comes with a plain-language reason
 * and the fact fields it rests on, so the user can see why GenCut chose it.
 */
export const SCORING_VERSION = 'seller-v1';

export const PROPERTY_USES = ['single_family', 'condo', 'townhouse', 'multifamily', 'vacant_land', 'other'] as const;
export type PropertyUse = (typeof PROPERTY_USES)[number];

/** Normalized parcel facts. Field names are what reasons cite as provenance. */
export interface ParcelFacts {
  readonly parcelId: string;
  readonly countyCode: string;
  readonly situsAddress: string;
  readonly situsZip: string;
  readonly ownerMailingAddress: string;
  readonly ownerMailingState: string;
  readonly ownerMailingZip: string;
  readonly homesteadExemption: boolean;
  readonly propertyUse: PropertyUse;
  readonly justValue?: number;
  /** ISO date (YYYY-MM-DD) of the most recent qualified sale. */
  readonly lastSaleDate?: string;
  readonly lastSalePrice?: number;
  /** Owner record is confidential under Fla. Stat. 119.071; never surfaced. */
  readonly confidential?: boolean;
}

/** What the agent told GenCut about their business. */
export interface AgentFocus {
  readonly zips: readonly string[];
  readonly propertyUses: readonly PropertyUse[];
  readonly minValue?: number;
  readonly maxValue?: number;
  /** Florida resident agents usually serve owners anywhere; kept for clarity. */
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

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export function scoreSellerOpportunity(p: ParcelFacts, focus: AgentFocus, asOf: Date): ScoreResult {
  if (p.confidential) {
    return { eligible: false, why: 'Owner record is confidential under Florida law.', version: SCORING_VERSION };
  }
  if (!focus.zips.includes(p.situsZip)) {
    return { eligible: false, why: `ZIP ${p.situsZip} is outside the agent's focus area.`, version: SCORING_VERSION };
  }
  if (!focus.propertyUses.includes(p.propertyUse)) {
    return {
      eligible: false,
      why: `Property type ${p.propertyUse} is outside the agent's specialty.`,
      version: SCORING_VERSION,
    };
  }

  const reasons: ScoreReason[] = [];
  const add = (code: string, points: number, text: string, facts: (keyof ParcelFacts)[]) =>
    reasons.push({ code, points, text, facts });

  // Base: in the agent's area and specialty.
  add('in_focus', 20, `In the agent's focus area (${p.situsZip}) and property type.`, ['situsZip', 'propertyUse']);

  const mailingDiffers = normalizeAddress(p.ownerMailingAddress) !== normalizeAddress(p.situsAddress);
  if (mailingDiffers && !p.homesteadExemption) {
    add('absentee_owner', 25, 'Owner receives tax mail elsewhere and claims no homestead here.', [
      'ownerMailingAddress',
      'situsAddress',
      'homesteadExemption',
    ]);
    if (p.ownerMailingState.trim().toUpperCase() !== (focus.homeState ?? 'FL')) {
      add('out_of_state_owner', 10, `Owner's mailing address is in ${p.ownerMailingState}.`, ['ownerMailingState']);
    }
  }

  const years = p.lastSaleDate ? yearsBetween(p.lastSaleDate, asOf) : undefined;
  if (years !== undefined) {
    if (years >= 20) {
      add('very_long_tenure', 30, `Last sold ${Math.floor(years)} years ago.`, ['lastSaleDate']);
    } else if (years >= 10) {
      add('long_tenure', 20, `Last sold ${Math.floor(years)} years ago.`, ['lastSaleDate']);
    } else if (years < 2) {
      add('recent_purchase', -30, 'Bought within the last two years; a sale is unlikely soon.', ['lastSaleDate']);
    }
  }

  if (p.justValue !== undefined && p.lastSalePrice !== undefined && p.lastSalePrice > 0) {
    const ratio = p.justValue / p.lastSalePrice;
    if (ratio >= 2) {
      add('value_growth', 15, `Assessed value is ${ratio.toFixed(1)}× the last sale price.`, [
        'justValue',
        'lastSalePrice',
      ]);
    }
  }

  if (p.justValue !== undefined && (focus.minValue !== undefined || focus.maxValue !== undefined)) {
    const aboveMin = focus.minValue === undefined || p.justValue >= focus.minValue;
    const belowMax = focus.maxValue === undefined || p.justValue <= focus.maxValue;
    if (aboveMin && belowMax) {
      add('value_in_band', 10, "Value is within the agent's price range.", ['justValue']);
    } else {
      add('value_out_of_band', -15, "Value is outside the agent's price range.", ['justValue']);
    }
  }

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { eligible: true, score, confidence: completeness(p), reasons, version: SCORING_VERSION };
}

/** Share of the optional facts that were present (0–1), rounded to 2 decimals. */
function completeness(p: ParcelFacts): number {
  const optional = [p.justValue, p.lastSaleDate, p.lastSalePrice];
  const present = optional.filter((v) => v !== undefined).length;
  return Math.round((present / optional.length) * 100) / 100;
}

function yearsBetween(isoDate: string, asOf: Date): number | undefined {
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return undefined;
  return (asOf.getTime() - t) / MS_PER_YEAR;
}

function normalizeAddress(a: string): string {
  return a
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
