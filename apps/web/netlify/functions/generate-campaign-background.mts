/**
 * Writes one campaign draft in the background (Netlify background function:
 * the caller gets 202 at once; this may run for up to 15 minutes).
 *
 * The request carries only a campaign id. The service acts only on a campaign
 * a signed-in user already put in the 'generating' state, and claims it before
 * any model call, so repeated or forged requests do nothing.
 *
 * Every invocation logs one line saying what it did (never a secret value), so
 * a draft that does not start can be diagnosed from the function log.
 */
import { createDb, generateCampaignDraft, modelRouterFromEnv } from '@gencut/services';

const log = (detail: Record<string, string | boolean>) => console.log(`[generate-campaign] ${JSON.stringify(detail)}`);

export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST') return;
  const body = (await req.json().catch(() => null)) as { campaignId?: unknown } | null;
  const campaignId = typeof body?.campaignId === 'string' ? body.campaignId : '';
  const router = modelRouterFromEnv(process.env);
  const url = process.env.DATABASE_URL;
  if (!campaignId || !router || !url) {
    log({ outcome: 'not_started', campaignId: Boolean(campaignId), modelKeyConfigured: Boolean(router), databaseConfigured: Boolean(url) });
    return;
  }
  const sql = createDb(url, { max: 1 });
  try {
    const outcome = await generateCampaignDraft(sql, campaignId, router);
    log({ outcome, campaignId });
  } catch (e) {
    log({ outcome: 'error', campaignId, error: e instanceof Error ? e.message.slice(0, 300) : 'unknown' });
    throw e;
  } finally {
    await sql.end({ timeout: 5 });
  }
};
