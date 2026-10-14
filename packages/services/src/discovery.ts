/**
 * Discovery: import public parcel records for the ZIP codes agents focus on,
 * then score them into opportunities for each workspace.
 *
 * Profile saves call `requestDiscovery`; the worker does the rest, in order:
 * `requestMissingDiscovery` → per county `coverageToImport` / `claimCoverage` /
 * `storeParcels` / `completeCoverage` (or `failCoverage`) → per workspace
 * `scoreWorkspace` → `pruneSupersededRecords`.
 */
import {
  type AgentFocus,
  FL_DOR_NAL_SOURCE_KEY,
  type PriorRoll,
  type PropertyUse,
  type ScoreReason,
  SCORING_VERSION,
  type StoredParcel,
  parcelFacts,
  scoreSellerOpportunity,
} from '@gencut/core';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { requireMembershipFor } from './membership.ts';
import { type MarketKey, marketCountyCode } from './markets.ts';

/**
 * An opportunity must reach this score to be shown — in practice two or more
 * signals beyond being in the focus area — and a workspace sees at most this many.
 */
export const DISCOVERY_MIN_SCORE = 55;
export const DISCOVERY_MAX_OPPORTUNITIES = 100;
/**
 * Version of what the importer stores per parcel. Raising it re-imports every
 * covered ZIP on the next run. 2: previous year's roll, both sale slots,
 * owner kind, institutional exemptions excluded.
 */
export const PARCEL_IMPORT_VERSION = 2;
/** A claim older than this is treated as abandoned (the worker crashed) and retried. */
const STALE_CLAIM = '1 hour';
/** A failed import is retried after this long. */
const RETRY_FAILED_AFTER = '6 hours';

export const COVERAGE_STATUSES = ['pending', 'importing', 'ready', 'failed'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export const DISCOVERY_STATUSES = ['pending', 'running', 'ready', 'failed'] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/** Subject key of a parcel opportunity: stable across roll files. */
export function parcelSubjectKey(countyCode: string, parcelId: string): string {
  return `${FL_DOR_NAL_SOURCE_KEY}:${countyCode}:${parcelId}`;
}
/** source_records.external_id of a parcel. Parcel ids are unique within a county only. */
export function parcelExternalId(countyCode: string, parcelId: string): string {
  return `${countyCode}:${parcelId}`;
}

/**
 * Ask for the workspace's ZIP codes to be covered and its opportunities
 * re-scored. Call inside the transaction that changed the profile.
 */
export async function requestDiscovery(db: Db, workspaceId: string, market: MarketKey, zips: readonly string[]): Promise<void> {
  const county = marketCountyCode(market);
  for (const zip of zips) {
    await db`
      INSERT INTO zip_coverage (county_code, zip) VALUES (${county}, ${zip})
      ON CONFLICT (county_code, zip) DO UPDATE
        SET status = 'pending', requested_at = now(), error = NULL
        WHERE zip_coverage.status = 'failed'
    `;
  }
  await db`
    INSERT INTO workspace_discovery (workspace_id) VALUES (${workspaceId})
    ON CONFLICT (workspace_id) DO UPDATE SET status = 'pending', requested_at = now(), error = NULL
  `;
}

/** Profiles saved before discovery existed (or whose request was lost) get one now. */
export async function requestMissingDiscovery(sql: Sql): Promise<number> {
  const rows = await sql<{ workspace_id: string; market: MarketKey; zips: string[] }[]>`
    SELECT p.workspace_id, p.market, coalesce(ARRAY(SELECT jsonb_array_elements_text(p.focus->'zips')), '{}') AS zips
    FROM business_profiles p
    WHERE NOT EXISTS (SELECT 1 FROM workspace_discovery d WHERE d.workspace_id = p.workspace_id)
  `;
  for (const r of rows) {
    await sql.begin((tx) => requestDiscovery(tx, r.workspace_id, r.market, r.zips));
  }
  return rows.length;
}

/** Counties with any ZIP coverage requested. */
export async function countiesWithCoverageRequests(sql: Sql): Promise<string[]> {
  const rows = await sql<{ county_code: string }[]>`SELECT DISTINCT county_code FROM zip_coverage ORDER BY 1`;
  return rows.map((r) => r.county_code);
}

/**
 * ZIP codes in the county to import from `latestFile`: newly requested ones,
 * abandoned claims, failures due a retry, and ready ones imported from an
 * older file.
 */
export async function coverageToImport(sql: Sql, countyCode: string, latestFile: string): Promise<string[]> {
  const rows = await sql<{ zip: string }[]>`
    SELECT zip FROM zip_coverage
    WHERE county_code = ${countyCode} AND (
      status = 'pending'
      OR (status = 'importing' AND started_at < now() - ${STALE_CLAIM}::interval)
      OR (status = 'failed' AND finished_at < now() - ${RETRY_FAILED_AFTER}::interval)
      OR (status = 'ready' AND source_file IS DISTINCT FROM ${latestFile})
      OR (status = 'ready' AND import_version < ${PARCEL_IMPORT_VERSION})
    )
    ORDER BY zip
  `;
  return rows.map((r) => r.zip);
}

/** ZIP codes waiting for a first import (or an abandoned one); what to mark failed when no roll can be read. */
export async function pendingCoverage(sql: Sql, countyCode: string): Promise<string[]> {
  const rows = await sql<{ zip: string }[]>`
    SELECT zip FROM zip_coverage
    WHERE county_code = ${countyCode}
      AND (status = 'pending' OR (status = 'importing' AND started_at < now() - ${STALE_CLAIM}::interval))
    ORDER BY zip
  `;
  return rows.map((r) => r.zip);
}

export async function claimCoverage(sql: Sql, countyCode: string, zips: readonly string[]): Promise<void> {
  await sql`
    UPDATE zip_coverage SET status = 'importing', started_at = now(), error = NULL
    WHERE county_code = ${countyCode} AND zip = ANY(${zips as string[]}::text[])
  `;
}

export async function failCoverage(sql: Sql, countyCode: string, zips: readonly string[], error: string): Promise<void> {
  await sql`
    UPDATE zip_coverage SET status = 'failed', finished_at = now(), error = ${error.slice(0, 500)}
    WHERE county_code = ${countyCode} AND zip = ANY(${zips as string[]}::text[])
  `;
}

async function sourceId(db: Db): Promise<string> {
  const [row] = await db<{ id: string }[]>`SELECT id FROM data_sources WHERE key = ${FL_DOR_NAL_SOURCE_KEY}`;
  if (!row) throw new Error(`data source ${FL_DOR_NAL_SOURCE_KEY} is not registered; run migrations`);
  return row.id;
}

/** Store parcels as shared public source records: one per parcel and file date, replaced on re-import. */
export async function storeParcels(sql: Sql, fileDate: string, parcels: readonly StoredParcel[]): Promise<number> {
  if (parcels.length === 0) return 0;
  const src = await sourceId(sql);
  let inserted = 0;
  for (let i = 0; i < parcels.length; i += 1000) {
    const batch = parcels.slice(i, i + 1000).map((p) => ({
      external_id: parcelExternalId(p.countyCode, p.parcelId),
      zip: p.situs.zip,
      payload: p,
    }));
    const result = await sql`
      INSERT INTO source_records (source_id, external_id, file_date, zip, payload)
      SELECT ${src}, x.external_id, ${fileDate}::date, x.zip, x.payload
      FROM jsonb_to_recordset(${sql.json(batch as never)}) AS x(external_id text, zip text, payload jsonb)
      ON CONFLICT (source_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), external_id, file_date)
      DO UPDATE SET payload = EXCLUDED.payload, zip = EXCLUDED.zip, fetched_at = now()
    `;
    inserted += result.count;
  }
  return inserted;
}

/**
 * Last year's values for parcels in these ZIPs, from records GenCut stored when
 * it imported last year's roll. DOR publishes only the current year's rolls,
 * so GenCut's own history is how a second roll becomes available.
 */
export async function storedPriorRolls(
  sql: Sql,
  countyCode: string,
  zips: readonly string[],
  year: number,
): Promise<Map<string, PriorRoll>> {
  const src = await sourceId(sql);
  const rows = await sql<{ payload: StoredParcel }[]>`
    SELECT DISTINCT ON (r.external_id) r.payload FROM source_records r
    WHERE r.source_id = ${src} AND r.workspace_id IS NULL AND r.zip = ANY(${zips as string[]}::text[])
      AND r.external_id LIKE ${`${countyCode}:%`} AND (r.payload->>'assessmentYear')::int = ${year}
    ORDER BY r.external_id, r.file_date DESC
  `;
  return new Map(
    rows.map(({ payload: p }) => [
      p.parcelId,
      { year, justValue: p.justValue, assessedValue: p.assessedValue, homestead: p.homestead, sales: p.sales ?? [] },
    ]),
  );
}

/**
 * Mark ZIP codes imported from a roll file and queue every workspace that
 * focuses on them for re-scoring.
 */
export async function completeCoverage(
  sql: Sql,
  countyCode: string,
  imported: { zip: string; parcelCount: number }[],
  roll: { sourceFile: string; rollLabel: string; fileDate: string },
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const { zip, parcelCount } of imported) {
      await tx`
        UPDATE zip_coverage SET status = 'ready', finished_at = now(), error = NULL, parcel_count = ${parcelCount},
          source_file = ${roll.sourceFile}, roll_label = ${roll.rollLabel}, file_date = ${roll.fileDate}::date,
          import_version = ${PARCEL_IMPORT_VERSION}
        WHERE county_code = ${countyCode} AND zip = ${zip}
      `;
      await tx`
        UPDATE workspace_discovery d SET status = 'pending', requested_at = now()
        FROM business_profiles p
        WHERE p.workspace_id = d.workspace_id AND p.focus->'zips' @> jsonb_build_array(${zip}::text)
          AND d.status <> 'running'
      `;
    }
  });
}

/** Workspaces due for scoring: requested, with no focus ZIP still waiting for its import. */
export async function workspacesToScore(sql: Sql): Promise<string[]> {
  const rows = await sql<{ workspace_id: string }[]>`
    SELECT d.workspace_id FROM workspace_discovery d
    JOIN business_profiles p ON p.workspace_id = d.workspace_id
    WHERE (d.status = 'pending' OR (d.status = 'running' AND d.started_at < now() - ${STALE_CLAIM}::interval))
      AND NOT EXISTS (
        SELECT 1 FROM zip_coverage c
        WHERE p.focus->'zips' @> jsonb_build_array(c.zip) AND c.status IN ('pending', 'importing')
      )
    ORDER BY d.requested_at
  `;
  return rows.map((r) => r.workspace_id);
}

interface FocusRow {
  market: MarketKey;
  focus: { zips?: string[]; propertyUses?: PropertyUse[]; minValue?: number; maxValue?: number; includeLargeBuildings?: boolean };
}

export interface ScoreSummary {
  readonly considered: number;
  readonly qualified: number;
  readonly kept: number;
}

/**
 * Score every covered parcel in the workspace's focus and keep the best as
 * opportunities. Saved, dismissed and in-campaign opportunities keep their
 * status; unreviewed ones that no longer qualify are removed.
 */
export async function scoreWorkspace(sql: Sql, workspaceId: string, asOf: Date): Promise<ScoreSummary> {
  await sql`UPDATE workspace_discovery SET status = 'running', started_at = now(), error = NULL WHERE workspace_id = ${workspaceId}`;
  try {
    const [profile] = await sql<FocusRow[]>`SELECT market, focus FROM business_profiles WHERE workspace_id = ${workspaceId}`;
    const [discover] = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM workspace_permissions
                     WHERE workspace_id = ${workspaceId} AND kind = 'discover' AND revoked_at IS NULL) AS ok
    `;
    if (!profile) throw new Error('The workspace has no business profile.');
    if (!discover?.ok) throw new Error('Discovery is not permitted for this workspace.');

    const county = marketCountyCode(profile.market);
    const zips = profile.focus.zips ?? [];
    const focus: AgentFocus = {
      zips,
      propertyUses: profile.focus.propertyUses ?? [],
      ...(profile.focus.minValue !== undefined ? { minValue: profile.focus.minValue } : {}),
      ...(profile.focus.maxValue !== undefined ? { maxValue: profile.focus.maxValue } : {}),
      includeLargeBuildings: profile.focus.includeLargeBuildings === true,
    };
    const src = await sourceId(sql);
    const records = await sql<{ id: string; payload: StoredParcel }[]>`
      SELECT r.id, r.payload FROM source_records r
      JOIN zip_coverage c ON c.zip = r.zip AND c.file_date = r.file_date
      WHERE r.source_id = ${src} AND r.workspace_id IS NULL
        AND c.county_code = ${county} AND c.status = 'ready' AND c.zip = ANY(${zips}::text[])
        AND r.external_id LIKE ${`${county}:%`}
    `;

    const scored: {
      recordId: string;
      subjectKey: string;
      score: number;
      confidence: number;
      reasons: readonly ScoreReason[];
      tenure: number;
    }[] = [];
    // Parcels in the focus ZIPs, property types and with a named owner: what the agent would call "homes reviewed".
    let considered = 0;
    for (const r of records) {
      const facts = parcelFacts(r.payload);
      const result = scoreSellerOpportunity(facts, focus, asOf);
      if (!result.eligible) continue;
      considered++;
      if (result.score < DISCOVERY_MIN_SCORE) continue;
      scored.push({
        recordId: r.id,
        subjectKey: parcelSubjectKey(r.payload.countyCode, r.payload.parcelId),
        score: result.score,
        confidence: result.confidence,
        reasons: result.reasons,
        tenure: tenureRatio(facts.assessedValue, facts.justValue),
      });
    }
    // Equal scores are common; among them, the wider assessment gap (longer ownership) ranks first.
    scored.sort(
      (a, b) =>
        b.score - a.score || b.confidence - a.confidence || a.tenure - b.tenure || a.subjectKey.localeCompare(b.subjectKey),
    );
    const kept = scored.slice(0, DISCOVERY_MAX_OPPORTUNITIES);
    const summary = { considered, qualified: scored.length, kept: kept.length };

    await sql.begin(async (tx) => {
      const rows = kept.map((k) => ({
        source_record_id: k.recordId,
        subject_key: k.subjectKey,
        score: k.score,
        confidence: k.confidence,
        reasons: k.reasons,
      }));
      if (rows.length > 0) {
        await tx`
          INSERT INTO opportunities (workspace_id, source_record_id, subject_key, type, score, confidence, reasons, scoring_version)
          SELECT ${workspaceId}, x.source_record_id, x.subject_key, 'potential_seller', x.score, x.confidence, x.reasons, ${SCORING_VERSION}
          FROM jsonb_to_recordset(${tx.json(rows as never)})
            AS x(source_record_id uuid, subject_key text, score smallint, confidence numeric, reasons jsonb)
          ON CONFLICT (workspace_id, type, subject_key) DO UPDATE SET
            source_record_id = EXCLUDED.source_record_id, score = EXCLUDED.score, confidence = EXCLUDED.confidence,
            reasons = EXCLUDED.reasons, scoring_version = EXCLUDED.scoring_version, updated_at = now()
        `;
      }
      await tx`
        DELETE FROM opportunities
        WHERE workspace_id = ${workspaceId} AND type = 'potential_seller' AND status = 'new'
          AND NOT (subject_key = ANY(${kept.map((k) => k.subjectKey)}::text[]))
      `;
      await tx`
        UPDATE workspace_discovery SET status = 'ready', finished_at = now(), scoring_version = ${SCORING_VERSION},
          parcels_considered = ${summary.considered}, parcels_qualified = ${summary.qualified}, opportunity_count = ${summary.kept}
        WHERE workspace_id = ${workspaceId}
      `;
      await recordAudit(tx, {
        workspaceId,
        actorType: 'system',
        actorId: null,
        via: 'worker',
        entityType: 'workspace',
        entityId: workspaceId,
        action: 'discovery_scored',
        detail: { scoringVersion: SCORING_VERSION, ...summary, minScore: DISCOVERY_MIN_SCORE },
      });
    });
    return summary;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE workspace_discovery SET status = 'failed', finished_at = now(), error = ${message.slice(0, 500)}
      WHERE workspace_id = ${workspaceId}
    `;
    throw e;
  }
}

/** Assessed ÷ market value; lower means a longer-held property. 1 when unknown. */
function tenureRatio(assessed: number | undefined, just: number | undefined): number {
  return assessed && just && just > 0 ? Math.min(1, assessed / just) : 1;
}

/** Delete public parcel records replaced by a newer roll that nothing references any more. */
export async function pruneSupersededRecords(sql: Sql): Promise<number> {
  const src = await sourceId(sql);
  const result = await sql`
    DELETE FROM source_records r
    WHERE r.source_id = ${src} AND r.workspace_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM zip_coverage c
        WHERE c.zip = r.zip AND c.file_date = r.file_date AND r.external_id LIKE c.county_code || ':%'
      )
      AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.source_record_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.source_record_id = r.id)
  `;
  return result.count;
}

export interface CoverageView {
  readonly zip: string;
  readonly status: CoverageStatus | 'not_requested';
  readonly rollLabel: string | null;
  readonly fileDate: string | null;
  readonly parcelCount: number | null;
}

export interface DiscoveryView {
  readonly status: DiscoveryStatus | 'not_requested';
  readonly requestedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly parcelsConsidered: number | null;
  readonly parcelsQualified: number | null;
  readonly opportunityCount: number | null;
  readonly coverage: readonly CoverageView[];
  readonly failed: boolean;
}

/** Where the workspace's discovery stands, for the home page and the feed. */
export async function getDiscoveryStatus(db: Db, ctx: RequestContext, workspaceId: string): Promise<DiscoveryView> {
  await requireMembershipFor(db, ctx, workspaceId);
  const [profile] = await db<FocusRow[]>`SELECT market, focus FROM business_profiles WHERE workspace_id = ${workspaceId}`;
  const [d] = await db<
    {
      status: DiscoveryStatus;
      requested_at: Date;
      finished_at: Date | null;
      parcels_considered: number | null;
      parcels_qualified: number | null;
      opportunity_count: number | null;
    }[]
  >`SELECT * FROM workspace_discovery WHERE workspace_id = ${workspaceId}`;
  const zips = profile?.focus.zips ?? [];
  const county = profile ? marketCountyCode(profile.market) : null;
  const cov = county
    ? await db<{ zip: string; status: CoverageStatus; roll_label: string | null; file_date: string | null; parcel_count: number | null }[]>`
        SELECT zip, status, roll_label, to_char(file_date, 'YYYY-MM-DD') AS file_date, parcel_count
        FROM zip_coverage WHERE county_code = ${county} AND zip = ANY(${zips}::text[])
      `
    : [];
  return {
    status: d?.status ?? 'not_requested',
    requestedAt: d?.requested_at ?? null,
    finishedAt: d?.finished_at ?? null,
    parcelsConsidered: d?.parcels_considered ?? null,
    parcelsQualified: d?.parcels_qualified ?? null,
    opportunityCount: d?.opportunity_count ?? null,
    failed: d?.status === 'failed',
    coverage: zips.map((zip) => {
      const c = cov.find((x) => x.zip === zip);
      return {
        zip,
        status: c?.status ?? 'not_requested',
        rollLabel: c?.roll_label ?? null,
        fileDate: c?.file_date ?? null,
        parcelCount: c?.parcel_count ?? null,
      };
    }),
  };
}
