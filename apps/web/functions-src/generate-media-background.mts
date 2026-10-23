/**
 * The Film Crew's run for one campaign, in the background (Netlify background
 * function: the caller gets 202 at once; this may run for up to 15 minutes).
 *
 * The request carries only a campaign id. The service acts only on a campaign a
 * signed-in user already put in media state 'generating', and claims it before
 * any model call, so repeated or forged requests do nothing.
 */
import { createDb, generateCampaignMedia, imageGeneratorFromEnv, modelRouterFromEnv } from '@gencut/services';

const log = (detail: Record<string, string | boolean>) => console.log(`[generate-media] ${JSON.stringify(detail)}`);

export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST') return;
  const body = (await req.json().catch(() => null)) as { campaignId?: unknown } | null;
  const campaignId = typeof body?.campaignId === 'string' ? body.campaignId : '';
  const router = modelRouterFromEnv(process.env);
  const images = imageGeneratorFromEnv(process.env);
  const url = process.env.DATABASE_URL;
  if (!campaignId || !router || !images || !url) {
    // A misconfigured deploy is an error, so it shows in the function's error log.
    const detail = {
      outcome: 'not_started',
      campaignId: Boolean(campaignId),
      modelKeyConfigured: Boolean(router),
      imageKeyConfigured: Boolean(images),
      databaseConfigured: Boolean(url),
    };
    log(detail);
    throw new Error(`Campaign media did not start: ${JSON.stringify(detail)}`);
  }
  const sql = createDb(url, { max: 1 });
  try {
    const outcome = await generateCampaignMedia(sql, campaignId, router, images);
    log({ outcome, campaignId });
  } catch (e) {
    log({ outcome: 'error', campaignId, error: e instanceof Error ? e.message.slice(0, 300) : 'unknown' });
    throw e;
  } finally {
    await sql.end({ timeout: 5 });
  }
};
