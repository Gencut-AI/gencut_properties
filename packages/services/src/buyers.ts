/**
 * Buyer Radar: company purchases from the public roll, scored into buyer
 * opportunities per workspace.
 *
 * The worker imports each county's qualified company purchases once per roll
 * file (`transactionImportDue` → `claimTransactionImport` → `storeTransactions`
 * → `completeTransactionImport`), then scores buyers for workspaces that are
 * due (`workspacesToScoreBuyers` → `scoreWorkspaceBuyers`). The web app reads
 * them with `listBuyers` and `getBuyer`.
 *
 * A buyer opportunity cites its purchases (`evidence.transactionIds`) and keeps
 * the profile derived from them. Nothing here contacts anyone.
 */
import {
  type AgentFocus,
  BUYER_SCORING_VERSION,
  type BuyerProfile,
  type BuyerReason,
  type PropertyTransaction,
  type PropertyUse,
  buyerProfile,
  scoreBuyer,
  useCodesFor,
} from '@gencut/core';
import { z } from 'zod';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import { type MarketKey, marketCountyCode } from './markets.ts';
import { requireMembershipFor } from './membership.ts';
import type { FeedView, OpportunityStatus } from './opportunities.ts';

/** A workspace sees at most this many buyers. */
export const BUYERS_KEPT = 200;
const STALE_CLAIM = '1 hour';
const RETRY_FAILED_AFTER = '6 hours';

/** Subject key of a buyer opportunity: the county and the company's normalized name. */
export function buyerSubjectKey(countyCode: string, ownerKey: string): string {
  return `buyer:${countyCode}:${ownerKey}`;
}

// ------------------------------------------------------------------ import

/** True when this county's company purchases have not been imported from `file` yet (or the last try is due a retry). */
export async function transactionImportDue(sql: Sql, countyCode: string, file: string): Promise<boolean> {
  const [row] = await sql<{ due: boolean }[]>`
    SELECT NOT EXISTS (
      SELECT 1 FROM transaction_imports
      WHERE county_code = ${countyCode} AND source_file = ${file} AND (
        status = 'ready'
        OR (status = 'importing' AND started_at >= now() - ${STALE_CLAIM}::interval)
        OR (status = 'failed' AND finished_at >= now() - ${RETRY_FAILED_AFTER}::interval)
      )
    ) AS due
  `;
  return row?.due === true;
}

export async function claimTransactionImport(sql: Sql, countyCode: string, file: string, fileDate: string): Promise<void> {
  await sql`
    INSERT INTO transaction_imports (county_code, source_file, file_date, status)
    VALUES (${countyCode}, ${file}, ${fileDate}, 'importing')
    ON CONFLICT (county_code, source_file) DO UPDATE
      SET status = 'importing', started_at = now(), finished_at = NULL, error = NULL, rows_read = 0, rows_kept = 0
  `;
}

/** Store purchases read from one roll file. Re-reading a sale updates it in place. */
export async function storeTransactions(sql: Sql, file: string, fileDate: string, txs: readonly PropertyTransaction[]): Promise<number> {
  let stored = 0;
  for (let i = 0; i < txs.length; i += 1000) {
    const batch = txs.slice(i, i + 1000).map((t) => ({
      county_code: t.countyCode,
      parcel_id: t.parcelId,
      roll_year: t.rollYear,
      situs_address: t.situs.address,
      situs_city: t.situs.city,
      situs_zip: t.situs.zip,
      use_code: t.useCode,
      units: t.units,
      living_area: t.livingArea,
      year_built: t.yearBuilt,
      owner_name: t.ownerName,
      owner_key: t.ownerKey,
      owner_mailing: t.ownerMailing,
      sale_year: t.saleYear,
      sale_month: t.saleMonth,
      price: t.price,
      qualification_code: t.qualificationCode,
    }));
    const result = await sql`
      INSERT INTO property_transactions (county_code, parcel_id, roll_year, source_file, file_date, situs_address, situs_city, situs_zip,
        use_code, units, living_area, year_built, owner_name, owner_key, owner_mailing, sale_year, sale_month, price, qualification_code)
      SELECT x.county_code, x.parcel_id, x.roll_year, ${file}, ${fileDate}::date, x.situs_address, x.situs_city, x.situs_zip,
             x.use_code, x.units, x.living_area, x.year_built, x.owner_name, x.owner_key, x.owner_mailing, x.sale_year, x.sale_month,
             x.price, x.qualification_code
      FROM jsonb_to_recordset(${sql.json(batch as never)}) AS x(
        county_code text, parcel_id text, roll_year smallint, situs_address text, situs_city text, situs_zip text, use_code text,
        units integer, living_area integer, year_built smallint, owner_name text, owner_key text, owner_mailing jsonb,
        sale_year smallint, sale_month smallint, price bigint, qualification_code text)
      ON CONFLICT (county_code, parcel_id, sale_year, coalesce(sale_month, 0), price)
      DO UPDATE SET roll_year = EXCLUDED.roll_year, source_file = EXCLUDED.source_file, file_date = EXCLUDED.file_date,
                    owner_name = EXCLUDED.owner_name, owner_key = EXCLUDED.owner_key, owner_mailing = EXCLUDED.owner_mailing,
                    imported_at = now()
    `;
    stored += result.count;
  }
  return stored;
}

/**
 * Finish an import: record counts, drop purchases that fell out of the roll's
 * sale window (`minSaleYear`), and ask every workspace in the county to re-score
 * its buyers.
 */
export async function completeTransactionImport(
  sql: Sql,
  countyCode: string,
  file: string,
  counts: { rowsRead: number; rowsKept: number; minSaleYear: number },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE transaction_imports SET status = 'ready', finished_at = now(), rows_read = ${counts.rowsRead}, rows_kept = ${counts.rowsKept}
      WHERE county_code = ${countyCode} AND source_file = ${file}
    `;
    await tx`DELETE FROM property_transactions WHERE county_code = ${countyCode} AND sale_year < ${counts.minSaleYear}`;
    await tx`UPDATE workspace_discovery SET buyer_status = 'pending' WHERE buyer_status <> 'scoring'`;
  });
}

export async function failTransactionImport(sql: Sql, countyCode: string, file: string, error: string): Promise<void> {
  await sql`
    UPDATE transaction_imports SET status = 'failed', finished_at = now(), error = ${error.slice(0, 500)}
    WHERE county_code = ${countyCode} AND source_file = ${file}
  `;
}

// ------------------------------------------------------------------ scoring

interface FocusRow {
  market: MarketKey;
  focus: { zips?: string[]; propertyUses?: PropertyUse[]; minValue?: number; maxValue?: number };
}

interface TxRow {
  id: string;
  county_code: string;
  parcel_id: string;
  roll_year: number;
  source_file: string;
  file_date: string;
  situs_address: string;
  situs_city: string;
  situs_zip: string;
  use_code: string;
  units: number | null;
  living_area: number | null;
  year_built: number | null;
  owner_name: string;
  owner_key: string;
  owner_mailing: PropertyTransaction['ownerMailing'];
  sale_year: number;
  sale_month: number | null;
  price: string | number;
  qualification_code: string;
}

function toTransaction(r: TxRow): PropertyTransaction {
  return {
    countyCode: r.county_code,
    parcelId: r.parcel_id,
    rollYear: r.roll_year,
    situs: { address: r.situs_address, city: r.situs_city, zip: r.situs_zip },
    useCode: r.use_code,
    units: r.units,
    livingArea: r.living_area,
    yearBuilt: r.year_built,
    ownerName: r.owner_name,
    ownerKey: r.owner_key,
    ownerMailing: r.owner_mailing,
    saleYear: r.sale_year,
    saleMonth: r.sale_month,
    price: Number(r.price),
    qualificationCode: r.qualification_code,
  };
}

const TX_COLUMNS = (db: Db) => db`
  id, county_code, parcel_id, roll_year, source_file, to_char(file_date, 'YYYY-MM-DD') AS file_date, situs_address, situs_city,
  situs_zip, use_code, units, living_area, year_built, owner_name, owner_key, owner_mailing, sale_year, sale_month, price, qualification_code
`;

/** Workspaces whose buyers are due: asked for, abandoned, or scored before the county's newest import. */
export async function workspacesToScoreBuyers(sql: Sql): Promise<string[]> {
  const rows = await sql<{ workspace_id: string; market: MarketKey; buyer_status: string; buyer_file_date: string | null; started_at: Date | null; stale: boolean }[]>`
    SELECT d.workspace_id, p.market, d.buyer_status, to_char(d.buyer_file_date, 'YYYY-MM-DD') AS buyer_file_date,
           d.buyer_scored_at AS started_at, (d.buyer_status = 'scoring' AND coalesce(d.buyer_scored_at, d.requested_at) < now() - ${STALE_CLAIM}::interval) AS stale
    FROM workspace_discovery d JOIN business_profiles p ON p.workspace_id = d.workspace_id
  `;
  const latest = await sql<{ county_code: string; file_date: string }[]>`
    SELECT county_code, to_char(max(file_date), 'YYYY-MM-DD') AS file_date FROM transaction_imports WHERE status = 'ready' GROUP BY county_code
  `;
  return rows
    .filter((r) => {
      const imported = latest.find((l) => l.county_code === marketCountyCode(r.market))?.file_date;
      if (!imported) return false; // nothing to score from yet
      return r.buyer_status === 'pending' || r.stale || (r.buyer_status === 'ready' && (r.buyer_file_date ?? '') < imported);
    })
    .map((r) => r.workspace_id);
}

export interface BuyerScoreSummary {
  readonly eligible: number;
  readonly kept: number;
}

/**
 * Score every company with enough purchases in the workspace's county, keep the
 * best `BUYERS_KEPT` as buyer opportunities, and drop untouched ones that fell
 * off. Saved, dismissed and in-campaign buyers keep their status.
 */
export async function scoreWorkspaceBuyers(sql: Sql, workspaceId: string): Promise<BuyerScoreSummary> {
  await sql`UPDATE workspace_discovery SET buyer_status = 'scoring', buyer_scored_at = now(), buyer_error = NULL WHERE workspace_id = ${workspaceId}`;
  try {
    const [profile] = await sql<FocusRow[]>`SELECT market, focus FROM business_profiles WHERE workspace_id = ${workspaceId}`;
    const [discover] = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM workspace_permissions WHERE workspace_id = ${workspaceId} AND kind = 'discover' AND revoked_at IS NULL) AS ok
    `;
    if (!profile) throw new Error('The workspace has no business profile.');
    if (!discover?.ok) throw new Error('Discovery is not permitted for this workspace.');
    const county = marketCountyCode(profile.market);
    const [imp] = await sql<{ file_date: string }[]>`
      SELECT to_char(max(file_date), 'YYYY-MM-DD') AS file_date FROM transaction_imports WHERE county_code = ${county} AND status = 'ready'
    `;
    if (!imp?.file_date) throw new Error('No purchases have been imported for this county yet.');
    const focus: AgentFocus = {
      zips: profile.focus.zips ?? [],
      propertyUses: profile.focus.propertyUses ?? [],
      ...(profile.focus.minValue !== undefined ? { minValue: profile.focus.minValue } : {}),
      ...(profile.focus.maxValue !== undefined ? { maxValue: profile.focus.maxValue } : {}),
    };

    const rows = await sql<TxRow[]>`
      SELECT ${TX_COLUMNS(sql)} FROM property_transactions
      WHERE county_code = ${county} AND owner_key IN (
        SELECT owner_key FROM property_transactions WHERE county_code = ${county} GROUP BY owner_key HAVING count(*) >= 2
      )
    `;
    const byOwner = new Map<string, TxRow[]>();
    for (const r of rows) byOwner.set(r.owner_key, [...(byOwner.get(r.owner_key) ?? []), r]);

    const scored: { subjectKey: string; score: number; reasons: readonly BuyerReason[]; profile: BuyerProfile; ids: string[]; latest: number }[] = [];
    for (const [key, list] of byOwner) {
      const p = buyerProfile(list.map(toTransaction));
      const s = scoreBuyer(p, focus, imp.file_date);
      if (!s.eligible) continue;
      scored.push({
        subjectKey: buyerSubjectKey(county, key),
        score: s.score,
        reasons: s.reasons,
        profile: p,
        ids: list.map((r) => r.id).sort(),
        latest: p.latest.year * 12 + (p.latest.month ?? 1),
      });
    }
    scored.sort((a, b) => b.score - a.score || b.latest - a.latest || a.subjectKey.localeCompare(b.subjectKey));
    const kept = scored.slice(0, BUYERS_KEPT);

    await sql.begin(async (tx) => {
      if (kept.length) {
        const batch = kept.map((k) => ({
          subject_key: k.subjectKey,
          score: k.score,
          reasons: k.reasons,
          evidence: { transactionIds: k.ids, profile: k.profile, rollFileDate: imp.file_date },
        }));
        await tx`
          INSERT INTO opportunities (workspace_id, subject_key, type, score, confidence, reasons, scoring_version, evidence)
          SELECT ${workspaceId}, x.subject_key, 'investor_buyer', x.score, 1, x.reasons, ${BUYER_SCORING_VERSION}, x.evidence
          FROM jsonb_to_recordset(${tx.json(batch as never)}) AS x(subject_key text, score smallint, reasons jsonb, evidence jsonb)
          ON CONFLICT (workspace_id, type, subject_key) DO UPDATE SET
            score = EXCLUDED.score, reasons = EXCLUDED.reasons, scoring_version = EXCLUDED.scoring_version,
            evidence = EXCLUDED.evidence, updated_at = now()
        `;
      }
      await tx`
        DELETE FROM opportunities
        WHERE workspace_id = ${workspaceId} AND type = 'investor_buyer' AND status = 'new'
          AND NOT (subject_key = ANY(${kept.map((k) => k.subjectKey)}::text[]))
      `;
      await tx`
        UPDATE workspace_discovery SET buyer_status = 'ready', buyer_file_date = ${imp.file_date}, buyers_considered = ${scored.length},
               buyer_count = ${kept.length}, buyer_scored_at = now()
        WHERE workspace_id = ${workspaceId}
      `;
      await recordAudit(tx, {
        workspaceId, actorType: 'system', actorId: null, via: 'worker', entityType: 'workspace', entityId: workspaceId,
        action: 'buyers_scored', detail: { scoringVersion: BUYER_SCORING_VERSION, eligible: scored.length, kept: kept.length, rollFileDate: imp.file_date },
      });
    });
    return { eligible: scored.length, kept: kept.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`UPDATE workspace_discovery SET buyer_status = 'failed', buyer_error = ${message.slice(0, 500)} WHERE workspace_id = ${workspaceId}`;
    throw e;
  }
}

// ------------------------------------------------------------------ reading

export interface BuyerSummary {
  readonly id: string;
  readonly status: OpportunityStatus;
  readonly score: number;
  readonly reasons: readonly BuyerReason[];
  readonly scoringVersion: string;
  readonly profile: BuyerProfile;
  /** File date of the roll the profile was built from (YYYY-MM-DD). */
  readonly rollFileDate: string;
  readonly updatedAt: Date;
}

export interface BuyerPurchase {
  readonly id: string;
  readonly parcelId: string;
  readonly address: string;
  readonly city: string;
  readonly zip: string;
  readonly homeType: string;
  readonly useCode: string;
  readonly units: number | null;
  readonly livingArea: number | null;
  readonly yearBuilt: number | null;
  readonly saleYear: number;
  readonly saleMonth: number | null;
  readonly price: number;
  readonly qualificationCode: string;
  readonly ownerNameOnRoll: string;
  readonly sourceFile: string;
  readonly fileDate: string;
}

export interface BuyerDetail extends BuyerSummary {
  readonly purchases: readonly BuyerPurchase[];
  /** Purchases cited by the profile that are no longer stored (a newer roll dropped them). */
  readonly missingPurchases: number;
}

interface BuyerRow {
  id: string;
  status: OpportunityStatus;
  score: number;
  reasons: BuyerReason[];
  scoring_version: string;
  evidence: { transactionIds: string[]; profile: BuyerProfile; rollFileDate: string };
  updated_at: Date;
}

const toSummary = (r: BuyerRow): BuyerSummary => ({
  id: r.id,
  status: r.status,
  score: r.score,
  reasons: r.reasons,
  scoringVersion: r.scoring_version,
  profile: r.evidence.profile,
  rollFileDate: r.evidence.rollFileDate,
  updatedAt: r.updated_at,
});

const VIEW_STATUSES: Record<FeedView, OpportunityStatus[]> = {
  active: ['new', 'saved', 'in_campaign'],
  saved: ['saved'],
  dismissed: ['dismissed'],
};

export interface BuyerFilters {
  readonly zip?: string;
  readonly propertyUse?: PropertyUse;
  readonly minPurchases?: number;
}

/** Filters from query-string values; anything invalid is ignored. */
export function parseBuyerFilters(q: Record<string, string | string[] | undefined>): BuyerFilters {
  const one = (k: string) => (Array.isArray(q[k]) ? q[k][0] : q[k]);
  const zip = one('zip');
  const use = one('type');
  const min = Number(one('min'));
  return {
    ...(zip && /^\d{5}$/.test(zip) ? { zip } : {}),
    ...(use && ['single_family', 'condo', 'townhouse', 'multifamily', 'vacant_land', 'other'].includes(use) ? { propertyUse: use as PropertyUse } : {}),
    ...(Number.isInteger(min) && min >= 2 && min <= 50 ? { minPurchases: min } : {}),
  };
}

/** The workspace's buyers, best first. */
export async function listBuyers(
  db: Db,
  ctx: RequestContext,
  workspaceId: string,
  options: { view?: FeedView; filters?: BuyerFilters; limit?: number } = {},
): Promise<BuyerSummary[]> {
  await requireMembershipFor(db, ctx, workspaceId);
  const f = options.filters ?? {};
  const conds = [
    db`workspace_id = ${workspaceId}`,
    db`type = 'investor_buyer'`,
    db`status = ANY(${VIEW_STATUSES[options.view ?? 'active']}::text[])`,
    ...(f.zip ? [db`evidence->'profile'->'zips' @> ${db.json([{ zip: f.zip }] as never)}`] : []),
    ...(f.minPurchases ? [db`(evidence->'profile'->>'purchases')::int >= ${f.minPurchases}`] : []),
    ...(f.propertyUse
      ? [db`EXISTS (SELECT 1 FROM jsonb_array_elements(evidence->'profile'->'homeTypes') t WHERE t->>'useCode' = ANY(${useCodesFor(f.propertyUse)}::text[]))`]
      : []),
  ].reduce((a, c) => db`${a} AND ${c}`);
  const limit = Math.min(Math.max(options.limit ?? BUYERS_KEPT, 1), BUYERS_KEPT);
  const rows = await db<BuyerRow[]>`
    SELECT id, status, score, reasons, scoring_version, evidence, updated_at FROM opportunities
    WHERE ${conds}
    ORDER BY score DESC, (evidence->'profile'->'latest'->>'year')::int DESC, (evidence->'profile'->'latest'->>'month')::int DESC NULLS LAST, subject_key
    LIMIT ${limit}
  `;
  return rows.map(toSummary);
}

export async function countBuyers(db: Db, ctx: RequestContext, workspaceId: string): Promise<Record<FeedView, number>> {
  await requireMembershipFor(db, ctx, workspaceId);
  const rows = await db<{ status: OpportunityStatus; n: number }[]>`
    SELECT status, count(*)::int AS n FROM opportunities WHERE workspace_id = ${workspaceId} AND type = 'investor_buyer' GROUP BY status
  `;
  const n = (s: OpportunityStatus[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { active: n(VIEW_STATUSES.active), saved: n(VIEW_STATUSES.saved), dismissed: n(VIEW_STATUSES.dismissed) };
}

/** One buyer with every purchase behind its profile. */
export async function getBuyer(db: Db, ctx: RequestContext, workspaceId: string, id: string): Promise<BuyerDetail> {
  await requireMembershipFor(db, ctx, workspaceId);
  if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 'That buyer does not exist.');
  const [r] = await db<BuyerRow[]>`
    SELECT id, status, score, reasons, scoring_version, evidence, updated_at FROM opportunities
    WHERE workspace_id = ${workspaceId} AND id = ${id} AND type = 'investor_buyer'
  `;
  if (!r) throw new ServiceError('not_found', 'That buyer does not exist.');
  const ids = r.evidence.transactionIds;
  const txs = await db<TxRow[]>`SELECT ${TX_COLUMNS(db)} FROM property_transactions WHERE id = ANY(${ids}::uuid[])`;
  const purchases = txs
    .map((t) => {
      const x = toTransaction(t);
      return {
        id: t.id,
        parcelId: x.parcelId,
        address: x.situs.address,
        city: x.situs.city,
        zip: x.situs.zip,
        homeType: r.evidence.profile.homeTypes.find((h) => h.useCode === x.useCode)?.label ?? 'Residential',
        useCode: x.useCode,
        units: x.units,
        livingArea: x.livingArea,
        yearBuilt: x.yearBuilt,
        saleYear: x.saleYear,
        saleMonth: x.saleMonth,
        price: x.price,
        qualificationCode: x.qualificationCode,
        ownerNameOnRoll: x.ownerName,
        sourceFile: t.source_file,
        fileDate: t.file_date,
      };
    })
    .sort((a, b) => b.saleYear - a.saleYear || (b.saleMonth ?? 0) - (a.saleMonth ?? 0) || a.parcelId.localeCompare(b.parcelId));
  return { ...toSummary(r), purchases, missingPurchases: ids.length - purchases.length };
}

export interface BuyerDiscoveryView {
  readonly status: 'pending' | 'scoring' | 'ready' | 'failed' | 'not_requested';
  readonly rollFileDate: string | null;
  readonly eligible: number | null;
  readonly kept: number | null;
  readonly importedFile: string | null;
  readonly error: string | null;
}

/** Where the workspace's buyers stand, for the Buyers tab. */
export async function getBuyerDiscoveryStatus(db: Db, ctx: RequestContext, workspaceId: string): Promise<BuyerDiscoveryView> {
  await requireMembershipFor(db, ctx, workspaceId);
  const [d] = await db<{ buyer_status: BuyerDiscoveryView['status']; buyer_file_date: string | null; buyers_considered: number | null; buyer_count: number | null; buyer_error: string | null; market: MarketKey }[]>`
    SELECT d.buyer_status, to_char(d.buyer_file_date, 'YYYY-MM-DD') AS buyer_file_date, d.buyers_considered, d.buyer_count, d.buyer_error, p.market
    FROM workspace_discovery d JOIN business_profiles p ON p.workspace_id = d.workspace_id WHERE d.workspace_id = ${workspaceId}
  `;
  if (!d) return { status: 'not_requested', rollFileDate: null, eligible: null, kept: null, importedFile: null, error: null };
  const [imp] = await db<{ source_file: string }[]>`
    SELECT source_file FROM transaction_imports WHERE county_code = ${marketCountyCode(d.market)} AND status = 'ready'
    ORDER BY file_date DESC LIMIT 1
  `;
  return {
    status: d.buyer_status,
    rollFileDate: d.buyer_file_date,
    eligible: d.buyers_considered,
    kept: d.buyer_count,
    importedFile: imp?.source_file ?? null,
    error: d.buyer_error,
  };
}
