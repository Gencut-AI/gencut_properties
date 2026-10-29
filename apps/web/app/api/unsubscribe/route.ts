import { unsubscribeByToken } from '@gencut/services';
import { db } from '../../../lib/db.ts';
import { emailConfig } from '../../../lib/email.ts';

export const dynamic = 'force-dynamic';

/**
 * One-click unsubscribe (RFC 8058). Mailbox providers POST here when the
 * recipient presses their "Unsubscribe" button; the token in the List-Unsubscribe
 * header is the only authority.
 */
export async function POST(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const config = emailConfig();
  if (!config) return new Response(null, { status: 404 });
  const { ok } = await unsubscribeByToken(db(), config.unsubscribeSecret, token);
  return new Response(null, { status: ok ? 200 : 400, headers: { 'cache-control': 'no-store' } });
}
