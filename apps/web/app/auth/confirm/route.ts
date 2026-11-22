import { createServerClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { redirectTo } from '../../../lib/redirect.ts';
import { safeNextPath } from '../../../lib/safe-redirect.ts';
import { confirmFailurePath } from '../../../lib/sign-in.ts';
import { supabaseConfig } from '../../../lib/supabase/config.ts';

const OTP_TYPES: readonly EmailOtpType[] = ['email', 'magiclink', 'signup', 'recovery', 'invite', 'email_change'];

/**
 * Completes sign-in. Accepts the token-hash email link (works in any browser)
 * and a PKCE code: the same-browser email link, or Google returning with
 * `via=google` (D-036), whose failures get their own message.
 *
 * Session cookies are written onto the redirect response itself, and the
 * redirect is relative, so the browser stays on the address it came from and
 * keeps the cookies (see lib/redirect.ts).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  const code = params.get('code');
  const config = supabaseConfig();
  const hasOtp = Boolean(tokenHash && type && OTP_TYPES.includes(type));
  const failed = confirmFailurePath(params.get('via'));

  if (!config || (!code && !hasOtp)) return redirectTo(failed);

  const response = redirectTo(safeNextPath(params.get('next')));
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

  const { error } = hasOtp
    ? await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash as string })
    : await supabase.auth.exchangeCodeForSession(code as string);

  return error ? redirectTo(failed) : response;
}
