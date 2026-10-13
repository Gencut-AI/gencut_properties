import { NextResponse } from 'next/server';
import { redirectHeaders } from './redirect-location.ts';

/** Same-site redirect that keeps the browser on its current host. See redirect-location.ts. */
export function redirectTo(path: string, status: 302 | 303 | 307 = 303): NextResponse {
  return new NextResponse(null, { status, headers: redirectHeaders(path) });
}
