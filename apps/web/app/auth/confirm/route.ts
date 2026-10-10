import type { EmailOtpType } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { safeNextPath } from '../../../lib/safe-redirect.ts';
import { createSupabaseServerClient } from '../../../lib/supabase/server.ts';

const OTP_TYPES: readonly EmailOtpType[] = ['email', 'magiclink', 'signup', 'recovery', 'invite', 'email_change'];

/**
 * Completes email sign-in. Accepts the token-hash link (works when the email
 * is opened in another browser) and the PKCE code link (same browser).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get('next'));
  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  const code = params.get('code');

  const supabase = await createSupabaseServerClient();
  let ok = false;
  if (tokenHash && type && OTP_TYPES.includes(type)) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }

  const target = request.nextUrl.clone();
  target.search = '';
  if (ok) {
    const dest = new URL(next, request.nextUrl.origin);
    target.pathname = dest.pathname;
    target.search = dest.search;
  } else {
    target.pathname = '/sign-in';
    target.searchParams.set('error', 'link');
  }
  return NextResponse.redirect(target);
}
