/**
 * Florida's company register (Division of Corporations, "Sunbiz"): who is
 * behind a company that bought homes (D-028).
 *
 * The Department of State publishes every corporation, LLC and partnership
 * as fixed-width records of 1,440 characters (quarterly file `cordata.zip`;
 * layout: "Corporate Data File Structure"). GenCut reads only what helps an
 * agent reach a person at a buying company: the registered name, status and
 * type, the principal and mailing addresses (business addresses), the
 * registered agent's name, and the names and titles of up to six officers or
 * managers. Officers' own addresses, the agent's address and the federal tax
 * number are not read.
 */
import { ownerKey } from '../buyers/buyer-radar.ts';

export const FL_SUNBIZ_SOURCE_KEY = 'fl-sunbiz-cor';
export const SUNBIZ_RECORD_LENGTH = 1440;
/** The DOR roll stores owner names in 30 characters; longer company names are cut. */
export const ROLL_OWNER_NAME_MAX = 30;

export interface CompanyAddress {
  readonly address1: string;
  readonly address2: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly country: string;
}

export type RegistryPartyType = 'person' | 'company' | null;

export interface CompanyOfficer {
  /** The title code as filed, e.g. MGR, AMBR, P, PD. */
  readonly title: string;
  readonly type: RegistryPartyType;
  /** As filed, usually LAST FIRST. */
  readonly name: string;
}

export interface CompanyRecord {
  readonly state: 'FL';
  readonly documentNumber: string;
  readonly name: string;
  /** The same key Buyer Radar groups owner names by (`ownerKey`). */
  readonly nameKey: string;
  readonly status: 'active' | 'inactive';
  /** Filing type code, e.g. FLAL (Florida LLC), DOMP, FORL. */
  readonly filingType: string;
  readonly principal: CompanyAddress;
  readonly mailing: CompanyAddress;
  /** YYYY-MM-DD, or null when the record has no valid date. */
  readonly filedOn: string | null;
  readonly lastTransactionOn: string | null;
  /** Years of the annual reports on the record, newest first. */
  readonly reportYears: readonly number[];
  readonly registeredAgent: { readonly name: string; readonly type: RegistryPartyType } | null;
  readonly officers: readonly CompanyOfficer[];
  /** The record says the company has more than six officers; only six are in the file. */
  readonly moreOfficers: boolean;
}

/** 1-based start and length, as in the Department of State's layout. */
const field = (line: string, start: number, length: number) => line.slice(start - 1, start - 1 + length).trim();

const address = (line: string, at: readonly [number, number, number, number, number, number]): CompanyAddress => ({
  address1: field(line, at[0], 42),
  address2: field(line, at[1], 42),
  city: field(line, at[2], 28),
  state: field(line, at[3], 2).toUpperCase(),
  zip: field(line, at[4], 10).replace(/-?0000$/, ''),
  country: field(line, at[5], 2).toUpperCase(),
});

/** MMDDYYYY → YYYY-MM-DD, or null. */
export function sunbizDate(raw: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.getUTCMonth() + 1 !== Number(mm) || d.getUTCDate() !== Number(dd) ? null : `${yyyy}-${mm}-${dd}`;
}

const partyType = (raw: string): RegistryPartyType => (raw === 'P' ? 'person' : raw === 'C' ? 'company' : null);

const OFFICER_START = 669;
const OFFICER_WIDTH = 128;

/**
 * One record of the corporate data file, or null when the line is not a
 * record (too short, no document number or no name). Trailing CR/LF is ignored.
 */
export function parseSunbizRecord(rawLine: string): CompanyRecord | null {
  const line = rawLine.replace(/[\r\n]+$/, '');
  if (line.length < OFFICER_START - 1) return null;
  const documentNumber = field(line, 1, 12);
  const name = field(line, 13, 192);
  if (!documentNumber || !name) return null;

  const officers: CompanyOfficer[] = [];
  for (let i = 0; i < 6; i++) {
    const at = OFFICER_START + i * OFFICER_WIDTH;
    const officerName = field(line, at + 5, 42);
    if (!officerName) continue;
    officers.push({ title: field(line, at, 4).toUpperCase(), type: partyType(field(line, at + 4, 1)), name: officerName });
  }
  const reportYears = [field(line, 506, 4), field(line, 519, 4), field(line, 532, 4)]
    .filter((y) => /^\d{4}$/.test(y))
    .map(Number)
    .sort((a, b) => b - a);
  const agentName = field(line, 545, 42);

  return {
    state: 'FL',
    documentNumber,
    name,
    nameKey: ownerKey(name),
    status: field(line, 205, 1) === 'A' ? 'active' : 'inactive',
    filingType: field(line, 206, 15).toUpperCase(),
    principal: address(line, [221, 263, 305, 333, 335, 345]),
    mailing: address(line, [347, 389, 431, 459, 461, 471]),
    filedOn: sunbizDate(field(line, 473, 8)),
    lastTransactionOn: sunbizDate(field(line, 496, 8)),
    reportYears: [...new Set(reportYears)],
    registeredAgent: agentName ? { name: agentName, type: partyType(field(line, 587, 1)) } : null,
    officers,
    moreOfficers: field(line, 495, 1).toUpperCase() === 'Y',
  };
}

const FILING_TYPES: Readonly<Record<string, string>> = {
  FLAL: 'Florida LLC',
  FORL: 'Out-of-state LLC registered in Florida',
  DOMP: 'Florida corporation',
  FORP: 'Out-of-state corporation registered in Florida',
  DOMLP: 'Florida limited partnership',
  FORLP: 'Out-of-state limited partnership registered in Florida',
  DOMNP: 'Florida nonprofit corporation',
  FORNP: 'Out-of-state nonprofit corporation registered in Florida',
  TRUST: 'Business trust',
};

export function filingTypeLabel(code: string): string {
  return FILING_TYPES[code] ?? code;
}

const TITLE_WORDS: Readonly<Record<string, string>> = {
  MGR: 'Manager',
  MANA: 'Manager',
  MGRM: 'Managing member',
  AMBR: 'Authorized member',
  AMB: 'Authorized member',
  MBR: 'Member',
  MEMB: 'Member',
  AUTH: 'Authorized person',
  AP: 'Authorized person',
  CEO: 'Chief executive officer',
  CFO: 'Chief financial officer',
  COO: 'Chief operating officer',
  PRES: 'President',
  VP: 'Vice president',
  SEC: 'Secretary',
  SECR: 'Secretary',
  TREA: 'Treasurer',
  TRES: 'Treasurer',
  DIR: 'Director',
  CHAI: 'Chairman',
  GP: 'General partner',
  OWNE: 'Owner',
  PRIN: 'Principal',
};
const LETTERS: Readonly<Record<string, string>> = { P: 'President', T: 'Treasurer', C: 'Chairman', V: 'Vice president', S: 'Secretary', D: 'Director' };

/** A title code as words: MGR → Manager, PD → President, director. Unknown codes are shown as filed. */
export function officerTitleLabel(code: string): string {
  const c = code.trim().toUpperCase();
  if (!c) return 'Officer';
  if (TITLE_WORDS[c]) return TITLE_WORDS[c];
  if (/^[PTCVSD]{1,4}$/.test(c)) {
    const words = [...new Set([...c].map((l) => LETTERS[l]!.toLowerCase()))];
    const text = words.join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return c;
}

export type CompanyMatchKind = 'exact' | 'shortened';

export interface CompanyMatch {
  readonly record: CompanyRecord;
  /** `shortened`: the roll's name was cut at 30 characters and only this company's registered name starts with it. */
  readonly match: CompanyMatchKind;
}

const newest = (r: CompanyRecord) => r.lastTransactionOn ?? r.filedOn ?? '';
const byPreference = (a: CompanyRecord, b: CompanyRecord) =>
  (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || newest(b).localeCompare(newest(a)) || a.documentNumber.localeCompare(b.documentNumber);

/**
 * The register record for an owner name on the roll. An exact name match wins
 * (an active company first, then the most recently updated). When there is
 * none and the roll's name fills its 30 characters, a company whose name
 * starts with it is used only if it is the only active one, or the only one.
 */
export function pickCompanyRecord(rollName: string, candidates: readonly CompanyRecord[]): CompanyMatch | null {
  const key = ownerKey(rollName);
  if (!key) return null;
  const exact = candidates.filter((c) => c.nameKey === key).sort(byPreference);
  if (exact[0]) return { record: exact[0], match: 'exact' };
  if (rollName.trim().length < ROLL_OWNER_NAME_MAX) return null;
  const longer = candidates.filter((c) => c.nameKey.startsWith(key));
  const active = longer.filter((c) => c.status === 'active');
  const only = active.length === 1 ? active[0] : active.length === 0 && longer.length === 1 ? longer[0] : undefined;
  return only ? { record: only, match: 'shortened' } : null;
}

/** People listed on the record (officers who are persons), in filed order, with their titles as words. */
export function peopleOnRecord(r: Pick<CompanyRecord, 'officers'>): { name: string; title: string }[] {
  return r.officers.filter((o) => o.type !== 'company').map((o) => ({ name: o.name, title: officerTitleLabel(o.title) }));
}
