'use server';

import {
  isServiceError,
  recordOutcome,
  retryCampaignDraft,
  startCampaignDraft,
  startCampaignMedia,
  updateCampaignLetter,
} from '@gencut/services';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { startBackgroundJob } from '../../../lib/background.ts';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';

const JOB = 'generate-campaign-background';
const MEDIA_JOB = 'generate-media-background';

/** Start a draft for an opportunity and open its campaign page. */
export async function startCampaignAction(form: FormData): Promise<void> {
  const { ctx, workspace } = await requireSession();
  const opportunityId = String(form.get('opportunityId') ?? '');
  let campaignId: string;
  try {
    ({ campaignId } = await startCampaignDraft(db(), ctx, workspace.workspaceId, opportunityId));
  } catch (e) {
    if (isServiceError(e)) redirect(`/opportunities/${opportunityId}?campaign_error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  await startBackgroundJob(JOB, { campaignId });
  revalidatePath(`/opportunities/${opportunityId}`);
  redirect(`/campaigns/${campaignId}`);
}

/** Retry a failed draft, or restart one whose background job never started. */
export async function retryCampaignAction(form: FormData): Promise<void> {
  const { ctx, workspace } = await requireSession();
  const campaignId = String(form.get('campaignId') ?? '');
  if (form.get('restart') !== '1') {
    try {
      await retryCampaignDraft(db(), ctx, workspace.workspaceId, campaignId);
    } catch (e) {
      if (!isServiceError(e)) throw e;
    }
  }
  await startBackgroundJob(JOB, { campaignId });
  revalidatePath(`/campaigns/${campaignId}`);
}

export type FormState = { status: 'idle' } | { status: 'saved' } | { status: 'error'; message: string; fields: Record<string, string> };

const lines = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

export async function saveLetterAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { ctx, workspace } = await requireSession();
  const campaignId = String(form.get('campaignId') ?? '');
  try {
    await updateCampaignLetter(db(), ctx, workspace.workspaceId, campaignId, {
      greeting: String(form.get('greeting') ?? ''),
      paragraphs: String(form.get('body') ?? '')
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.replace(/\s*\r?\n\s*/g, ' ').trim())
        .filter(Boolean),
      closing: String(form.get('closing') ?? ''),
      signature: lines(form.get('signature')),
    });
  } catch (e) {
    if (isServiceError(e)) return { status: 'error', message: e.message, fields: { ...e.fields } };
    throw e;
  }
  revalidatePath(`/campaigns/${campaignId}`);
  return { status: 'saved' };
}

export async function recordOutcomeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { ctx, workspace } = await requireSession();
  const opportunityId = String(form.get('opportunityId') ?? '');
  try {
    await recordOutcome(db(), ctx, workspace.workspaceId, opportunityId, {
      outcome: String(form.get('outcome') ?? ''),
      occurredOn: String(form.get('occurredOn') ?? ''),
      note: String(form.get('note') ?? ''),
      ...(form.get('campaignId') ? { campaignId: String(form.get('campaignId')) } : {}),
    });
  } catch (e) {
    if (isServiceError(e)) return { status: 'error', message: e.message, fields: { ...e.fields } };
    throw e;
  }
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath(`/buyers/${opportunityId}`);
  revalidatePath('/home');
  return { status: 'saved' };
}

/**
 * Start the Film Crew on a campaign (a social post and a neighborhood picture),
 * or restart a run whose background job never reported back.
 */
export async function startMediaAction(form: FormData): Promise<void> {
  const { ctx, workspace } = await requireSession();
  const campaignId = String(form.get('campaignId') ?? '');
  if (form.get('restart') !== '1') {
    try {
      await startCampaignMedia(db(), ctx, workspace.workspaceId, campaignId);
    } catch (e) {
      if (isServiceError(e)) redirect(`/campaigns/${campaignId}?media_error=${encodeURIComponent(e.message)}#film-crew`);
      throw e;
    }
  }
  await startBackgroundJob(MEDIA_JOB, { campaignId });
  revalidatePath(`/campaigns/${campaignId}`);
  redirect(`/campaigns/${campaignId}#film-crew`);
}
