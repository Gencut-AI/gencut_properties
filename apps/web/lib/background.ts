import 'server-only';
import { headers } from 'next/headers';
import { signInRedirectOrigin } from './site-url.ts';

/**
 * Start a Netlify background function for this deploy. Returns false if it
 * could not be reached; the caller shows a retry instead of waiting forever.
 */
export async function startBackgroundJob(name: string, body: Record<string, string>): Promise<boolean> {
  const h = await headers();
  const origin = signInRedirectOrigin(process.env.GENCUT_SITE_URL, h.get('x-forwarded-host') ?? h.get('host'), h.get('x-forwarded-proto'));
  if (!origin) return false;
  try {
    const res = await fetch(`${origin}/.netlify/functions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 202 || res.ok;
  } catch {
    return false;
  }
}

/** Whether campaign drafting is configured on this deploy (a model provider key exists). */
export function draftingEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
