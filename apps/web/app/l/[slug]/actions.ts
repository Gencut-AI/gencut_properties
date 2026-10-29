'use server';

import { leadSourceOf } from '@gencut/core';
import { submitInboundLead, submitterKey } from '@gencut/services';
import { headers } from 'next/headers';
import { db } from '../../../lib/db.ts';

export type LeadFormState =
  | { status: 'idle' }
  | { status: 'sent'; name: string }
  | { status: 'error'; message: string; fields: Record<string, string> };

/** A visitor's request from the public lead page. No sign-in; limits are per visitor per day. */
export async function submitLeadAction(_prev: LeadFormState, form: FormData): Promise<LeadFormState> {
  // Bots fill every field; people never see this one.
  if (String(form.get('website') ?? '') !== '') return { status: 'sent', name: '' };
  const h = await headers();
  const address = h.get('x-nf-client-connection-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const name = String(form.get('name') ?? '');
  const result = await submitInboundLead(
    db(),
    String(form.get('slug') ?? ''),
    {
      name,
      email: String(form.get('email') ?? ''),
      phone: String(form.get('phone') ?? ''),
      interest: String(form.get('interest') ?? ''),
      zip: String(form.get('zip') ?? ''),
      message: String(form.get('message') ?? ''),
      consent: form.get('consent') === 'yes',
    },
    { source: leadSourceOf(String(form.get('source') ?? ''), null), submitter: submitterKey(address, new Date().toISOString().slice(0, 10)) },
  );
  if (!result.ok) return { status: 'error', message: result.message ?? 'Check the highlighted fields.', fields: result.fields };
  return { status: 'sent', name: name.trim().split(/\s+/)[0] ?? '' };
}
