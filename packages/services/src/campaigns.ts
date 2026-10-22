/**
 * Campaign drafts from opportunities.
 *
 *   startCampaignDraft (web, signed-in user)  → campaign 'generating'
 *   generateCampaignDraft (background job)    → 'review' with a checked draft, or 'generation_failed'
 *   updateCampaignLetter (web)                → edited letter, re-checked
 *
 * Nothing here sends anything. The letter becomes one outreach action in state
 * DRAFT; approval and sending belong to a later milestone and go through the
 * compliance gate.
 */
import {
  type AgentForDraft,
  CAMPAIGN_PROMPT_VERSION,
  type CampaignDraft,
  type CampaignFact,
  type CampaignState,
  type DraftProblem,
  type StoredParcel,
  campaignFacts,
  campaignPrompt,
  checkCampaignDraft,
  checkCampaignTransition,
  extractJson,
  parseCampaignDraft,
} from '@gencut/core';
import { z } from 'zod';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import { MARKETS } from './markets.ts';
import { requireMembershipFor } from './membership.ts';
import { ModelCallError, type ModelRouter, recordModelRun } from './models.ts';

/** Model attempts per draft: one, plus one retry that lists what the checks rejected. */
export const MAX_DRAFT_ATTEMPTS = 2;
const STALE_GENERATION = '10 minutes';
const DRAFT_ROLE = 'creative' as const;

interface ProfileRow {
  licensee_name: string;
  brokerage_name: string;
  license_number: string | null;
  office_address: string | null;
  specialty: string | null;
  market: string;
}

function agentFrom(p: ProfileRow): AgentForDraft {
  return {
    licenseeName: p.licensee_name,
    brokerageName: p.brokerage_name,
    licenseNumber: p.license_number,
    officeAddress: p.office_address,
    specialty: p.specialty,
    market: MARKETS.find((m) => m.key === p.market)?.label ?? p.market,
  };
}

async function hasPermission(db: Db, workspaceId: string, kind: 'generate' | 'discover'): Promise<boolean> {
  const [row] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM workspace_permissions
                   WHERE workspace_id = ${workspaceId} AND kind = ${kind} AND revoked_at IS NULL) AS ok
  `;
  return row?.ok === true;
}

/**
 * Start a draft for an opportunity. Requires the workspace's `generate`
 * permission. Returns the campaign id; if a draft is already being written for
 * this opportunity, returns that one.
 */
export async function startCampaignDraft(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  opportunityId: string,
): Promise<{ campaignId: string; created: boolean }> {
  return (await sql.begin(async (tx) => {
    await requireMembershipFor(tx, ctx, workspaceId);
    if (!(await hasPermission(tx, workspaceId, 'generate'))) {
      throw new ServiceError('forbidden', 'Preparing campaigns is turned off for this workspace.');
    }
    if (!z.uuid().safeParse(opportunityId).success) throw new ServiceError('not_found', 'That opportunity does not exist.');
    const [opp] = await tx<{ id: string; status: string; payload: StoredParcel }[]>`
      SELECT o.id, o.status, r.payload FROM opportunities o JOIN source_records r ON r.id = o.source_record_id
      WHERE o.workspace_id = ${workspaceId} AND o.id = ${opportunityId} FOR UPDATE OF o
    `;
    if (!opp) throw new ServiceError('not_found', 'That opportunity does not exist.');
    if (opp.status === 'dismissed') throw new ServiceError('invalid', 'Restore this opportunity before starting a campaign.');
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM campaigns WHERE opportunity_id = ${opportunityId} AND status = 'generating'
    `;
    if (existing) return { campaignId: existing.id, created: false };

    const [profile] = await tx<ProfileRow[]>`SELECT * FROM business_profiles WHERE workspace_id = ${workspaceId}`;
    if (!profile) throw new ServiceError('invalid', 'Complete your business profile first.');
    const facts = campaignFacts(opp.payload, agentFrom(profile));
    const address = opp.payload.situs.address || `parcel ${opp.payload.parcelId}`;
    const [c] = await tx<{ id: string }[]>`
      INSERT INTO campaigns (workspace_id, opportunity_id, title, objective, status, facts, prompt_version, created_by)
      VALUES (${workspaceId}, ${opportunityId}, ${`Introduction to the owner of ${address}`},
              'Introduce the agent to the owner by direct mail and invite a conversation.',
              'generating', ${tx.json(facts as never)}, ${CAMPAIGN_PROMPT_VERSION}, ${ctx.userId})
      RETURNING id
    `;
    if (!c) throw new Error('campaign insert returned no row');
    const actor = { workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via } as const;
    await recordAudit(tx, { ...actor, entityType: 'campaign', entityId: c.id, action: 'created', toState: 'generating', detail: { opportunityId } });
    if (opp.status !== 'in_campaign') {
      await tx`UPDATE opportunities SET status = 'in_campaign' WHERE id = ${opportunityId}`;
      await recordAudit(tx, { ...actor, entityType: 'opportunity', entityId: opportunityId, action: 'state_change', fromState: opp.status, toState: 'in_campaign' });
    }
    return { campaignId: c.id, created: true };
  })) as { campaignId: string; created: boolean };
}

export type GenerateOutcome = 'review' | 'generation_failed' | 'skipped';

/**
 * Write and check a draft. Run by the background job; safe to call more than
 * once (a campaign is claimed before any model call, and an abandoned claim
 * expires after ten minutes).
 */
export async function generateCampaignDraft(sql: Sql, campaignId: string, router: ModelRouter): Promise<GenerateOutcome> {
  if (!z.uuid().safeParse(campaignId).success) return 'skipped';
  const [claimed] = await sql<{ id: string; workspace_id: string; facts: CampaignFact[]; opportunity_id: string }[]>`
    UPDATE campaigns SET generation_started_at = now(), generation_attempts = generation_attempts + 1, updated_at = now()
    WHERE id = ${campaignId} AND status = 'generating'
      AND (generation_started_at IS NULL OR generation_started_at < now() - ${STALE_GENERATION}::interval)
    RETURNING id, workspace_id, facts, opportunity_id
  `;
  if (!claimed) return 'skipped';
  const ws = claimed.workspace_id;
  const [profile] = await sql<ProfileRow[]>`SELECT * FROM business_profiles WHERE workspace_id = ${ws}`;
  const facts = claimed.facts;
  const route = router.route(DRAFT_ROLE);
  const run = { workspaceId: ws, campaignId, purpose: 'campaign_draft', role: DRAFT_ROLE, promptVersion: CAMPAIGN_PROMPT_VERSION, factKeys: facts.map((f) => f.key) };

  let problems: string[] = [];
  let lastProblems: DraftProblem[] = [];
  try {
    if (!profile) throw new Error('The workspace has no business profile.');
    const agent = agentFrom(profile);
    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      const prompt = campaignPrompt(facts, problems);
      let response;
      try {
        response = await router.complete({ role: DRAFT_ROLE, system: prompt.system, user: prompt.user, maxOutputTokens: 3000 });
      } catch (e) {
        await recordModelRun(sql, run, { ok: false, provider: route.provider, model: route.model, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      await recordModelRun(sql, run, { ok: true, response });

      let draft: CampaignDraft | null = null;
      try {
        const parsed = parseCampaignDraft(extractJson(response.text));
        if (parsed.ok) draft = parsed.value;
        else lastProblems = [{ code: 'unknown_fact', message: parsed.message }];
      } catch (e) {
        lastProblems = [{ code: 'unknown_fact', message: `The reply was not valid JSON (${e instanceof Error ? e.message : 'parse error'}).` }];
      }
      if (draft) {
        lastProblems = checkCampaignDraft(draft, facts, agent);
        if (lastProblems.length === 0) {
          await finishReview(sql, campaignId, ws, claimed.opportunity_id, draft);
          return 'review';
        }
      }
      problems = lastProblems.map((p) => p.message);
    }
    await finishFailed(sql, campaignId, ws, lastProblems, 'The draft did not pass GenCut\'s checks.');
    return 'generation_failed';
  } catch (e) {
    const message = e instanceof ModelCallError ? e.message : e instanceof Error ? e.message : String(e);
    await finishFailed(sql, campaignId, ws, lastProblems, message);
    return 'generation_failed';
  }
}

async function transition(tx: Db, campaignId: string, to: CampaignState): Promise<CampaignState> {
  const [row] = await tx<{ status: CampaignState }[]>`SELECT status FROM campaigns WHERE id = ${campaignId} FOR UPDATE`;
  if (!row) throw new Error('campaign vanished');
  const check = checkCampaignTransition(row.status, to);
  if (!check.ok) throw new Error(check.message);
  return row.status;
}

async function finishReview(sql: Sql, campaignId: string, ws: string, opportunityId: string, draft: CampaignDraft): Promise<void> {
  await sql.begin(async (tx) => {
    const from = await transition(tx, campaignId, 'review');
    await tx`
      UPDATE campaigns SET status = 'review', draft = ${tx.json(draft as never)}, problems = NULL, error = NULL, updated_at = now()
      WHERE id = ${campaignId}
    `;
    const [opp] = await tx<{ subject_key: string }[]>`SELECT subject_key FROM opportunities WHERE id = ${opportunityId}`;
    await tx`
      INSERT INTO outreach_actions (workspace_id, campaign_id, channel, subject_key, content)
      VALUES (${ws}, ${campaignId}, 'mail', ${opp?.subject_key ?? opportunityId}, ${tx.json({ kind: 'letter', letter: draft.letter } as never)})
    `;
    await recordAudit(tx, {
      workspaceId: ws, actorType: 'agent', actorId: null, via: 'worker', entityType: 'campaign', entityId: campaignId,
      action: 'state_change', fromState: from, toState: 'review', detail: { promptVersion: CAMPAIGN_PROMPT_VERSION },
    });
  });
}

async function finishFailed(sql: Sql, campaignId: string, ws: string, problems: DraftProblem[], error: string): Promise<void> {
  await sql.begin(async (tx) => {
    const from = await transition(tx, campaignId, 'generation_failed');
    await tx`
      UPDATE campaigns SET status = 'generation_failed', problems = ${tx.json(problems as never)}, error = ${error.slice(0, 500)}, updated_at = now()
      WHERE id = ${campaignId}
    `;
    await recordAudit(tx, {
      workspaceId: ws, actorType: 'agent', actorId: null, via: 'worker', entityType: 'campaign', entityId: campaignId,
      action: 'state_change', fromState: from, toState: 'generation_failed', detail: { error: error.slice(0, 200), problems: problems.length },
    });
  });
}

/** Try a failed draft again. */
export async function retryCampaignDraft(sql: Sql, ctx: RequestContext, workspaceId: string, campaignId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await requireMembershipFor(tx, ctx, workspaceId);
    if (!(await hasPermission(tx, workspaceId, 'generate'))) throw new ServiceError('forbidden', 'Preparing campaigns is turned off for this workspace.');
    const row = await campaignRow(tx, workspaceId, campaignId);
    const check = checkCampaignTransition(row.status, 'generating');
    if (!check.ok) throw new ServiceError('invalid', 'Only a failed draft can be retried.');
    await tx`
      UPDATE campaigns SET status = 'generating', generation_started_at = NULL, problems = NULL, error = NULL, updated_at = now()
      WHERE id = ${campaignId}
    `;
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'campaign', entityId: campaignId,
      action: 'state_change', fromState: row.status, toState: 'generating',
    });
  });
}

interface CampaignRow {
  id: string;
  workspace_id: string;
  opportunity_id: string | null;
  title: string;
  objective: string;
  status: CampaignState;
  draft: CampaignDraft | null;
  facts: CampaignFact[] | null;
  problems: DraftProblem[] | null;
  prompt_version: string | null;
  generation_attempts: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

async function campaignRow(db: Db, workspaceId: string, campaignId: string): Promise<CampaignRow> {
  if (!z.uuid().safeParse(campaignId).success) throw new ServiceError('not_found', 'That campaign does not exist.');
  const [row] = await db<CampaignRow[]>`SELECT * FROM campaigns WHERE workspace_id = ${workspaceId} AND id = ${campaignId}`;
  if (!row) throw new ServiceError('not_found', 'That campaign does not exist.');
  return row;
}

export interface CampaignUsage {
  readonly calls: number;
  readonly failedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly models: readonly string[];
}

export interface CampaignView {
  readonly id: string;
  readonly opportunityId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly status: CampaignState;
  readonly draft: CampaignDraft | null;
  readonly facts: readonly CampaignFact[];
  readonly problems: readonly DraftProblem[];
  readonly error: string | null;
  readonly promptVersion: string | null;
  readonly attempts: number;
  readonly letterState: string | null;
  readonly usage: CampaignUsage;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export async function getCampaign(db: Db, ctx: RequestContext, workspaceId: string, campaignId: string): Promise<CampaignView> {
  await requireMembershipFor(db, ctx, workspaceId);
  const row = await campaignRow(db, workspaceId, campaignId);
  const [u] = await db<{ calls: number; failed: number; input: number; output: number; cost: string; latency: number; models: string[] | null }[]>`
    SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS failed,
           coalesce(sum(input_tokens), 0)::int AS input, coalesce(sum(output_tokens), 0)::int AS output,
           coalesce(sum(cost_usd), 0)::text AS cost, coalesce(sum(latency_ms), 0)::int AS latency,
           array_agg(DISTINCT provider || '/' || model) FILTER (WHERE model <> '') AS models
    FROM model_runs WHERE campaign_id = ${campaignId}
  `;
  const [action] = await db<{ state: string }[]>`
    SELECT state FROM outreach_actions WHERE campaign_id = ${campaignId} ORDER BY created_at DESC LIMIT 1
  `;
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    title: row.draft?.title ?? row.title,
    objective: row.objective,
    status: row.status,
    draft: row.draft,
    facts: row.facts ?? [],
    problems: row.problems ?? [],
    error: row.error,
    promptVersion: row.prompt_version,
    attempts: row.generation_attempts,
    letterState: action?.state ?? null,
    usage: {
      calls: u?.calls ?? 0,
      failedCalls: u?.failed ?? 0,
      inputTokens: u?.input ?? 0,
      outputTokens: u?.output ?? 0,
      costUsd: Number(u?.cost ?? 0),
      latencyMs: u?.latency ?? 0,
      models: u?.models ?? [],
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CampaignListItem {
  readonly id: string;
  readonly title: string;
  readonly status: CampaignState;
  readonly opportunityId: string | null;
  readonly updatedAt: Date;
}

export async function listCampaigns(
  db: Db,
  ctx: RequestContext,
  workspaceId: string,
  options: { opportunityId?: string } = {},
): Promise<CampaignListItem[]> {
  await requireMembershipFor(db, ctx, workspaceId);
  const opp = options.opportunityId && z.uuid().safeParse(options.opportunityId).success ? options.opportunityId : null;
  const rows = await db<{ id: string; title: string; draft: CampaignDraft | null; status: CampaignState; opportunity_id: string | null; updated_at: Date }[]>`
    SELECT id, title, draft, status, opportunity_id, updated_at FROM campaigns
    WHERE workspace_id = ${workspaceId} AND status <> 'archived' ${opp ? db`AND opportunity_id = ${opp}` : db``}
    ORDER BY updated_at DESC LIMIT 100
  `;
  return rows.map((r) => ({ id: r.id, title: r.draft?.title ?? r.title, status: r.status, opportunityId: r.opportunity_id, updatedAt: r.updated_at }));
}

const letterInput = z.object({
  greeting: z.string().trim().min(1, 'Add a greeting.').max(200),
  paragraphs: z.array(z.string().trim().min(1).max(1500)).min(1, 'The letter needs at least one paragraph.').max(8),
  closing: z.string().trim().min(1, 'Add a closing.').max(200),
  signature: z.array(z.string().trim().min(1).max(200)).min(1, 'Add a signature.').max(6),
});

/**
 * Save the agent's edits to the letter. The edited letter must pass the same
 * checks as a generated one; the outreach action stays a DRAFT.
 */
export async function updateCampaignLetter(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  campaignId: string,
  input: unknown,
): Promise<CampaignDraft> {
  const parsed = letterInput.safeParse(input);
  if (!parsed.success) throw new ServiceError('invalid', parsed.error.issues[0]?.message ?? 'The letter is incomplete.');
  return (await sql.begin(async (tx) => {
    await requireMembershipFor(tx, ctx, workspaceId);
    const row = await campaignRow(tx, workspaceId, campaignId);
    if (row.status !== 'review' || !row.draft) throw new ServiceError('invalid', 'Only a draft in review can be edited.');
    const [profile] = await tx<ProfileRow[]>`SELECT * FROM business_profiles WHERE workspace_id = ${workspaceId}`;
    if (!profile) throw new ServiceError('invalid', 'Complete your business profile first.');
    const draft: CampaignDraft = { ...row.draft, letter: parsed.data };
    const problems = checkCampaignDraft(draft, row.facts ?? [], agentFrom(profile));
    if (problems.length) {
      throw new ServiceError('invalid', 'The letter needs changes before it can be saved.', { letter: problems.map((p) => p.message).join(' ') });
    }
    await tx`UPDATE campaigns SET draft = ${tx.json(draft as never)}, updated_at = now() WHERE id = ${campaignId}`;
    await tx`
      UPDATE outreach_actions SET content = ${tx.json({ kind: 'letter', letter: draft.letter } as never)}, updated_at = now()
      WHERE campaign_id = ${campaignId} AND state = 'DRAFT'
    `;
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'campaign', entityId: campaignId,
      action: 'letter_edited',
    });
    return draft;
  })) as CampaignDraft;
}
