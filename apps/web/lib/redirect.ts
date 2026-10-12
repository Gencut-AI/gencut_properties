import { NextResponse } from 'next/server';
import { safeNextPath } from './safe-redirect.ts';

/**
 * Redirect to a same-site path using a relative Location header.
 *
 * Never build absolute redirect URLs from request.nextUrl.origin: on Netlify
 * that origin is the internal per-deploy address (<id>--site.netlify.app),
 * not the address the visitor is on, so the browser would leave the domain
 * that holds its session cookies.
 */
export function redirectTo(path: string, status: 302 | 303 | 307 = 303): NextResponse {
  return new NextResponse(null, {
    status,
    headers: { location: safeNextPath(path, '/'), 'cache-control': 'no-store' },
  });
}
