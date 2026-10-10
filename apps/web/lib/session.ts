import 'server-only';
import { type RequestContext, type WorkspaceMembership, ensureWorkspace } from '@gencut/services';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { db } from './db.ts';
import { supabaseConfig } from './supabase/config.ts';
import { createSupabaseServerClient } from './supabase/server.ts';

/**
 * The verified user for this request, or null. Uses getClaims, which verifies
 * the access token's signature, never the unverified session object.
 */
export const currentUser = cache(async (): Promise<RequestContext | null> => {
  if (!supabaseConfig()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub || typeof claims.email !== 'string') return null;
  return { userId: claims.sub, email: claims.email, via: 'web' };
});

export interface AppSession {
  readonly ctx: RequestContext;
  readonly workspace: WorkspaceMembership;
}

/** For signed-in pages: the user and their workspace, or a redirect to sign in. */
export const requireSession = cache(async (): Promise<AppSession> => {
  const ctx = await currentUser();
  if (!ctx) redirect('/sign-in');
  const workspace = await ensureWorkspace(db(), ctx);
  return { ctx, workspace };
});
