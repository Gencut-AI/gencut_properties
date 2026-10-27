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
import { type OwnerKind, type ParcelFacts, type PropertyUse, type RecentSale, ownerKindOf } from '../opportunity/scoring.ts';

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

/** The county's final roll for the year before `current`, to read last year's values. */
export function pickPriorRollFile(files: readonly RollFile[], countyCode: string, currentYear: number): RollChoice | null {
  const prior = pickRollFile(
    files.filter((f) => /\bfinal\b/i.test(f.name) && f.name.includes(String(currentYear - 1))),
    countyCode,
  );
  return prior && prior.year === currentYear - 1 && prior.stage === 'final' ? prior : null;
}

export interface StoredSale {
  readonly year: number;
  readonly month: number | null;
  readonly price: number | null;
  readonly qualificationCode: string;
}

/** The parcel on the previous year's final roll: only what tenure and sales need. */
export interface PriorRoll {
  readonly year: number;
  readonly justValue: number | null;
  readonly assessedValue: number | null;
  readonly homestead: boolean;
  readonly sales: readonly StoredSale[];
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
  /** Sales on the current roll's two sale slots, newest first. */
  readonly sales: readonly StoredSale[];
  /** Same parcel on the previous final roll, when it was read. */
  readonly prior: PriorRoll | null;
  readonly ownerKind: OwnerKind;
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

/**
 * Exemptions that mark an institutional owner (charitable, religious,
 * educational, hospital, government, affordable-housing and similar): DOR NAL
 * fields EXMPT_09–21, 29, 30, 36, 37 and 42–46 (2025 NAL user's guide). Such
 * parcels are not seller opportunities. Personal exemptions (seniors, widows,
 * blind or disabled owners, veterans) are proxies for protected
 * characteristics: they are deliberately never read.
 */
export const INSTITUTIONAL_EXEMPTIONS = [
  'EXMPT_09', 'EXMPT_10', 'EXMPT_11', 'EXMPT_12', 'EXMPT_13', 'EXMPT_14', 'EXMPT_15', 'EXMPT_16', 'EXMPT_17',
  'EXMPT_18', 'EXMPT_19', 'EXMPT_20', 'EXMPT_21', 'EXMPT_29', 'EXMPT_30', 'EXMPT_36', 'EXMPT_37', 'EXMPT_42',
  'EXMPT_43', 'EXMPT_44', 'EXMPT_45', 'EXMPT_46',
] as const;

export function missingColumns(index: Map<string, number>): string[] {
  return REQUIRED_COLUMNS.filter((c) => !index.has(c));
}

/** Situs ZIP of a raw row (first five digits), for filtering before full parsing. */
export function rowZip(fields: readonly string[], index: Map<string, number>): string {
  return text(fields[index.get('PHY_ZIPCD') ?? -1]).slice(0, 5);
}

/**
 * The situs ZIP of a residential row (a use code GenCut imports), or null. A
 * cheap check, run on every row of a county roll to know which ZIP codes have
 * homes at all; it does not apply the import's other exclusions.
 */
export function residentialZip(fields: readonly string[], index: Map<string, number>): string | null {
  const useCode = text(fields[index.get('DOR_UC') ?? -1]).padStart(3, '0');
  if (!(useCode in USE_CODES)) return null;
  const zip = rowZip(fields, index);
  return /^\d{5}$/.test(zip) ? zip : null;
}

function readSales(get: (k: string) => string | undefined): StoredSale[] {
  const sales: StoredSale[] = [];
  for (const n of ['1', '2']) {
    const year = int(get(`SALE_YR${n}`));
    if (!year) continue;
    const month = int(get(`SALE_MO${n}`));
    sales.push({
      year,
      month: month && month >= 1 && month <= 12 ? month : null,
      price: int(get(`SALE_PRC${n}`)),
      qualificationCode: text(get(`QUAL_CD${n}`)),
    });
  }
  return sales.sort((a, b) => b.year - a.year || (b.month ?? 0) - (a.month ?? 0));
}

function hasInstitutionalExemption(get: (k: string) => string | undefined): boolean {
  return INSTITUTIONAL_EXEMPTIONS.some((k) => (int(get(k)) ?? 0) > 0);
}

/**
 * Turn one NAL row into a stored parcel, or null if GenCut does not keep it:
 * non-residential, missing identity, a confidential owner record, or an
 * institutional owner.
 */
export function nalRowToParcel(
  fields: readonly string[],
  index: Map<string, number>,
  prior: PriorRoll | null = null,
): StoredParcel | null {
  const get = (k: string) => fields[index.get(k) ?? -1];
  const useCode = text(get('DOR_UC')).padStart(3, '0');
  if (!(useCode in USE_CODES)) return null;
  const parcelId = text(get('PARCEL_ID'));
  const zip = text(get('PHY_ZIPCD')).slice(0, 5);
  const ownerName = text(get('OWN_NAME'));
  if (!parcelId || !/^\d{5}$/.test(zip) || !ownerName) return null;
  if (hasInstitutionalExemption(get)) return null;

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
    ownerKind: ownerKindOf(ownerName),
    justValue: int(get('JV')),
    assessedValue: int(get('AV_NSD')),
    homestead: hmstd !== null && hmstd > 0,
    sales: readSales(get),
    prior,
    units: int(get('NO_RES_UNTS')),
    yearBuilt: int(get('ACT_YR_BLT')) || null,
    livingArea: int(get('TOT_LVG_AREA')) || null,
  };
}

/** Last year's values and sales for one parcel, from the previous final roll. */
export function nalRowToPrior(
  fields: readonly string[],
  index: Map<string, number>,
): { parcelId: string; prior: PriorRoll } | null {
  const get = (k: string) => fields[index.get(k) ?? -1];
  const parcelId = text(get('PARCEL_ID'));
  const year = int(get('ASMNT_YR'));
  if (!parcelId || !year) return null;
  const hmstd = int(get('JV_HMSTD'));
  return {
    parcelId,
    prior: {
      year,
      justValue: int(get('JV')),
      assessedValue: int(get('AV_NSD')),
      homestead: hmstd !== null && hmstd > 0,
      sales: readSales(get),
    },
  };
}

export function propertyUseOf(useCode: string): PropertyUse {
  return USE_CODES[useCode] ?? 'other';
}

/**
 * DOR sale qualification codes 01–06 are qualified sales (01–02 used in ratio
 * studies, 03–06 qualified but excluded); 11–43 are transfers the appraiser
 * disqualified (family, corporate, nominal consideration…); 98–99 pending.
 * Source: 2025 NAL/SDF/NAP user's guide.
 */
export function isQualifiedSale(code: string): boolean {
  return /^0[1-6]$/.test(code);
}

/** True for a building of 10 or more residential units. */
export function isLargeBuilding(p: Pick<StoredParcel, 'useCode' | 'units'>): boolean {
  return p.useCode === '003' || (p.units ?? 0) >= 10;
}

function toRecentSale(s: StoredSale): RecentSale {
  return {
    year: s.year,
    qualified: isQualifiedSale(s.qualificationCode),
    ...(s.month ? { month: s.month } : {}),
    ...(s.price !== null ? { price: s.price } : {}),
  };
}

/**
 * Scoring facts for a stored parcel. Accepts payloads stored before v3 of the
 * importer (one `sale`, no prior roll, no owner kind) until they are re-imported.
 */
export function parcelFacts(stored: StoredParcel): ParcelFacts {
  const p = stored as StoredParcel & { sale?: StoredSale | null };
  const current = p.sales ?? (p.sale ? [p.sale] : []);
  const sales = [...current, ...(p.prior?.sales ?? [])]
    .filter((s, i, all) => all.findIndex((t) => t.year === s.year && t.month === s.month && t.price === s.price) === i)
    .sort((a, b) => b.year - a.year || (b.month ?? 0) - (a.month ?? 0))
    .map(toRecentSale);
  return {
    parcelId: p.parcelId,
    countyCode: p.countyCode,
    situsAddress: p.situs.address,
    situsZip: p.situs.zip,
    ownerName: p.owner.name,
    ownerKind: p.ownerKind ?? ownerKindOf(p.owner.name),
    // Line 1 is the street line; line 2 often holds a unit or a care-of name.
    ownerMailingAddress: p.owner.address1,
    ownerMailingState: p.owner.state,
    homestead: p.homestead,
    propertyUse: propertyUseOf(p.useCode),
    largeBuilding: isLargeBuilding(p),
    recentSales: sales,
    ...(p.situs.city ? { situsCity: p.situs.city } : {}),
    ...(p.owner.city ? { ownerMailingCity: p.owner.city } : {}),
    ...(p.owner.zip ? { ownerMailingZip: p.owner.zip } : {}),
    ...(p.justValue ? { justValue: p.justValue } : {}),
    ...(p.assessedValue ? { assessedValue: p.assessedValue } : {}),
    ...(p.units ? { units: p.units } : {}),
    ...(p.yearBuilt ? { yearBuilt: p.yearBuilt } : {}),
    ...(p.livingArea ? { livingArea: p.livingArea } : {}),
    ...(p.prior
      ? {
          priorAssessment: {
            year: p.prior.year,
            homestead: p.prior.homestead,
            ...(p.prior.justValue ? { justValue: p.prior.justValue } : {}),
            ...(p.prior.assessedValue ? { assessedValue: p.prior.assessedValue } : {}),
          },
        }
      : {}),
  };
}

/** DOR use codes stored for a GenCut property type (townhouses are single-family on the roll). */
export function useCodesFor(use: PropertyUse): string[] {
  const target = use === 'townhouse' ? 'single_family' : use;
  return Object.entries(USE_CODES)
    .filter(([, u]) => u === target)
    .map(([code]) => code);
}
