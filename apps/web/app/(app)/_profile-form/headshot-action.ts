'use server';

import { isServiceError, uploadHeadshot } from '@gencut/services';
import { revalidatePath } from 'next/cache';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';

export type HeadshotFormState = { status: 'idle' } | { status: 'saved' } | { status: 'error'; message: string };

/** Save the agent's headshot. The service checks the file's size and bytes. */
export async function uploadHeadshotAction(_prev: HeadshotFormState, form: FormData): Promise<HeadshotFormState> {
  const { ctx, workspace } = await requireSession();
  const file = form.get('headshot');
  if (!(file instanceof File) || file.size === 0) return { status: 'error', message: 'Choose a photo to upload.' };
  try {
    await uploadHeadshot(db(), ctx, workspace.workspaceId, new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    if (isServiceError(e)) return { status: 'error', message: e.fields.headshot ?? e.message };
    throw e;
  }
  revalidatePath('/profile');
  return { status: 'saved' };
}
