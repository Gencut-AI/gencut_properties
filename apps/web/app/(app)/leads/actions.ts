'use server';

import type { InboundLeadStatus } from '@gencut/core';
import { createLeadPage, isServiceError, setInboundLeadStatus } from '@gencut/services';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';

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
