'use server';

import type { InboundLeadStatus } from '@gencut/core';
import { checkInstagramNow, createLeadPage, dismissInstagramComment, getLeadPage, isServiceError, sendInstagramLink, setInboundLeadStatus } from '@gencut/services';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { instagramClient, instagramConfig } from '../../../lib/instagram.ts';
import { requireSession } from '../../../lib/session.ts';
import { signInRedirectOrigin } from '../../../lib/site-url.ts';

export async function createLeadPageAction(): Promise<void> {
  const { ctx, workspace } = await requireSession();
  try {
    await createLeadPage(db(), ctx, workspace.workspaceId);
  } catch (e) {
    if (isServiceError(e)) redirect(`/leads?lead_page_error=${encodeURIComponent(e.message)}#social`);
    throw e;
  }
  revalidatePath('/leads');
  redirect('/leads#social');
}

export async function setInboundStatusAction(form: FormData): Promise<void> {
  const { ctx, workspace } = await requireSession();
  const status = String(form.get('status') ?? '');
  if (!['new', 'contacted', 'dismissed'].includes(status)) return;
  await setInboundLeadStatus(db(), ctx, workspace.workspaceId, String(form.get('id') ?? ''), status as InboundLeadStatus);
  revalidatePath('/leads');
}

const back = (msg?: string) => redirect(msg ? `/leads?ig_error=${encodeURIComponent(msg)}#instagram` : '/leads#instagram');

/** Check the connected Instagram account for new keyword comments now. */
export async function checkInstagramAction(): Promise<void> {
  const { ctx, workspace } = await requireSession();
  const config = instagramConfig();
  if (!config) back('Instagram is not connected on this site.');
  let error: string | null = null;
  try {
    error = (await checkInstagramNow(db(), ctx, workspace.workspaceId, config, instagramClient(config!))).error;
  } catch (e) {
    if (!isServiceError(e)) throw e;
    error = e.message;
  }
  revalidatePath('/leads');
  back(error ?? undefined);
}

/** Send the lead-page link to one commenter by private reply. The click is the agent's approval. */
export async function sendInstagramLinkAction(form: FormData): Promise<void> {
  const { ctx, workspace } = await requireSession();
  const config = instagramConfig();
  if (!config) back('Instagram is not connected on this site.');
  const page = await getLeadPage(db(), ctx, workspace.workspaceId);
  if (!page) back('Create your lead page first: the reply sends its link.');
  const h = await headers();
  const origin = signInRedirectOrigin(process.env.GENCUT_SITE_URL, h.get('x-forwarded-host') ?? h.get('host'), h.get('x-forwarded-proto')) ?? '';
  let error: string | null = null;
  try {
    const r = await sendInstagramLink(
      db(), ctx, workspace.workspaceId, String(form.get('commentId') ?? ''), `${origin}/l/${page!.slug}?src=instagram`, config, instagramClient(config!),
    );
    error = r.error;
  } catch (e) {
    if (!isServiceError(e)) throw e;
    error = e.message;
  }
  revalidatePath('/leads');
  back(error ?? undefined);
}

export async function dismissInstagramAction(form: FormData): Promise<void> {
  const { ctx, workspace } = await requireSession();
  await dismissInstagramComment(db(), ctx, workspace.workspaceId, String(form.get('commentId') ?? ''));
  revalidatePath('/leads');
}
