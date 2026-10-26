/**
 * Outcomes: what actually happened with an opportunity, recorded by the
 * agent. Each outcome keeps the score and scoring rule that ranked the
 * opportunity at the time, so later rules can be judged against reality.
 */
import { APPOINTMENT_OR_BETTER, DEAL_OUTCOMES, OUTCOMES, type OpportunityType, type Outcome, REPLIED_OUTCOMES } from '@gencut/core';
import { z } from 'zod';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import { requireMembershipFor } from './membership.ts';

/** A report is shown only once this many opportunities have outcomes. */
export const OUTCOME_REPORT_MINIMUM = 20;

const outcomeInput = z.object({
  outcome: z.enum(OUTCOMES, { error: 'Choose what happened.' }),
  occurredOn: z.iso.date({ error: 'Enter the date it happened.' }),
  note: z.string().trim().max(500).optional().transform((v) => v || undefined),
  campaignId: z.uuid().optional(),
});

export interface OutcomeRecord {
  readonly id: string;
  readonly outcome: Outcome;
  readonly occurredOn: string;
  readonly note: string | null;
  readonly score: number;
  readonly scoringVersion: string;
  readonly createdAt: Date;
}

export async function recordOutcome(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  opportunityId: string,
  input: unknown,
): Promise<OutcomeRecord> {
  const parsed = outcomeInput.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[String(i.path[0] ?? 'form')] ??= i.message;
    throw new ServiceError('invalid', 'Some details need fixing.', fields);
  }
  const v = parsed.data;
  if (v.occurredOn > new Date().toISOString().slice(0, 10)) {
    throw new ServiceError('invalid', 'Some details need fixing.', { occurredOn: 'The date cannot be in the future.' });
  }
  return (await sql.begin(async (tx) => {
    await requireMembershipFor(tx, ctx, workspaceId);
    if (!z.uuid().safeParse(opportunityId).success) throw new ServiceError('not_found', 'That opportunity does not exist.');
    const [opp] = await tx<{ score: number; scoring_version: string }[]>`
      SELECT score, scoring_version FROM opportunities WHERE workspace_id = ${workspaceId} AND id = ${opportunityId}
    `;
    if (!opp) throw new ServiceError('not_found', 'That opportunity does not exist.');
    if (v.campaignId) {
      const [c] = await tx`SELECT 1 FROM campaigns WHERE id = ${v.campaignId} AND workspace_id = ${workspaceId} AND opportunity_id = ${opportunityId}`;
      if (!c) throw new ServiceError('invalid', 'That campaign is not for this opportunity.');
    }
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO opportunity_outcomes (workspace_id, opportunity_id, campaign_id, outcome, score, scoring_version, occurred_on, note, recorded_by)
      VALUES (${workspaceId}, ${opportunityId}, ${v.campaignId ?? null}, ${v.outcome}, ${opp.score}, ${opp.scoring_version},
              ${v.occurredOn}, ${v.note ?? null}, ${ctx.userId})
      RETURNING id, created_at
    `;
    if (!row) throw new Error('outcome insert returned no row');
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'opportunity', entityId: opportunityId,
      action: 'outcome_recorded', detail: { outcome: v.outcome, score: opp.score, scoringVersion: opp.scoring_version },
    });
    return { id: row.id, outcome: v.outcome, occurredOn: v.occurredOn, note: v.note ?? null, score: opp.score, scoringVersion: opp.scoring_version, createdAt: row.created_at };
  })) as OutcomeRecord;
}

export async function listOutcomes(db: Db, ctx: RequestContext, workspaceId: string, opportunityId: string): Promise<OutcomeRecord[]> {
  await requireMembershipFor(db, ctx, workspaceId);
  if (!z.uuid().safeParse(opportunityId).success) return [];
  const rows = await db<{ id: string; outcome: Outcome; occurred_on: string; note: string | null; score: number; scoring_version: string; created_at: Date }[]>`
    SELECT id, outcome, to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on, note, score, scoring_version, created_at
    FROM opportunity_outcomes WHERE workspace_id = ${workspaceId} AND opportunity_id = ${opportunityId}
    ORDER BY occurred_on DESC, created_at DESC
  `;
  return rows.map((r) => ({ id: r.id, outcome: r.outcome, occurredOn: r.occurred_on, note: r.note, score: r.score, scoringVersion: r.scoring_version, createdAt: r.created_at }));
}

export interface OutcomeBand {
  readonly band: string;
  readonly opportunities: number;
  readonly replied: number;
  /** Appointment, offer, listing or closed. */
  readonly appointments: number;
  /** Listing taken or transaction closed. */
  readonly listings: number;
}

export interface OutcomeReport {
  /** Which kind of opportunity the report covers; seller and buyer results are never mixed. */
  readonly type: OpportunityType;
  /** Opportunities with at least one outcome. */
  readonly opportunities: number;
  readonly ready: boolean;
  readonly minimum: number;
  readonly scoringVersions: readonly string[];
  readonly bands: readonly OutcomeBand[];
}

/**
 * Outcomes by score band, per opportunity (its best outcome so far). Shown only
 * once OUTCOME_REPORT_MINIMUM opportunities have outcomes; smaller samples say
 * nothing about the scores.
 */
export async function outcomeReport(
  db: Db,
  ctx: RequestContext,
  workspaceId: string,
  type: OpportunityType = 'potential_seller',
): Promise<OutcomeReport> {
  await requireMembershipFor(db, ctx, workspaceId);
  const rows = await db<{ opportunity_id: string; score: number; scoring_version: string; outcomes: Outcome[] }[]>`
    SELECT x.opportunity_id, max(x.score)::int AS score, max(x.scoring_version) AS scoring_version, array_agg(x.outcome) AS outcomes
    FROM opportunity_outcomes x JOIN opportunities o ON o.id = x.opportunity_id
    WHERE x.workspace_id = ${workspaceId} AND o.type = ${type}
    GROUP BY x.opportunity_id
  `;
  // Seller scores start at the discovery minimum (55); buyer scores at 30 (two purchases).
  const names = type === 'investor_buyer' ? ['85–100', '70–84', '50–69', '30–49'] : ['85–100', '75–84', '65–74', '55–64'];
  const floors = type === 'investor_buyer' ? [85, 70, 50, 0] : [85, 75, 65, 0];
  const bandOf = (s: number) => names.at(floors.findIndex((f) => s >= f)) ?? names.at(-1)!;
  const bands = new Map<string, { opportunities: number; replied: number; appointments: number; listings: number }>();
  for (const b of names) bands.set(b, { opportunities: 0, replied: 0, appointments: 0, listings: 0 });
  for (const r of rows) {
    const b = bands.get(bandOf(r.score));
    if (!b) continue;
    b.opportunities++;
    if (r.outcomes.some((o) => REPLIED_OUTCOMES.includes(o))) b.replied++;
    if (r.outcomes.some((o) => APPOINTMENT_OR_BETTER.includes(o))) b.appointments++;
    if (r.outcomes.some((o) => DEAL_OUTCOMES.includes(o))) b.listings++;
  }
  return {
    type,
    opportunities: rows.length,
    ready: rows.length >= OUTCOME_REPORT_MINIMUM,
    minimum: OUTCOME_REPORT_MINIMUM,
    scoringVersions: [...new Set(rows.map((r) => r.scoring_version))].sort(),
    bands: [...bands].map(([band, v]) => ({ band, ...v })),
  };
}
