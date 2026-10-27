'use server';

import { createLinkCode, unlinkWhatsApp } from '@gencut/services';
import { revalidatePath } from 'next/cache';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';

export type LinkCodeState = { status: 'idle' } | { status: 'code'; code: string; minutes: number };

/** A one-time code the signed-in agent sends from WhatsApp to link their number. */
export async function createLinkCodeAction(_prev: LinkCodeState): Promise<LinkCodeState> {
  const { ctx } = await requireSession();
  const { code, expiresInMinutes } = await createLinkCode(db(), ctx);
  return { status: 'code', code, minutes: expiresInMinutes };
}

export async function unlinkWhatsAppAction(): Promise<void> {
  const { ctx } = await requireSession();
  await unlinkWhatsApp(db(), ctx);
  revalidatePath('/profile');
}
