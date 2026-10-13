import { redirectTo } from '../../../lib/redirect.ts';
import { createSupabaseServerClient } from '../../../lib/supabase/server.ts';

/** POST only, so a link or image elsewhere cannot sign the user out. */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return redirectTo('/');
}
