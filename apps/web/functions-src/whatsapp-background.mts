/**
 * Answers waiting WhatsApp messages (Netlify background function: the caller
 * gets 202 at once; this may run for up to 15 minutes, long enough to write a
 * letter draft and send it back).
 *
 * The request carries nothing: the job works only on messages the signed
 * webhook stored, and claims each one before handling it, so repeated or
 * forged requests do no more than answer what is already waiting.
 *
 * Links in replies use the site address fixed at build time (bundle-functions.ts),
 * never anything from the request.
 */
import { WhatsAppCloudSender, createDb, modelRouterFromEnv, processInbound, whatsappConfigFromEnv } from '@gencut/services';

const log = (detail: Record<string, string | number | boolean>) => console.log(`[whatsapp] ${JSON.stringify(detail)}`);

export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST') return;
  const config = whatsappConfigFromEnv(process.env);
  const url = process.env.DATABASE_URL;
  const siteUrl = (process.env.GENCUT_SITE_URL ?? '').replace(/\/+$/, '');
  if (!config || !url || !siteUrl) {
    const detail = { outcome: 'not_started', whatsappConfigured: Boolean(config), databaseConfigured: Boolean(url), siteUrlConfigured: Boolean(siteUrl) };
    log(detail);
    throw new Error(`WhatsApp processing did not start: ${JSON.stringify(detail)}`);
  }
  const sql = createDb(url, { max: 1 });
  try {
    const result = await processInbound(sql, { sender: new WhatsAppCloudSender(config), router: modelRouterFromEnv(process.env), siteUrl });
    log({ outcome: 'done', ...result });
  } catch (e) {
    log({ outcome: 'error', error: e instanceof Error ? e.message.slice(0, 300) : 'unknown' });
    throw e;
  } finally {
    await sql.end({ timeout: 5 });
  }
};
