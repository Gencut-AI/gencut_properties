/**
 * WhatsApp Cloud API webhook (D-017).
 *
 * GET: Meta's subscription handshake (verify token).
 * POST: incoming messages. The body is checked against Meta's signature with
 * the app secret before anything is read; messages are stored once each and a
 * background job answers them, so Meta gets its 200 at once.
 *
 * Off (404) until every WhatsApp setting is configured on the deploy.
 */
import { parseWebhook, storeInbound, verifySubscription, verifyWebhookSignature, whatsappConfigFromEnv } from '@gencut/services';
import { startBackgroundJob } from '../../../../lib/background.ts';
import { db } from '../../../../lib/db.ts';

export const dynamic = 'force-dynamic';

const log = (detail: Record<string, string | number | boolean>) => console.log(`[whatsapp-webhook] ${JSON.stringify(detail)}`);

export async function GET(request: Request): Promise<Response> {
  const config = whatsappConfigFromEnv(process.env);
  if (!config) return new Response('Not found', { status: 404 });
  const challenge = verifySubscription(new URL(request.url).searchParams, config.verifyToken);
  log({ event: 'subscribe', ok: challenge !== null });
  return challenge === null ? new Response('Forbidden', { status: 403 }) : new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
}

export async function POST(request: Request): Promise<Response> {
  const config = whatsappConfigFromEnv(process.env);
  if (!config) return new Response('Not found', { status: 404 });
  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256'), config.appSecret)) {
    log({ event: 'rejected', reason: 'signature' });
    return new Response('Invalid signature', { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  // Only messages to this deploy's number are taken.
  const messages = parseWebhook(payload).filter((m) => m.phoneNumberId === config.phoneNumberId);
  const added = messages.length ? await storeInbound(db(), messages) : 0;
  const started = added > 0 ? await startBackgroundJob('whatsapp-background', {}) : false;
  log({ event: 'received', messages: messages.length, added, jobStarted: started });
  return new Response('OK', { status: 200 });
}
