import { safeNextPath } from './safe-redirect.ts';

/**
 * Headers for a same-site redirect with a relative Location.
 *
 * Never build absolute redirect URLs from request.nextUrl.origin: on Netlify
 * that origin is the internal per-deploy address (<id>--site.netlify.app),
 * not the address the visitor is on, so the browser would leave the domain
 * that holds its session cookies.
 */
export function redirectHeaders(path: string): Record<string, string> {
  return { location: safeNextPath(path, '/'), 'cache-control': 'no-store' };
}
