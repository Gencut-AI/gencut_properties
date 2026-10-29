import type { NextRequest } from 'next/server';
import { updateSession } from './lib/supabase/proxy.ts';

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except static assets, icons, the health check and Netlify
  // functions (background jobs carry no session, and passing their POST body
  // through the session proxy is unnecessary work that can lose the body), and
  // the WhatsApp webhook (Meta calls it; its signature check needs the raw body).
  matcher: ['/((?!_next/static|_next/image|\\.netlify/|api/health|api/whatsapp|api/unsubscribe|manifest.webmanifest|icon|apple-touch-icon|.*\\.(?:svg|png|jpg|webp|ico)$).*)'],
};
