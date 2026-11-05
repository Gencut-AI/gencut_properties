/**
 * Florida company register records for the companies that bought homes
 * (D-028): imported from the Department of State's quarterly file, matched to
 * the owner names on stored roll purchases, and shown with a buyer.
 *
 * Register records are public, shared by every workspace; only companies that
 * appear as owners on stored purchases are kept.
 */

import { type CompanyMatch, type CompanyRecord, ROLL_OWNER_NAME_MAX, pickCompanyRecord } from '@gencut/core';
import type { Db, Sql } from './db.ts';

const STATE = 'FL';
const STALE_CLAIM = '2 hours';
const RETRY_FAILED_AFTER = '6 hours';

/**
 * True when the register file has not been imported yet, its last import failed
 * long enough ago, or a roll import finished after it (new buyers to look up).
 */
export async function companyImportDue(sql: Sql, sourceFile: string): Promise<boolean> {
  const [row] = await sql<{ due: boolean }[]>`
    SELECT NOT EXISTS (
      SELECT 1 FROM company_imports c
      WHERE c.state = ${STATE} AND c.source_file = ${sourceFile} AND (
        (c.status = 'ready' AND c.finished_at >= coalesce((SELECT max(finished_at) FROM transaction_imports WHERE status = 'ready'), '-infinity'))
        OR (c.status = 'importing' AND c.started_at >= now() - ${STALE_CLAIM}::interval)
        OR (c.status = 'failed' AND c.finished_at >= now() - ${RETRY_FAILED_AFTER}::interval)
      )
    ) AS due
  `;
  return row?.due === true;
}

export async function claimCompanyImport(sql: Sql, sourceFile: string, fileDate: string): Promise<void> {
  await sql`
    INSERT INTO company_imports (state, source_file, file_date, status)
    VALUES (${STATE}, ${sourceFile}, ${fileDate}, 'importing')
    ON CONFLICT (state, source_file) DO UPDATE
      SET status = 'importing', file_date = EXCLUDED.file_date, started_at = now(), finished_at = NULL, error = NULL, rows_read = 0, rows_kept = 0
  `;
}

/** The owner names to look up: every company on stored purchases, by key, and the keys of names the roll cut at 30 characters. */
export interface WantedCompanies {
  readonly keys: ReadonlySet<string>;
  /** Keys of roll names that fill all 30 characters, grouped by key length, for "starts with" matches. */
  readonly shortened: ReadonlyMap<number, ReadonlySet<string>>;
}

export async function wantedCompanies(sql: Sql): Promise<WantedCompanies> {
  const rows = await sql<{ owner_key: string; longest: number }[]>`
    SELECT owner_key, max(length(owner_name))::int AS longest FROM property_transactions GROUP BY owner_key
  `;
  const keys = new Set<string>();
  const shortened = new Map<number, Set<string>>();
  for (const r of rows) {
    keys.add(r.owner_key);
    if (r.longest >= ROLL_OWNER_NAME_MAX) {
      const set = shortened.get(r.owner_key.length) ?? new Set<string>();
      set.add(r.owner_key);
      shortened.set(r.owner_key.length, set);
    }
  }
  return { keys, shortened };
}

/** Whether a register name key is wanted: an exact owner key, or a longer name starting with a cut one. */
export function isWantedCompany(w: WantedCompanies, nameKey: string): boolean {
  if (w.keys.has(nameKey)) return true;
  for (const [length, set] of w.shortened) if (nameKey.length > length && set.has(nameKey.slice(0, length))) return true;
  return false;
}

/** Store register records read from one file. A record read again is updated in place. */
export async function storeCompanyRecords(sql: Sql, sourceFile: string, fileDate: string, records: readonly CompanyRecord[]): Promise<number> {
  let stored = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500).map((r) => ({
      state: r.state,
      document_number: r.documentNumber,
      name: r.name,
      name_key: r.nameKey,
      status: r.status,
      filing_type: r.filingType,
      principal: r.principal,
      mailing: r.mailing,
      filed_on: r.filedOn,
      last_transaction_on: r.lastTransactionOn,
      report_years: r.reportYears,
      registered_agent: r.registeredAgent,
      officers: r.officers,
      more_officers: r.moreOfficers,
    }));
    const result = await sql`
      INSERT INTO company_records (state, document_number, name, name_key, status, filing_type, principal, mailing, filed_on,
        last_transaction_on, report_years, registered_agent, officers, more_officers, source_file, file_date)
      SELECT x.state, x.document_number, x.name, x.name_key, x.status, x.filing_type, x.principal, x.mailing, x.filed_on,
             x.last_transaction_on, x.report_years, x.registered_agent, x.officers, x.more_officers, ${sourceFile}, ${fileDate}::date
      FROM jsonb_to_recordset(${sql.json(batch as never)}) AS x(
        state text, document_number text, name text, name_key text, status text, filing_type text, principal jsonb, mailing jsonb,
        filed_on date, last_transaction_on date, report_years smallint[], registered_agent jsonb, officers jsonb, more_officers boolean)
      ON CONFLICT (state, document_number) DO UPDATE SET
        name = EXCLUDED.name, name_key = EXCLUDED.name_key, status = EXCLUDED.status, filing_type = EXCLUDED.filing_type,
        principal = EXCLUDED.principal, mailing = EXCLUDED.mailing, filed_on = EXCLUDED.filed_on,
        last_transaction_on = EXCLUDED.last_transaction_on, report_years = EXCLUDED.report_years,
        registered_agent = EXCLUDED.registered_agent, officers = EXCLUDED.officers, more_officers = EXCLUDED.more_officers,
        source_file = EXCLUDED.source_file, file_date = EXCLUDED.file_date, imported_at = now()
    `;
    stored += result.count;
  }
  return stored;
}

/** Finish an import: record counts and drop records this file no longer has (or no longer wanted). */
export async function completeCompanyImport(sql: Sql, sourceFile: string, counts: { rowsRead: number; rowsKept: number }): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE company_imports SET status = 'ready', finished_at = now(), rows_read = ${counts.rowsRead}, rows_kept = ${counts.rowsKept}
      WHERE state = ${STATE} AND source_file = ${sourceFile}
    `;
    await tx`DELETE FROM company_records WHERE state = ${STATE} AND source_file <> ${sourceFile}`;
  });
}

export async function failCompanyImport(sql: Sql, sourceFile: string, error: string): Promise<void> {
  await sql`
    UPDATE company_imports SET status = 'failed', finished_at = now(), error = ${error.slice(0, 500)}
    WHERE state = ${STATE} AND source_file = ${sourceFile}
  `;
}

interface RecordRow {
  document_number: string;
  name: string;
  name_key: string;
  status: 'active' | 'inactive';
  filing_type: string;
  principal: CompanyRecord['principal'];
  mailing: CompanyRecord['mailing'];
  filed_on: string | null;
  last_transaction_on: string | null;
  report_years: number[];
  registered_agent: CompanyRecord['registeredAgent'];
  officers: CompanyRecord['officers'];
  more_officers: boolean;
  source_file: string;
  file_date: string;
}

const COLUMNS = (db: Db) => db`
  document_number, name, name_key, status, filing_type, principal, mailing, to_char(filed_on, 'YYYY-MM-DD') AS filed_on,
  to_char(last_transaction_on, 'YYYY-MM-DD') AS last_transaction_on, report_years, registered_agent, officers, more_officers,
  source_file, to_char(file_date, 'YYYY-MM-DD') AS file_date
`;

const toRecord = (r: RecordRow): CompanyRecord => ({
  state: 'FL',
  documentNumber: r.document_number,
  name: r.name,
  nameKey: r.name_key,
  status: r.status,
  filingType: r.filing_type,
  principal: r.principal,
  mailing: r.mailing,
  filedOn: r.filed_on,
  lastTransactionOn: r.last_transaction_on,
  reportYears: r.report_years.map(Number),
  registeredAgent: r.registered_agent,
  officers: r.officers,
  moreOfficers: r.more_officers,
});

export interface CompanyRegistryEntry extends CompanyMatch {
  /** File date of the register file the record came from (YYYY-MM-DD). */
  readonly fileDate: string;
}

/**
 * The register record for a company on the roll, or null when there is none or
 * the match would be a guess. `rollNames` are the spellings on the roll (one
 * owner key); the longest decides whether the name may have been cut.
 */
export async function companyRecordFor(db: Db, ownerKey: string, rollNames: readonly string[]): Promise<CompanyRegistryEntry | null> {
  if (!/^[A-Z0-9]+$/.test(ownerKey)) return null;
  const longest = [...rollNames].sort((a, b) => b.trim().length - a.trim().length)[0] ?? ownerKey;
  let rows = await db<RecordRow[]>`SELECT ${COLUMNS(db)} FROM company_records WHERE state = ${STATE} AND name_key = ${ownerKey}`;
  if (rows.length === 0 && longest.trim().length >= ROLL_OWNER_NAME_MAX) {
    rows = await db<RecordRow[]>`
      SELECT ${COLUMNS(db)} FROM company_records WHERE state = ${STATE} AND name_key LIKE ${`${ownerKey}%`} LIMIT 25
    `;
  }
  const picked = pickCompanyRecord(longest, rows.map(toRecord));
  if (!picked) return null;
  const row = rows.find((r) => r.document_number === picked.record.documentNumber);
  return { ...picked, fileDate: row?.file_date ?? '' };
}

/** The register file behind the stored records, for status lines: null before the first import. */
export async function companyRegistryStatus(db: Db): Promise<{ sourceFile: string; fileDate: string; records: number } | null> {
  const [r] = await db<{ source_file: string; file_date: string; records: number }[]>`
    SELECT i.source_file, to_char(i.file_date, 'YYYY-MM-DD') AS file_date,
           (SELECT count(*)::int FROM company_records WHERE state = ${STATE}) AS records
    FROM company_imports i WHERE i.state = ${STATE} AND i.status = 'ready' ORDER BY i.finished_at DESC LIMIT 1
  `;
  return r ? { sourceFile: r.source_file, fileDate: r.file_date, records: r.records } : null;
}
