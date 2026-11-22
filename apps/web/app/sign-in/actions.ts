'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { safeNextPath } from '../../lib/safe-redirect.ts';
import { googleRedirectTo, googleSignInEnabled, parseEmailCode } from '../../lib/sign-in.ts';
import { signInRedirectOrigin } from '../../lib/site-url.ts';
import { createSupabaseServerClient } from '../../lib/supabase/server.ts';

export type SignInState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | { status: 'error'; message: string; email: string };

export type CodeState = { status: 'idle' } | { status: 'error'; message: string };

const email = z.email().max(254);

async function siteOrigin(): Promise<string | null> {
  const h = await headers();
  return signInRedirectOrigin(process.env.GENCUT_SITE_URL, h.get('x-forwarded-host') ?? h.get('host'), h.get('x-forwarded-proto'));
}

export async function sendSignInLink(_prev: SignInState, form: FormData): Promise<SignInState> {
  const raw = String(form.get('email') ?? '').trim().toLowerCase();
  const parsed = email.safeParse(raw);
  if (!parsed.success) return { status: 'error', message: 'Enter a valid email address.', email: raw };

  const origin = await siteOrigin();
  if (!origin) return { status: 'error', message: 'We could not send the sign-in email. Try again in a moment.', email: parsed.data };
  // Supabase only honours redirect targets on the project's allow-list.
  const emailRedirectTo = `${origin}/auth/confirm?next=/home`;

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

/**
 * The code printed in the sign-in email, typed on the "check your inbox" screen
 * (D-036). Works where a link would not: a mail app that opens links in another
 * browser, or a work mail scanner that used the link up before the person did.
 */
export async function verifyEmailCode(_prev: CodeState, form: FormData): Promise<CodeState> {
  const address = email.safeParse(String(form.get('email') ?? '').trim().toLowerCase());
  const token = parseEmailCode(String(form.get('code') ?? ''));
  if (!address.success) return { status: 'error', message: 'Start again with your email address.' };
  if (!token) return { status: 'error', message: 'Enter the code from the email: 6 or more digits.' };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ email: address.data, token, type: 'email' });
  if (error) {
    return {
      status: 'error',
      message:
        error.status === 429
          ? 'Too many tries. Wait a few minutes, then send a new email.'
          : 'That code did not work. It may have expired or been replaced by a newer email: use the code in the newest one, or send a new email.',
    };
  }
  redirect('/home');
}

/**
 * "Continue with Google" (D-036). The PKCE verifier is stored in this browser,
 * so /auth/confirm completes the sign-in when Google sends the person back.
 */
export async function signInWithGoogle(form: FormData): Promise<void> {
  if (!googleSignInEnabled({ GENCUT_GOOGLE_SIGNIN: process.env.GENCUT_GOOGLE_SIGNIN })) redirect('/sign-in');
  const origin = await siteOrigin();
  if (!origin) redirect('/sign-in?error=google');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: googleRedirectTo(origin, safeNextPath(String(form.get('next') ?? ''))),
      queryParams: { prompt: 'select_account' },
      skipBrowserRedirect: true,
    },
  });
  if (error || !data.url) redirect('/sign-in?error=google');
  redirect(data.url);
}
