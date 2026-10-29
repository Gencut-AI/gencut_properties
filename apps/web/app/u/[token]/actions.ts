'use server';

import { unsubscribeByToken } from '@gencut/services';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { emailConfig } from '../../../lib/email.ts';

/** Record the opt-out. Public: the signed token is the only authority. */
export async function unsubscribeAction(form: FormData): Promise<void> {
  const token = String(form.get('token') ?? '');
  const config = emailConfig();
  const result = config ? await unsubscribeByToken(db(), config.unsubscribeSecret, token) : { ok: false };
  redirect(`/u/${encodeURIComponent(token)}?done=${result.ok ? '1' : '0'}`);
}
