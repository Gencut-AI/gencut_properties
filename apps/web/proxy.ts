import type { NextRequest } from 'next/server';
import { updateSession } from './lib/supabase/proxy.ts';

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except static assets, icons and the health check.
  matcher: ['/((?!_next/static|_next/image|api/health|manifest.webmanifest|icon|apple-touch-icon|.*\\.(?:svg|png|jpg|webp|ico)$).*)'],
};
