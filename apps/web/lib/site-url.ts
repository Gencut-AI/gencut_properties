/**
 * The address sign-in emails should send people back to.
 *
 * On Netlify this is fixed at build time (next.config.ts sets GENCUT_SITE_URL
 * from CONTEXT, URL and DEPLOY_PRIME_URL), so a deploy preview always links
 * back to its own preview address and production to the production address,
 * whatever host header a particular request arrived with. Locally, where no
 * build-time address exists, the request's own origin is used.
 */
export function signInRedirectOrigin(
  buildTimeSiteUrl: string | undefined,
  requestHost: string | null,
  requestProto: string | null,
): string | null {
  const configured = buildTimeSiteUrl?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (!requestHost) return null;
  const proto = requestProto ?? (requestHost.startsWith('localhost') || requestHost.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${proto}://${requestHost}`;
}

/** Auth parameters Supabase may append when it falls back to the Site URL. */
export const AUTH_CALLBACK_PARAMS = ['code', 'token_hash', 'type', 'error', 'error_code', 'error_description'] as const;
