/**
 * Florida Department of Revenue Name-Address-Legal (NAL) assessment roll.
 *
 * The roll is a public record (Fla. Stat. ch. 119) published by the DOR Property
 * Tax Oversight program for every county, once as a preliminary roll (summer)
 * and again as a final roll (autumn). This module holds the pure parts of the
 * adapter: which file to use, and how a CSV row becomes a stored parcel and
 * then scoring facts. Fetching and unzipping live in the worker.
 *
 * Only residential parcels are kept, and only the columns GenCut uses. Owners
 * whose records are confidential (blank owner name) are dropped at import.
 */
import type { ParcelFacts, PropertyUse } from '../opportunity/scoring.ts';

export const FL_DOR_NAL_SOURCE_KEY = 'fl-dor-nal';

export const FL_COUNTIES = [
  { code: '23', name: 'Miami-Dade', filePrefix: 'dade' },
  { code: '16', name: 'Broward', filePrefix: 'broward' },
  { code: '60', name: 'Palm Beach', filePrefix: 'palm beach' },
] as const;
export type FlCountyCode = (typeof FL_COUNTIES)[number]['code'];

export function flCounty(code: string) {
  return FL_COUNTIES.find((c) => c.code === code);
}

/** DOR land-use codes 000–008 are residential; 009 (common elements) and above are not parcels we score. */
const USE_CODES: Readonly<Record<string, PropertyUse>> = {
  '000': 'vacant_land',
  '001': 'single_family',
  '002': 'other', // mobile home
  '003': 'multifamily', // 10 or more units
  '004': 'condo',
  '005': 'condo', // cooperative
  '006': 'other', // retirement home
  '007': 'other', // miscellaneous residential
  '008': 'multifamily', // fewer than 10 units
};

export const DOR_USE_LABELS: Readonly<Record<string, string>> = {
  '000': 'Vacant residential',
  '001': 'Single family',
  '002': 'Mobile home',
  '003': 'Multifamily, 10+ units',
  '004': 'Condominium',
  '005': 'Cooperative',
  '006': 'Retirement home',
  '007': 'Miscellaneous residential',
  '008': 'Multifamily, under 10 units',
};

export interface RollFile {
  readonly name: string;
  readonly serverRelativeUrl: string;
  readonly length: number;
  readonly lastModified: string;
}

export interface RollChoice {
  readonly file: RollFile;
  readonly year: number;
  readonly stage: 'final' | 'preliminary';
  /** e.g. "2026 preliminary roll". */
  readonly label: string;
  /** The file's publication date (YYYY-MM-DD), used as the records' file date. */
  readonly fileDate: string;
}

/** The DOR folders to look in, newest first: e.g. NAL/2026F, NAL/2026P, NAL/2025F. */
export function rollFolders(asOf: Date): string[] {
  const y = asOf.getUTCFullYear();
  return [`${y}F`, `${y}P`, `${y - 1}F`];
}

/**
 * Pick the county's newest roll file from DOR folder listings: the latest year,
 * and the final roll over the preliminary one.
 */
export function pickRollFile(files: readonly RollFile[], countyCode: string): RollChoice | null {
  const county = flCounty(countyCode);
  if (!county) return null;
  const choices: RollChoice[] = [];
  for (const file of files) {
    const n = file.name.toLowerCase();
    if (!n.endsWith('.zip') || !n.startsWith(county.filePrefix) || !/\bnal\b/.test(n)) continue;
    const year = Number(/\b(20\d\d)\b/.exec(n)?.[1]);
    const stage = /\bfinal\b/.test(n) ? 'final' : /\bprelim/.test(n) ? 'preliminary' : null;
    if (!year || !stage) continue;
    choices.push({ file, year, stage, label: `${year} ${stage} roll`, fileDate: file.lastModified.slice(0, 10) });
  }
  choices.sort((a, b) => b.year - a.year || (a.stage === b.stage ? 0 : a.stage === 'final' ? -1 : 1));
  return choices[0] ?? null;
}

/** What GenCut stores per parcel (source_records.payload). Keys are stable; never add protected characteristics. */
export interface StoredParcel {
  readonly parcelId: string;
  readonly countyCode: string;
  readonly assessmentYear: number | null;
  readonly useCode: string;
  readonly situs: { readonly address: string; readonly city: string; readonly zip: string };
  readonly owner: {
    readonly name: string;
    readonly address1: string;
    readonly address2: string;
    readonly city: string;
    readonly state: string;
    readonly zip: string;
  };
  readonly justValue: number | null;
  /** Non-school assessed value: carries both the homestead and the 10% non-homestead caps. */
  readonly assessedValue: number | null;
  readonly homestead: boolean;
  readonly sale: {
    readonly year: number;
    readonly month: number | null;
    readonly price: number | null;
    readonly qualificationCode: string;
  } | null;
  readonly units: number | null;
  readonly yearBuilt: number | null;
  readonly livingArea: number | null;
}

const text = (v: string | undefined) => (v ?? '').trim();
function int(v: string | undefined): number | null {
  const t = text(v);
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t));
}

/** Header names → column positions, for fast row access. */
export function headerIndex(header: readonly string[]): Map<string, number> {
  return new Map(header.map((h, i) => [h.trim().toUpperCase(), i]));
}

export const REQUIRED_COLUMNS = ['CO_NO', 'PARCEL_ID', 'DOR_UC', 'PHY_ADDR1', 'PHY_ZIPCD', 'OWN_NAME', 'OWN_ADDR1', 'JV', 'AV_NSD', 'JV_HMSTD'];

export function missingColumns(index: Map<string, number>): string[] {
  return REQUIRED_COLUMNS.filter((c) => !index.has(c));
}

/** Situs ZIP of a raw row (first five digits), for filtering before full parsing. */
export function rowZip(fields: readonly string[], index: Map<string, number>): string {
  return text(fields[index.get('PHY_ZIPCD') ?? -1]).slice(0, 5);
}

/**
 * Turn one NAL row into a stored parcel, or null if GenCut does not keep it:
 * non-residential, missing identity, or a confidential owner record.
 */
export function nalRowToParcel(fields: readonly string[], index: Map<string, number>): StoredParcel | null {
  const get = (k: string) => fields[index.get(k) ?? -1];
  const useCode = text(get('DOR_UC')).padStart(3, '0');
  if (!(useCode in USE_CODES)) return null;
  const parcelId = text(get('PARCEL_ID'));
  const zip = text(get('PHY_ZIPCD')).slice(0, 5);
  const ownerName = text(get('OWN_NAME'));
  if (!parcelId || !/^\d{5}$/.test(zip) || !ownerName) return null;

  const saleYear = int(get('SALE_YR1'));
  const month = int(get('SALE_MO1'));
  const hmstd = int(get('JV_HMSTD'));
  return {
    parcelId,
    countyCode: text(get('CO_NO')),
    assessmentYear: int(get('ASMNT_YR')),
    useCode,
    situs: { address: text(get('PHY_ADDR1')), city: text(get('PHY_CITY')), zip },
    owner: {
      name: ownerName,
      address1: text(get('OWN_ADDR1')),
      address2: text(get('OWN_ADDR2')),
      city: text(get('OWN_CITY')),
      state: text(get('OWN_STATE')).toUpperCase(),
      zip: text(get('OWN_ZIPCD')).slice(0, 5),
    },
    justValue: int(get('JV')),
    assessedValue: int(get('AV_NSD')),
    homestead: hmstd !== null && hmstd > 0,
    sale: saleYear
      ? {
          year: saleYear,
          month: month && month >= 1 && month <= 12 ? month : null,
          price: int(get('SALE_PRC1')),
          qualificationCode: text(get('QUAL_CD1')),
        }
      : null,
    units: int(get('NO_RES_UNTS')),
    yearBuilt: int(get('ACT_YR_BLT')) || null,
    livingArea: int(get('TOT_LVG_AREA')) || null,
  };
}

export function propertyUseOf(useCode: string): PropertyUse {
  return USE_CODES[useCode] ?? 'other';
}

/**
 * DOR sale qualification codes 01–05 mark arm's-length sales; 11 and above are
 * transfers the appraiser excluded (family, corporate, nominal consideration…).
 */
export function isQualifiedSale(code: string): boolean {
  return /^0[1-5]$/.test(code);
}

/** Scoring facts for a stored parcel. */
export function parcelFacts(p: StoredParcel): ParcelFacts {
  return {
    parcelId: p.parcelId,
    countyCode: p.countyCode,
    situsAddress: p.situs.address,
    situsZip: p.situs.zip,
    ownerName: p.owner.name,
    // Line 1 is the street line; line 2 often holds a unit or a care-of name.
    ownerMailingAddress: p.owner.address1,
    ownerMailingState: p.owner.state,
    homestead: p.homestead,
    propertyUse: propertyUseOf(p.useCode),
    ...(p.situs.city ? { situsCity: p.situs.city } : {}),
    ...(p.owner.city ? { ownerMailingCity: p.owner.city } : {}),
    ...(p.owner.zip ? { ownerMailingZip: p.owner.zip } : {}),
    ...(p.justValue ? { justValue: p.justValue } : {}),
    ...(p.assessedValue ? { assessedValue: p.assessedValue } : {}),
    ...(p.units ? { units: p.units } : {}),
    ...(p.yearBuilt ? { yearBuilt: p.yearBuilt } : {}),
    ...(p.livingArea ? { livingArea: p.livingArea } : {}),
    ...(p.sale
      ? {
          recentSale: {
            year: p.sale.year,
            qualified: isQualifiedSale(p.sale.qualificationCode),
            ...(p.sale.month ? { month: p.sale.month } : {}),
            ...(p.sale.price !== null ? { price: p.sale.price } : {}),
          },
        }
      : {}),
  };
}
