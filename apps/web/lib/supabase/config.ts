/**
 * Public Supabase settings. Both values are safe in the browser (the
 * publishable key only reaches what row-level security allows, and every
 * GenCut table denies it). Each is read literally so Next can inline it.
 */
export function supabaseConfig(): { url: string; publishableKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && publishableKey ? { url, publishableKey } : null;
}
