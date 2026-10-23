/**
 * Film Crew, first slice: a social post and a neighborhood picture for a
 * campaign, and the agent's headshot.
 *
 *   uploadHeadshot (web, Profile)               → the workspace's current headshot
 *   startCampaignMedia (web, signed-in user)    → campaign media 'generating'
 *   generateCampaignMedia (background job)      → post written and checked, picture generated → 'ready', or 'failed'
 *
 * Nothing is posted anywhere. Every paid step is checked against the campaign's
 * media budget first, and every call is logged in model_runs with its cost.
 */
import {
  type AgentForDraft,
  type CampaignFact,
  type DraftProblem,
  MAX_HEADSHOT_BYTES,
  MEDIA_BUDGET_USD_PER_CAMPAIGN,
  type MediaContentType,
  type MediaState,
  NEIGHBORHOOD_IMAGE_PROMPT_VERSION,
  SOCIAL_POST_PROMPT_VERSION,
  type SocialPost,
  type StoredParcel,
  areaFacts,
  checkMediaBudget,
  checkSocialPost,
  extractJson,
  neighborhoodImagePrompt,
  parseSocialPost,
  sniffImageType,
  socialPostPrompt,
} from '@gencut/core';
import { z } from 'zod';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import type { ImageGenerator } from './images.ts';
import { MARKETS } from './markets.ts';
import { requireMembershipFor } from './membership.ts';
import { ModelCallError, type ModelRouter, recordModelRun } from './models.ts';

/** Model attempts per post: one, plus one retry that lists what the checks rejected. */
export const MAX_POST_ATTEMPTS = 2;
const STALE_MEDIA = '10 minutes';
const POST_ROLE = 'creative' as const;
/** Purposes of Film Crew model calls; their costs count against the media budget. */
export const MEDIA_PURPOSES = ['social_post', 'neighborhood_image'] as const;
/** Rough cost of one Film Crew run (post copy plus one picture), used before the job starts. */
export const FILM_CREW_ESTIMATE_USD = 0.06;
/** Size limits of one post call, used both for the request and its budget estimate. */
const POST_INPUT_TOKENS_ESTIMATE = 2000;
const POST_MAX_OUTPUT_TOKENS = 1500;

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

// ---------------------------------------------------------------- headshot

/** Save the agent's headshot (PNG, JPEG or WebP, checked by its bytes) as the workspace's current one. */
export async function uploadHeadshot(sql: Sql, ctx: RequestContext, workspaceId: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) throw new ServiceError('invalid', 'Choose a photo to upload.', { headshot: 'Choose a photo to upload.' });
  if (bytes.length > MAX_HEADSHOT_BYTES) {
    throw new ServiceError('invalid', 'That photo is too large.', { headshot: 'Use a photo under 3 MB.' });
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new ServiceError('invalid', 'That file is not a photo.', { headshot: 'Use a JPEG, PNG or WebP photo.' });
  return (await sql.begin(async (tx) => {
    await requireMembershipFor(tx, ctx, workspaceId);
    await tx`UPDATE media_assets SET replaced_at = now() WHERE workspace_id = ${workspaceId} AND kind = 'headshot' AND replaced_at IS NULL`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO media_assets (workspace_id, kind, source, content_type, bytes, byte_size, created_by)
      VALUES (${workspaceId}, 'headshot', 'upload', ${contentType}, ${Buffer.from(bytes)}, ${bytes.length}, ${ctx.userId})
      RETURNING id
    `;
    if (!row) throw new Error('headshot insert returned no row');
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'business_profile', entityId: workspaceId,
      action: 'headshot_uploaded', detail: { assetId: row.id, contentType, bytes: bytes.length },
    });
    return row.id;
  })) as string;
}

/** The workspace's current headshot id, or null. */
export async function currentHeadshotId(db: Db, ctx: RequestContext, workspaceId: string): Promise<string | null> {
  await requireMembershipFor(db, ctx, workspaceId);
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM media_assets WHERE workspace_id = ${workspaceId} AND kind = 'headshot' AND replaced_at IS NULL
  `;
  return row?.id ?? null;
}

export interface MediaAssetFile {
  readonly contentType: MediaContentType;
  readonly bytes: Uint8Array;
  readonly illustrative: boolean;
}

/** One image, for a member of the workspace it belongs to. */
export async function getMediaAsset(db: Db, ctx: RequestContext, workspaceId: string, assetId: string): Promise<MediaAssetFile> {
  await requireMembershipFor(db, ctx, workspaceId);
  if (!z.uuid().safeParse(assetId).success) throw new ServiceError('not_found', 'That image does not exist.');
  const [row] = await db<{ content_type: MediaContentType; bytes: Buffer; illustrative: boolean }[]>`
    SELECT content_type, bytes, illustrative FROM media_assets WHERE workspace_id = ${workspaceId} AND id = ${assetId}
  `;
  if (!row) throw new ServiceError('not_found', 'That image does not exist.');
  return { contentType: row.content_type, bytes: new Uint8Array(row.bytes), illustrative: row.illustrative };
}

// ---------------------------------------------------------------- campaign media

async function mediaSpentUsd(db: Db, campaignId: string): Promise<number> {
  const [row] = await db<{ spent: string }[]>`
    SELECT coalesce(sum(cost_usd), 0)::text AS spent FROM model_runs
    WHERE campaign_id = ${campaignId} AND purpose IN ${db([...MEDIA_PURPOSES])}
  `;
  return Number(row?.spent ?? 0);
}

/**
 * Start the Film Crew on a campaign whose letter is drafted. Requires the
 * `generate` permission and room in the media budget. Starting again after a
 * finished or failed run makes a new post and picture (and is charged again).
 */
export async function startCampaignMedia(sql: Sql, ctx: RequestContext, workspaceId: string, campaignId: string): Promise<{ started: boolean }> {
  return (await sql.begin(async (tx) => {
    await requireMembershipFor(tx, ctx, workspaceId);
    const [perm] = await tx<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM workspace_permissions WHERE workspace_id = ${workspaceId} AND kind = 'generate' AND revoked_at IS NULL) AS ok
    `;
    if (!perm?.ok) throw new ServiceError('forbidden', 'Preparing campaigns is turned off for this workspace.');
    if (!z.uuid().safeParse(campaignId).success) throw new ServiceError('not_found', 'That campaign does not exist.');
    const [c] = await tx<{ status: string; media_status: MediaState; opportunity_id: string | null }[]>`
      SELECT status, media_status, opportunity_id FROM campaigns WHERE workspace_id = ${workspaceId} AND id = ${campaignId} FOR UPDATE
    `;
    if (!c) throw new ServiceError('not_found', 'That campaign does not exist.');
    if (c.status !== 'review' && c.status !== 'approved') throw new ServiceError('invalid', 'Media is made once the letter is drafted.');
    if (!c.opportunity_id) throw new ServiceError('invalid', 'This campaign has no opportunity to make media for.');
    if (c.media_status === 'generating') return { started: false };
    const budget = checkMediaBudget(await mediaSpentUsd(tx, campaignId), FILM_CREW_ESTIMATE_USD);
    if (!budget.ok) throw new ServiceError('invalid', budget.message);
    await tx`
      UPDATE campaigns SET media_status = 'generating', media_started_at = NULL, media_error = NULL, media_problems = NULL,
                           social_post = NULL, updated_at = now()
      WHERE id = ${campaignId}
    `;
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'campaign', entityId: campaignId,
      action: 'media_requested', fromState: c.media_status, toState: 'generating',
    });
    return { started: true };
  })) as { started: boolean };
}

export type MediaOutcome = 'ready' | 'failed' | 'skipped';

/**
 * Write and check the post, then generate the picture. Run by the background
 * job; safe to call more than once (the campaign is claimed before any model
 * call, and an abandoned claim expires after ten minutes).
 */
export async function generateCampaignMedia(sql: Sql, campaignId: string, router: ModelRouter, images: ImageGenerator): Promise<MediaOutcome> {
  if (!z.uuid().safeParse(campaignId).success) return 'skipped';
  const [claimed] = await sql<{ workspace_id: string; payload: StoredParcel }[]>`
    UPDATE campaigns c SET media_started_at = now(), updated_at = now()
    FROM opportunities o JOIN source_records r ON r.id = o.source_record_id
    WHERE c.id = ${campaignId} AND c.media_status = 'generating' AND o.id = c.opportunity_id
      AND (c.media_started_at IS NULL OR c.media_started_at < now() - ${STALE_MEDIA}::interval)
    RETURNING c.workspace_id, r.payload
  `;
  if (!claimed) return 'skipped';
  const ws = claimed.workspace_id;
  let problems: DraftProblem[] = [];
  try {
    const [profile] = await sql<ProfileRow[]>`SELECT * FROM business_profiles WHERE workspace_id = ${ws}`;
    if (!profile) throw new Error('The workspace has no business profile.');
    const agent = agentFrom(profile);
    const facts: CampaignFact[] = areaFacts(claimed.payload, agent);
    const subject = { address: claimed.payload.situs.address, ownerName: claimed.payload.owner.name };
    const factKeys = facts.map((f) => f.key);

    // 1. Copywriter: the post, checked like the letter; one retry with the problems listed.
    let post: SocialPost | null = null;
    const route = router.route(POST_ROLE);
    const postRun = { workspaceId: ws, campaignId, purpose: 'social_post', role: POST_ROLE, promptVersion: SOCIAL_POST_PROMPT_VERSION, factKeys };
    for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS && !post; attempt++) {
      const budget = checkMediaBudget(await mediaSpentUsd(sql, campaignId), router.estimateUsd(POST_ROLE, POST_INPUT_TOKENS_ESTIMATE, POST_MAX_OUTPUT_TOKENS));
      if (!budget.ok) throw new ServiceError('invalid', budget.message);
      const prompt = socialPostPrompt(facts, problems.map((p) => p.message));
      let response;
      try {
        response = await router.complete({ role: POST_ROLE, system: prompt.system, user: prompt.user, maxOutputTokens: POST_MAX_OUTPUT_TOKENS });
      } catch (e) {
        await recordModelRun(sql, postRun, { ok: false, provider: route.provider, model: route.model, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      await recordModelRun(sql, postRun, { ok: true, response });
      try {
        const parsed = parseSocialPost(extractJson(response.text));
        if (!parsed.ok) problems = [{ code: 'unknown_fact', message: parsed.message }];
        else {
          problems = checkSocialPost(parsed.value, facts, agent, subject);
          if (problems.length === 0) post = parsed.value;
        }
      } catch (e) {
        problems = [{ code: 'unknown_fact', message: `The reply was not valid JSON (${e instanceof Error ? e.message : 'parse error'}).` }];
      }
    }
    if (!post) throw new ServiceError('invalid', 'The social post did not pass GenCut’s checks.');
    // Save the post now, so the page shows the copy while the picture is made.
    await sql`UPDATE campaigns SET social_post = ${sql.json(post as never)}, media_problems = NULL, updated_at = now() WHERE id = ${campaignId}`;

    // 2. Photographer: one illustrative picture of the area.
    const budget = checkMediaBudget(await mediaSpentUsd(sql, campaignId), images.priceUsd);
    if (!budget.ok) throw new ServiceError('invalid', budget.message);
    const imagePrompt = neighborhoodImagePrompt(post.imageBrief, facts);
    const imageRun = { workspaceId: ws, campaignId, purpose: 'neighborhood_image', role: 'image' as const, promptVersion: NEIGHBORHOOD_IMAGE_PROMPT_VERSION, factKeys };
    let image;
    try {
      image = await images.generate({ prompt: imagePrompt, aspectRatio: '4:5' });
    } catch (e) {
      await recordModelRun(sql, imageRun, { ok: false, provider: images.provider, model: images.model, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    await recordModelRun(sql, imageRun, {
      ok: true,
      response: { text: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, provider: image.provider, model: image.model, latencyMs: image.latencyMs, costUsd: image.costUsd },
    });

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO media_assets (workspace_id, campaign_id, kind, source, content_type, bytes, byte_size, illustrative, provider, model, prompt)
        VALUES (${ws}, ${campaignId}, 'neighborhood_image', 'generated', ${image.contentType}, ${Buffer.from(image.bytes)}, ${image.bytes.length},
                true, ${image.provider}, ${image.model}, ${imagePrompt})
      `;
      await tx`UPDATE campaigns SET media_status = 'ready', media_error = NULL, updated_at = now() WHERE id = ${campaignId}`;
      await recordAudit(tx, {
        workspaceId: ws, actorType: 'agent', actorId: null, via: 'worker', entityType: 'campaign', entityId: campaignId,
        action: 'media_ready', fromState: 'generating', toState: 'ready',
        detail: { postPromptVersion: SOCIAL_POST_PROMPT_VERSION, imagePromptVersion: NEIGHBORHOOD_IMAGE_PROMPT_VERSION },
      });
    });
    return 'ready';
  } catch (e) {
    const message = e instanceof ModelCallError || e instanceof ServiceError || e instanceof Error ? e.message : String(e);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE campaigns SET media_status = 'failed', media_error = ${message.slice(0, 500)},
                             media_problems = ${problems.length ? tx.json(problems as never) : null}, updated_at = now()
        WHERE id = ${campaignId}
      `;
      await recordAudit(tx, {
        workspaceId: ws, actorType: 'agent', actorId: null, via: 'worker', entityType: 'campaign', entityId: campaignId,
        action: 'media_failed', fromState: 'generating', toState: 'failed', detail: { error: message.slice(0, 200), problems: problems.length },
      });
    });
    return 'failed';
  }
}

export interface CampaignMediaView {
  readonly status: MediaState;
  readonly error: string | null;
  readonly problems: readonly DraftProblem[];
  readonly socialPost: SocialPost | null;
  readonly neighborhoodImageId: string | null;
  readonly headshotId: string | null;
  readonly startedAt: Date | null;
  readonly calls: number;
  readonly failedCalls: number;
  readonly costUsd: number;
  readonly budgetUsd: number;
}

/** The Film Crew's work on one campaign, for a member of its workspace. */
export async function getCampaignMedia(db: Db, ctx: RequestContext, workspaceId: string, campaignId: string): Promise<CampaignMediaView> {
  await requireMembershipFor(db, ctx, workspaceId);
  if (!z.uuid().safeParse(campaignId).success) throw new ServiceError('not_found', 'That campaign does not exist.');
  const [c] = await db<{ media_status: MediaState; media_error: string | null; media_problems: DraftProblem[] | null; social_post: SocialPost | null; media_started_at: Date | null }[]>`
    SELECT media_status, media_error, media_problems, social_post, media_started_at FROM campaigns WHERE workspace_id = ${workspaceId} AND id = ${campaignId}
  `;
  if (!c) throw new ServiceError('not_found', 'That campaign does not exist.');
  const [img] = await db<{ id: string }[]>`
    SELECT id FROM media_assets WHERE campaign_id = ${campaignId} AND kind = 'neighborhood_image' ORDER BY created_at DESC LIMIT 1
  `;
  const [u] = await db<{ calls: number; failed: number; cost: string }[]>`
    SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS failed, coalesce(sum(cost_usd), 0)::text AS cost
    FROM model_runs WHERE campaign_id = ${campaignId} AND purpose IN ${db([...MEDIA_PURPOSES])}
  `;
  return {
    status: c.media_status,
    error: c.media_error,
    problems: c.media_problems ?? [],
    socialPost: c.social_post,
    // A picture from an earlier run is not shown while a new one is being made.
    neighborhoodImageId: c.media_status === 'ready' ? (img?.id ?? null) : null,
    headshotId: await currentHeadshotId(db, ctx, workspaceId),
    startedAt: c.media_started_at,
    calls: u?.calls ?? 0,
    failedCalls: u?.failed ?? 0,
    costUsd: Number(u?.cost ?? 0),
    budgetUsd: MEDIA_BUDGET_USD_PER_CAMPAIGN,
  };
}
