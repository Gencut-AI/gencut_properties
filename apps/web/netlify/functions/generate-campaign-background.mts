/**
 * Writes one campaign draft in the background (Netlify background function:
 * the caller gets 202 at once; this may run for up to 15 minutes).
 *
 * The request carries only a campaign id. The service acts only on a campaign
 * a signed-in user already put in the 'generating' state, and claims it before
 * any model call, so repeated or forged requests do nothing.
 */
import { createDb, generateCampaignDraft, modelRouterFromEnv } from '@gencut/services';

export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST') return;
  const body = (await req.json().catch(() => null)) as { campaignId?: unknown } | null;
  const campaignId = typeof body?.campaignId === 'string' ? body.campaignId : '';
  const router = modelRouterFromEnv(process.env);
  const url = process.env.DATABASE_URL;
  if (!campaignId || !router || !url) return;
  const sql = createDb(url, { max: 1 });
  try {
    await generateCampaignDraft(sql, campaignId, router);
  } finally {
    await sql.end({ timeout: 5 });
  }
};
