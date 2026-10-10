'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { createSupabaseServerClient } from '../../lib/supabase/server.ts';

export type SignInState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | { status: 'error'; message: string; email: string };

const email = z.email().max(254);

export async function sendSignInLink(_prev: SignInState, form: FormData): Promise<SignInState> {
  const raw = String(form.get('email') ?? '').trim().toLowerCase();
  const parsed = email.safeParse(raw);
  if (!parsed.success) return { status: 'error', message: 'Enter a valid email address.', email: raw };

  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https');
  // Supabase only honours redirect targets on the project's allow-list.
  const emailRedirectTo = `${proto}://${host}/auth/confirm?next=/home`;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo, shouldCreateUser: true },
  });
  if (error) {
    const message =
      error.status === 429
        ? 'Too many sign-in emails were requested. Wait a few minutes and try again.'
        : 'We could not send the sign-in email. Try again in a moment.';
    return { status: 'error', message, email: parsed.data };
  }
  return { status: 'sent', email: parsed.data };
}
