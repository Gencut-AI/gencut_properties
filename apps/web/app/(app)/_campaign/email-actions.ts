'use server';

import {
  approveAndSendEmail,
  enableEmailOutreach,
  isServiceError,
  prepareEmailOutreach,
  ResendTransport,
} from '@gencut/services';
import { revalidatePath } from 'next/cache';
import { db } from '../../../lib/db.ts';
import { emailConfig } from '../../../lib/email.ts';
import { requireSession } from '../../../lib/session.ts';

export type EmailFormState =
  | { status: 'idle' }
  | { status: 'done' }
  | { status: 'error'; message: string; fields: Record<string, string> };

const path = (form: FormData) => `/campaigns/${String(form.get('campaignId') ?? '')}`;

export async function enableEmailAction(_prev: EmailFormState, form: FormData): Promise<EmailFormState> {
  const { ctx, workspace } = await requireSession();
  try {
    await enableEmailOutreach(db(), ctx, workspace.workspaceId);
  } catch (e) {
    if (isServiceError(e)) return { status: 'error', message: e.message, fields: {} };
    throw e;
  }
  revalidatePath(path(form));
  return { status: 'done' };
}

export async function prepareEmailAction(_prev: EmailFormState, form: FormData): Promise<EmailFormState> {
  const { ctx, workspace } = await requireSession();
  try {
    await prepareEmailOutreach(
      db(),
      ctx,
      workspace.workspaceId,
      String(form.get('campaignId') ?? ''),
      { to: String(form.get('to') ?? ''), subject: String(form.get('subject') ?? '') },
      emailConfig(),
    );
  } catch (e) {
    if (isServiceError(e)) return { status: 'error', message: e.message, fields: { ...e.fields } };
    throw e;
  }
  revalidatePath(path(form));
  return { status: 'done' };
}

export async function approveAndSendAction(_prev: EmailFormState, form: FormData): Promise<EmailFormState> {
  const { ctx, workspace } = await requireSession();
  if (form.get('confirm') !== 'yes') {
    return { status: 'error', message: 'Tick the box to confirm you approve this exact email.', fields: { confirm: 'Required' } };
  }
  const config = emailConfig();
  try {
    await approveAndSendEmail(
      db(),
      ctx,
      workspace.workspaceId,
      String(form.get('actionId') ?? ''),
      config,
      new ResendTransport(config?.apiKey ?? ''),
    );
  } catch (e) {
    if (isServiceError(e)) return { status: 'error', message: e.message, fields: {} };
    throw e;
  }
  revalidatePath(path(form));
  // Sent or blocked, the panel shows the result from the stored state.
  return { status: 'done' };
}
