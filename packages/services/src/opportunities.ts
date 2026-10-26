/**
 * The agent's opportunity feed: list, read and triage scored opportunities.
 * Every opportunity carries the public record it came from, so each fact
 * shown can name its source.
 */
import {
  DOR_USE_LABELS,
  OWNER_KINDS,
  type OwnerKind,
  PROPERTY_USES,
  type PropertyUse,
  type ScoreReason,
  type StoredParcel,
  isLargeBuilding,
  ownerKindOf,
  propertyUseOf,
  useCodesFor,
} from '@gencut/core';
import { z } from 'zod';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import { requireMembershipFor } from './membership.ts';

export const OPPORTUNITY_STATUSES = ['new', 'saved', 'dismissed', 'in_campaign'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
/** Statuses an agent sets directly; in_campaign is set by starting a campaign. */
export const TRIAGE_STATUSES = ['new', 'saved', 'dismissed'] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

export const FEED_VIEWS = ['active', 'saved', 'dismissed'] as const;
export type FeedView = (typeof FEED_VIEWS)[number];

/** Signals the feed can filter on. `long_held` covers both strengths of the long-ownership reason. */
export const FEED_SIGNALS = ['absentee', 'out_of_state', 'long_held', 'estate'] as const;
export type FeedSignal = (typeof FEED_SIGNALS)[number];
const SIGNAL_REASON_CODES: Record<FeedSignal, string[]> = {
  absentee: ['absentee_owner'],
  out_of_state: ['out_of_state_owner'],
  long_held: ['long_held_strong', 'long_held'],
  estate: ['estate_owner'],
};

export interface FeedFilters {
  readonly propertyUse?: PropertyUse;
  readonly ownerKind?: OwnerKind;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly signals?: readonly FeedSignal[];
}

const money = z.coerce.number().int().min(0).max(1_000_000_000);
const feedFiltersInput = z.object({
  type: z.enum(PROPERTY_USES).optional().catch(undefined),
  owner: z.enum(OWNER_KINDS).optional().catch(undefined),
  min: money.optional().catch(undefined),
  max: money.optional().catch(undefined),
  signal: z
    .union([z.enum(FEED_SIGNALS), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).filter((x): x is FeedSignal => (FEED_SIGNALS as readonly string[]).includes(x))))
    .catch([]),
});

/**
 * Read feed filters from query parameters (`type`, `owner`, `min`, `max`,
 * `signal` repeated). Unknown or malformed values are ignored, never errors.
 */
export function parseFeedFilters(params: Record<string, string | string[] | undefined>): FeedFilters {
  const v = feedFiltersInput.parse({ ...params, min: params.min || undefined, max: params.max || undefined });
  return {
    ...(v.type ? { propertyUse: v.type } : {}),
    ...(v.owner ? { ownerKind: v.owner } : {}),
    ...(v.min !== undefined ? { minValue: v.min } : {}),
    ...(v.max !== undefined ? { maxValue: v.max } : {}),
    ...(v.signal.length ? { signals: [...new Set(v.signal)] } : {}),
  };
}

export function hasFilters(f: FeedFilters): boolean {
  return Boolean(f.propertyUse || f.ownerKind || f.minValue !== undefined || f.maxValue !== undefined || f.signals?.length);
}

export interface OpportunitySource {
  readonly name: string;
  readonly termsUrl: string | null;
  readonly rollLabel: string | null;
  readonly sourceFile: string | null;
  readonly fileDate: string;
  readonly recordId: string;
}

export interface OpportunitySummary {
  readonly id: string;
  readonly status: OpportunityStatus;
  readonly score: number;
  readonly confidence: number;
  readonly reasons: readonly ScoreReason[];
  readonly scoringVersion: string;
  readonly updatedAt: Date;
  readonly parcelId: string;
  readonly address: string;
  readonly city: string;
  readonly zip: string;
  readonly propertyType: string;
  readonly propertyUse: ReturnType<typeof propertyUseOf>;
  readonly justValue: number | null;
  readonly ownerName: string;
  readonly ownerKind: OwnerKind;
  readonly ownerLocation: string;
  readonly largeBuilding: boolean;
}

export interface OpportunityDetail extends OpportunitySummary {
  readonly parcel: StoredParcel;
  readonly source: OpportunitySource;
}

interface Row {
  id: string;
  status: OpportunityStatus;
  score: number;
  confidence: string;
  reasons: ScoreReason[];
  scoring_version: string;
  updated_at: Date;
  payload: StoredParcel;
  record_id: string;
  file_date: string;
  source_name: string;
  terms_url: string | null;
  roll_label: string | null;
  source_file: string | null;
}

function summary(r: Row): OpportunitySummary {
  const p = r.payload;
  return {
    id: r.id,
    status: r.status,
    score: r.score,
    confidence: Number(r.confidence),
    reasons: r.reasons,
    scoringVersion: r.scoring_version,
    updatedAt: r.updated_at,
    parcelId: p.parcelId,
    address: p.situs.address,
    city: p.situs.city,
    zip: p.situs.zip,
    propertyType: DOR_USE_LABELS[p.useCode] ?? 'Residential',
    propertyUse: propertyUseOf(p.useCode),
    justValue: p.justValue,
    ownerName: p.owner.name,
    ownerKind: p.ownerKind ?? ownerKindOf(p.owner.name),
    ownerLocation: [p.owner.city, p.owner.state].filter(Boolean).join(', '),
    largeBuilding: isLargeBuilding(p),
  };
}

function select(db: Db) {
  return db`
    SELECT o.id, o.status, o.score, o.confidence, o.reasons, o.scoring_version, o.updated_at,
           r.payload, r.id AS record_id, to_char(r.file_date, 'YYYY-MM-DD') AS file_date,
           s.name AS source_name, s.terms_url, c.roll_label, c.source_file
    FROM opportunities o
    JOIN source_records r ON r.id = o.source_record_id
    JOIN data_sources s ON s.id = r.source_id
    LEFT JOIN zip_coverage c ON c.zip = r.zip AND c.file_date = r.file_date AND r.external_id LIKE c.county_code || ':%'
  `;
}

const VIEW_STATUSES: Record<FeedView, OpportunityStatus[]> = {
  active: ['new', 'saved', 'in_campaign'],
  saved: ['saved'],
  dismissed: ['dismissed'],
};

function filterConditions(db: Db, f: FeedFilters) {
  const conds = [];
  if (f.propertyUse) conds.push(db`r.payload->>'useCode' = ANY(${useCodesFor(f.propertyUse)}::text[])`);
  if (f.ownerKind) conds.push(db`r.payload->>'ownerKind' = ${f.ownerKind}`);
  if (f.minValue !== undefined) conds.push(db`(r.payload->>'justValue')::bigint >= ${f.minValue}`);
  if (f.maxValue !== undefined) conds.push(db`(r.payload->>'justValue')::bigint <= ${f.maxValue}`);
  for (const signal of f.signals ?? []) {
    const codes = SIGNAL_REASON_CODES[signal];
    conds.push(db`EXISTS (SELECT 1 FROM jsonb_array_elements(o.reasons) x WHERE x->>'code' = ANY(${codes}::text[]))`);
  }
  return conds;
}

export async function listOpportunities(
  db: Db,
  ctx: RequestContext,
  workspaceId: string,
  options: { view?: FeedView; limit?: number; filters?: FeedFilters } = {},
): Promise<OpportunitySummary[]> {
  await requireMembershipFor(db, ctx, workspaceId);
  const statuses = VIEW_STATUSES[options.view ?? 'active'];
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const where = [db`o.workspace_id = ${workspaceId}`, db`o.status = ANY(${statuses}::text[])`, ...filterConditions(db, options.filters ?? {})]
    .reduce((a, c) => db`${a} AND ${c}`);
  const rows = await db<Row[]>`
    ${select(db)}
    WHERE ${where}
    ORDER BY o.score DESC, o.confidence DESC, o.subject_key
    LIMIT ${limit}
  `;
  return rows.map(summary);
}

export async function countOpportunities(db: Db, ctx: RequestContext, workspaceId: string): Promise<Record<FeedView, number>> {
  await requireMembershipFor(db, ctx, workspaceId);
  const rows = await db<{ status: OpportunityStatus; n: number }[]>`
    SELECT status, count(*)::int AS n FROM opportunities WHERE workspace_id = ${workspaceId} AND type = 'potential_seller' GROUP BY status
  `;
  const n = (statuses: OpportunityStatus[]) => rows.filter((r) => statuses.includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { active: n(VIEW_STATUSES.active), saved: n(VIEW_STATUSES.saved), dismissed: n(VIEW_STATUSES.dismissed) };
}

export async function getOpportunity(db: Db, ctx: RequestContext, workspaceId: string, id: string): Promise<OpportunityDetail> {
  await requireMembershipFor(db, ctx, workspaceId);
  if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 'That opportunity does not exist.');
  const [r] = await db<Row[]>`${select(db)} WHERE o.workspace_id = ${workspaceId} AND o.id = ${id}`;
  if (!r) throw new ServiceError('not_found', 'That opportunity does not exist.');
  return {
    ...summary(r),
    parcel: r.payload,
    source: {
      name: r.source_name,
      termsUrl: r.terms_url,
      rollLabel: r.roll_label,
      sourceFile: r.source_file,
      fileDate: r.file_date,
      recordId: r.record_id,
    },
  };
}

/** Save, dismiss or restore an opportunity. Audited. */
export async function setOpportunityStatus(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  id: string,
  status: unknown,
): Promise<OpportunityStatus> {
  const parsed = z.enum(TRIAGE_STATUSES).safeParse(status);
  if (!parsed.success) throw new ServiceError('invalid', 'Choose save, dismiss or restore.');
  const to = parsed.data;
  return (await sql.begin(async (tx) => {
    await requireMembershipFor(tx, ctx, workspaceId);
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 'That opportunity does not exist.');
    const [row] = await tx<{ status: OpportunityStatus }[]>`
      SELECT status FROM opportunities WHERE workspace_id = ${workspaceId} AND id = ${id} FOR UPDATE
    `;
    if (!row) throw new ServiceError('not_found', 'That opportunity does not exist.');
    if (row.status === 'in_campaign') throw new ServiceError('invalid', 'This opportunity is part of a campaign.');
    if (row.status === to) return to;
    await tx`UPDATE opportunities SET status = ${to} WHERE id = ${id}`;
    await recordAudit(tx, {
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      via: ctx.via,
      entityType: 'opportunity',
      entityId: id,
      action: 'state_change',
      fromState: row.status,
      toState: to,
    });
    return to;
  })) as OpportunityStatus;
}
