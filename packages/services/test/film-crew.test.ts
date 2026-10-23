import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { CampaignDraft, SocialPost, StoredParcel } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  GoogleImageProvider,
  ImageGenerator,
  ModelCallError,
  ModelRouter,
  RecordedImageProvider,
  RecordedProvider,
  type RequestContext,
  ServiceError,
  type Sql,
  claimCoverage,
  completeCoverage,
  createDb,
  currentHeadshotId,
  ensureWorkspace,
  generateCampaignDraft,
  generateCampaignMedia,
  getCampaign,
  getCampaignMedia,
  getMediaAsset,
  imageGeneratorFromEnv,
  listOpportunities,
  saveBusinessProfile,
  scoreWorkspace,
  startCampaignDraft,
  startCampaignMedia,
  storeParcels,
  uploadHeadshot,
} from '../src/index.ts';

// Synthetic parcels, agent, model replies and images. Not real people, properties or model output.
const ASOF = new Date('2026-10-13T12:00:00Z');
const roll = { sourceFile: 'Dade 23 Preliminary NAL 2026.zip', rollLabel: '2026 preliminary roll', fileDate: '2026-07-27' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

function parcel(n: number, zip: string): StoredParcel {
  return {
    parcelId: `FILM${String(n).padStart(6, '0')}`,
    countyCode: '23',
    assessmentYear: 2026,
    useCode: '001',
    situs: { address: `${n} EXAMPLE WAY`, city: 'AVENTURA', zip },
    owner: { name: `TEST HOLDINGS ${n} LLC`, address1: '9 SAMPLE ST', address2: '', city: 'NEW YORK', state: 'NY', zip: '10001' },
    ownerKind: 'company',
    justValue: 1_000_000,
    assessedValue: 500_000,
    homestead: false,
    sales: [],
    prior: null,
    units: 1,
    yearBuilt: 1957,
    livingArea: 2088,
  };
}

const draft = (n: number): CampaignDraft => ({
  title: `Introduction to the owner of ${n} Example Way`,
  strategy: { summary: 'A short introduction.', angle: 'Local specialist.', reasons: [{ text: 'Built in 1957.', factKeys: ['property.year_built'] }] },
  letter: {
    greeting: `Dear Owner of ${n} Example Way,`,
    paragraphs: ['I work with owners of single-family homes, and your 1957 home stood out to me.'],
    closing: 'Warm regards,',
    signature: ['Ana Test', 'Example Bay Realty LLC'],
  },
  followUp: [{ day: 21, channel: 'mail', action: 'Send a short second letter.' }],
  factsUsed: ['property.year_built'],
});

const post = (zip: string, caption?: string): SocialPost => ({
  headline: 'Thinking about selling in Aventura?',
  caption: caption ?? `I am Ana Test with Example Bay Realty LLC, and I work with single-family homeowners in ${zip}. Happy to talk it through.`,
  callToAction: 'Send me a message for a no-obligation conversation.',
  hashtags: ['#Aventura', '#HomeSellers', '#MiamiDade'],
  imageBrief: 'A quiet tree-lined street with palm trees at golden hour.',
  factsUsed: ['area.city', 'area.zip', 'agent.name', 'agent.brokerage'],
});

const reply = (d: unknown) => ({ text: typeof d === 'string' ? d : JSON.stringify(d), usage: { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0 } });
const router = (replies: ConstructorParameters<typeof RecordedProvider>[0]) => {
  const provider = new RecordedProvider(replies);
  return { provider, router: new ModelRouter({ providers: { anthropic: provider } }) };
};
const imagesWith = (results: ConstructorParameters<typeof RecordedImageProvider>[0]) => {
  const provider = new RecordedImageProvider(results);
  return { provider, images: new ImageGenerator({ provider, model: 'gemini-nano-banana-2.1' }) };
};

function user(): RequestContext {
  const id = randomUUID();
  return { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
}

describe('Google image provider', () => {
  it('requests one 1K image, returns its bytes, and never echoes the key in errors', async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const ok = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return Response.json({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'here' }, { type: 'image', data: Buffer.from(JPEG).toString('base64') }] }],
      });
    }) as typeof fetch;
    const res = await new GoogleImageProvider('test-google-key', ok).generate('gemini-nano-banana-2.1', { prompt: 'p', aspectRatio: '4:5' });
    assert.equal(res.contentType, 'image/jpeg');
    assert.deepEqual([...res.bytes], [...JPEG]);
    assert.match(seen!.url, /v1beta\/interactions$/);
    assert.equal(seen!.headers['x-goog-api-key'], 'test-google-key');
    assert.deepEqual(seen!.body.response_format, { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '4:5', image_size: '1K' });

    const denied = (async () => Response.json({ error: { status: 'INVALID_ARGUMENT', message: 'API key test-google-key not valid.' } }, { status: 400 })) as typeof fetch;
    await assert.rejects(
      new GoogleImageProvider('test-google-key', denied).generate('m', { prompt: 'p', aspectRatio: '1:1' }),
      (e: Error) => e instanceof ModelCallError && /400 \(INVALID_ARGUMENT\): API key \[key\] not valid/.test(e.message) && !e.message.includes('test-google-key'),
    );
    const noImage = (async () => Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot make that.' }] }] })) as typeof fetch;
    await assert.rejects(new GoogleImageProvider('k', noImage).generate('m', { prompt: 'p', aspectRatio: '1:1' }), /no image \(status completed\): I cannot make that/);
  });

  it('is off without a key and refuses an unpriced model', () => {
    assert.equal(imageGeneratorFromEnv({}), null);
    assert.equal(imageGeneratorFromEnv({ GEMINI_API_KEY: 'k' })?.priceUsd, 0.0336);
    assert.throws(() => imageGeneratorFromEnv({ GEMINI_API_KEY: 'k', GENCUT_IMAGE_MODEL: 'google:unpriced' }), /No published price/);
  });
});

describe('Film Crew', () => {
  let tdb: TestDb;
  let sql: Sql;
  before(() => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 4 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  /** A workspace with one campaign whose letter is drafted. */
  async function campaignInReview(zip: string) {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, {
      licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', market: 'miami-dade', focusZips: [zip], propertyUses: ['single_family'],
    });
    await claimCoverage(sql, '23', [zip]);
    await storeParcels(sql, roll.fileDate, [parcel(Number(zip), zip)]);
    await completeCoverage(sql, '23', [{ zip, parcelCount: 1 }], roll);
    await scoreWorkspace(sql, workspaceId, ASOF);
    const [opp] = await listOpportunities(sql, u, workspaceId);
    assert.ok(opp);
    const { campaignId } = await startCampaignDraft(sql, u, workspaceId, opp.id);
    assert.equal(await generateCampaignDraft(sql, campaignId, router([reply(draft(Number(zip)))]).router), 'review');
    return { u, workspaceId, campaignId };
  }

  it('stores one current headshot per workspace, checked by its bytes, visible only to members', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await assert.rejects(uploadHeadshot(sql, u, workspaceId, new TextEncoder().encode('<svg/>')), (e) => e instanceof ServiceError && /JPEG, PNG or WebP/.test(e.fields.headshot ?? ''));
    await assert.rejects(uploadHeadshot(sql, u, workspaceId, new Uint8Array(3 * 1024 * 1024 + 1).fill(0xff)), (e) => e instanceof ServiceError && /under 3 MB/.test(e.fields.headshot ?? ''));
    const first = await uploadHeadshot(sql, u, workspaceId, PNG);
    const second = await uploadHeadshot(sql, u, workspaceId, JPEG);
    assert.notEqual(first, second);
    assert.equal(await currentHeadshotId(sql, u, workspaceId), second);
    const file = await getMediaAsset(sql, u, workspaceId, second);
    assert.equal(file.contentType, 'image/jpeg');
    assert.deepEqual([...file.bytes], [...JPEG]);

    const stranger = user();
    const { workspaceId: other } = await ensureWorkspace(sql, stranger);
    await assert.rejects(getMediaAsset(sql, stranger, workspaceId, second), (e) => e instanceof ServiceError && e.code === 'forbidden');
    await assert.rejects(getMediaAsset(sql, stranger, other, second), (e) => e instanceof ServiceError && e.code === 'not_found');
  });

  it('writes a checked post and an illustrative picture, logs both calls with cost, and posts nothing', async () => {
    const { u, workspaceId, campaignId } = await campaignInReview('33401');
    assert.deepEqual(await startCampaignMedia(sql, u, workspaceId, campaignId), { started: true });
    assert.deepEqual(await startCampaignMedia(sql, u, workspaceId, campaignId), { started: false }, 'one run at a time');

    const text = router([reply(post('33401'))]);
    const img = imagesWith([{ bytes: JPEG, contentType: 'image/jpeg' }]);
    assert.equal(await generateCampaignMedia(sql, campaignId, text.router, img.images), 'ready');
    assert.equal(await generateCampaignMedia(sql, campaignId, text.router, img.images), 'skipped', 'already done');

    const prompt = text.provider.calls[0]?.request.user ?? '';
    assert.match(prompt, /area\.zip \(ZIP code\): 33401/);
    assert.ok(!prompt.includes('EXAMPLE WAY') && !prompt.includes('TEST HOLDINGS'), 'the address and owner are never given to the copywriter');
    const imagePrompt = img.provider.calls[0]?.request.prompt ?? '';
    assert.match(imagePrompt, /no people/);
    assert.match(imagePrompt, /palm trees/);

    const m = await getCampaignMedia(sql, u, workspaceId, campaignId);
    assert.equal(m.status, 'ready');
    assert.equal(m.socialPost?.headline, 'Thinking about selling in Aventura?');
    assert.ok(m.neighborhoodImageId);
    assert.equal((await getMediaAsset(sql, u, workspaceId, m.neighborhoodImageId!)).illustrative, true);
    assert.equal(m.calls, 2);
    // Post: 1,200 in × $2/M + 400 out × $10/M = $0.0064; image $0.0336.
    assert.equal(m.costUsd, 0.04);
    assert.equal(m.budgetUsd, 1);
    // The letter's usage is reported separately from the media.
    assert.equal((await getCampaign(sql, u, workspaceId, campaignId)).usage.calls, 1);
    const [runs] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM model_runs WHERE campaign_id = ${campaignId} AND role = 'image' AND purpose = 'neighborhood_image'`;
    assert.equal(runs?.n, 1);
    const [actions] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outreach_actions WHERE campaign_id = ${campaignId}`;
    assert.equal(actions?.n, 1, 'only the letter draft; nothing to post or send');
  });

  it('retries a post that names the property once, then fails with reasons and makes no picture', async () => {
    const { u, workspaceId, campaignId } = await campaignInReview('33402');
    await startCampaignMedia(sql, u, workspaceId, campaignId);
    const naming = post('33402', 'I am Ana Test with Example Bay Realty LLC. What a home at 33402 Example Way!');
    const text = router([reply(naming), reply(naming)]);
    const img = imagesWith([{ bytes: JPEG, contentType: 'image/jpeg' }]);
    assert.equal(await generateCampaignMedia(sql, campaignId, text.router, img.images), 'failed');
    assert.match(text.provider.calls[1]?.request.user ?? '', /must not mention the property/);
    assert.equal(img.provider.calls.length, 0, 'no picture is paid for when the post fails');
    const m = await getCampaignMedia(sql, u, workspaceId, campaignId);
    assert.equal(m.status, 'failed');
    assert.ok(m.problems.some((p) => p.code === 'reveals_subject'));

    // Trying again works.
    await startCampaignMedia(sql, u, workspaceId, campaignId);
    assert.equal(await generateCampaignMedia(sql, campaignId, router([reply(post('33402'))]).router, img.images), 'ready');
  });

  it('records an image provider failure and keeps the checked post', async () => {
    const { u, workspaceId, campaignId } = await campaignInReview('33403');
    await startCampaignMedia(sql, u, workspaceId, campaignId);
    const img = imagesWith([new ModelCallError('google', 'Google API returned 429 (RESOURCE_EXHAUSTED).', 429)]);
    assert.equal(await generateCampaignMedia(sql, campaignId, router([reply(post('33403'))]).router, img.images), 'failed');
    const m = await getCampaignMedia(sql, u, workspaceId, campaignId);
    assert.match(m.error ?? '', /429/);
    assert.equal(m.failedCalls, 1);
    assert.equal(m.neighborhoodImageId, null);
  });

  it('stops before going over the media budget', async () => {
    const { u, workspaceId, campaignId } = await campaignInReview('33404');
    await sql`
      INSERT INTO model_runs (workspace_id, campaign_id, purpose, role, provider, model, prompt_version, status, cost_usd)
      SELECT workspace_id, id, 'neighborhood_image', 'image', 'google', 'm', 'v', 'ok', 0.97 FROM campaigns WHERE id = ${campaignId}
    `;
    await assert.rejects(startCampaignMedia(sql, u, workspaceId, campaignId), (e) => e instanceof ServiceError && /media budget/.test(e.message));
  });

  it('needs a drafted letter and the generate permission', async () => {
    const { u, workspaceId, campaignId } = await campaignInReview('33405');
    await sql`UPDATE campaigns SET status = 'generation_failed' WHERE id = ${campaignId}`;
    await assert.rejects(startCampaignMedia(sql, u, workspaceId, campaignId), (e) => e instanceof ServiceError && e.code === 'invalid');
    await sql`UPDATE campaigns SET status = 'review' WHERE id = ${campaignId}`;
    await sql`UPDATE workspace_permissions SET revoked_at = now() WHERE workspace_id = ${workspaceId} AND kind = 'generate'`;
    await assert.rejects(startCampaignMedia(sql, u, workspaceId, campaignId), (e) => e instanceof ServiceError && e.code === 'forbidden');
  });
});
