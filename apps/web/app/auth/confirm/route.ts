import { createServerClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { safeNextPath } from '../../../lib/safe-redirect.ts';
import { supabaseConfig } from '../../../lib/supabase/config.ts';

const OTP_TYPES: readonly EmailOtpType[] = ['email', 'magiclink', 'signup', 'recovery', 'invite', 'email_change'];

/**
 * Completes email sign-in. Accepts the token-hash link (works in any browser)
 * and the PKCE code link (same browser as the request).
 *
 * The session cookies are written directly onto the redirect response, rather
 * than through next/headers' cookies(), so they are guaranteed to travel with
 * the redirect on every host (they did not on Netlify).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  const code = params.get('code');
  const config = supabaseConfig();

  const failure = new URL('/sign-in', request.nextUrl.origin);
  failure.searchParams.set('error', 'link');
  if (!config || (!code && !(tokenHash && type && OTP_TYPES.includes(type)))) {
    return NextResponse.redirect(failure);
  }

  const success = new URL(safeNextPath(params.get('next')), request.nextUrl.origin);
  const response = NextResponse.redirect(success);
  response.headers.set('cache-control', 'no-store');

  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  const { error } =
    tokenHash && type && OTP_TYPES.includes(type)
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : await supabase.auth.exchangeCodeForSession(code as string);

  return error ? NextResponse.redirect(failure) : response;
}
