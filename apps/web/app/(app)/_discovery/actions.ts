'use server';

import { isServiceError, setOpportunityStatus } from '@gencut/services';
import { revalidatePath } from 'next/cache';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';

/** Save, dismiss or restore an opportunity, then re-render the pages that show it. */
export async function triageAction(form: FormData): Promise<void> {
  const { ctx, workspace } = await requireSession();
  const id = String(form.get('id') ?? '');
  try {
    await setOpportunityStatus(db(), ctx, workspace.workspaceId, id, String(form.get('status') ?? ''));
  } catch (e) {
    // A stale page (e.g. the opportunity was just re-scored away) re-renders with current data.
    if (!isServiceError(e)) throw e;
  }
  revalidatePath('/opportunities');
  revalidatePath(`/opportunities/${id}`);
  revalidatePath('/buyers');
  revalidatePath(`/buyers/${id}`);
  revalidatePath('/home');
}
