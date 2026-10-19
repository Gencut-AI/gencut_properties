import type { NextRequest } from 'next/server';
import { updateSession } from './lib/supabase/proxy.ts';

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except static assets, icons, the health check and Netlify
  // functions (background jobs carry no session, and passing their POST body
  // through the session proxy is unnecessary work that can lose the body).
  matcher: ['/((?!_next/static|_next/image|\\.netlify/|api/health|manifest.webmanifest|icon|apple-touch-icon|.*\\.(?:svg|png|jpg|webp|ico)$).*)'],
};
