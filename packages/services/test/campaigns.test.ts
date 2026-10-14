import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { CampaignDraft, StoredParcel } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  AnthropicProvider,
  ModelCallError,
  ModelRouter,
  RecordedProvider,
  type RequestContext,
  ServiceError,
  type Sql,
  claimCoverage,
  completeCoverage,
  createDb,
  ensureWorkspace,
  generateCampaignDraft,
  getCampaign,
  listCampaigns,
  listOpportunities,
  listOutcomes,
  modelRouterFromEnv,
  outcomeReport,
  recordOutcome,
  retryCampaignDraft,
  saveBusinessProfile,
  scoreWorkspace,
  setOpportunityStatus,
  startCampaignDraft,
  storeParcels,
  updateCampaignLetter,
} from '../src/index.ts';

// Synthetic parcels, agent and model replies. Not real people, properties or model output.
const ASOF = new Date('2026-10-13T12:00:00Z');
const roll = { sourceFile: 'Dade 23 Preliminary NAL 2026.zip', rollLabel: '2026 preliminary roll', fileDate: '2026-07-27' };
const profile = (zip: string) => ({
  licenseeName: 'Ana Test',
  brokerageName: 'Example Bay Realty LLC',
  licenseNumber: 'SL3456789',
  market: 'miami-dade',
  focusZips: [zip],
  propertyUses: ['single_family'],
});

function parcel(n: number, zip: string): StoredParcel {
  return {
    parcelId: `CAMP${String(n).padStart(6, '0')}`,
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

function draftFor(n: number, overrides: Partial<CampaignDraft['letter']> = {}): CampaignDraft {
  return {
    title: `Introduction to the owner of ${n} Example Way`,
    strategy: {
      summary: 'A short, personal introduction about the single-family home.',
      angle: 'Local single-family specialist offering a no-obligation conversation.',
      reasons: [{ text: 'Built in 1957 with 2,088 sq ft of living area.', factKeys: ['property.year_built', 'property.living_area'] }],
    },
    letter: {
      greeting: `Dear Owner of ${n} Example Way,`,
      paragraphs: ['I work with owners of single-family homes in Aventura, and your 1957 home stood out to me.', 'If you would like to talk about the property, I am glad to help, with no obligation.'],
      closing: 'Warm regards,',
      signature: ['Ana Test', 'Example Bay Realty LLC', 'License SL3456789'],
      ...overrides,
    },
    followUp: [{ day: 21, channel: 'mail', action: 'Send a short second letter if there is no reply.' }],
    factsUsed: ['property.address', 'property.year_built', 'agent.brokerage'],
  };
}
const reply = (d: unknown, usage = { inputTokens: 1800, outputTokens: 600, cacheReadTokens: 0 }) => ({ text: JSON.stringify(d), usage });
const routerWith = (replies: ConstructorParameters<typeof RecordedProvider>[0]) => {
  const provider = new RecordedProvider(replies);
  let t = 0;
  return { provider, router: new ModelRouter({ providers: { anthropic: provider }, now: () => (t += 1500) }) };
};

function user(): RequestContext {
  const id = randomUUID();
  return { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
}

describe('model router', () => {
  it('routes roles to configured models and prices each call', async () => {
    const { router, provider } = routerWith([reply({ ok: true })]);
    assert.deepEqual(router.route('creative'), { provider: 'anthropic', model: 'claude-sonnet-5-5' });
    assert.deepEqual(router.route('fast'), { provider: 'anthropic', model: 'claude-haiku-5-5' });
    const r = await router.complete({ role: 'creative', system: 's', user: 'u', maxOutputTokens: 10 });
    assert.equal(r.costUsd, 0.0096); // 1,800 in at $2/M + 600 out at $10/M
    assert.equal(r.latencyMs, 1500);
    assert.equal(provider.calls[0]?.model, 'claude-sonnet-5-5');
    assert.throws(() => new ModelRouter({ providers: {}, routes: { fast: 'anthropic:unpriced-model' } }), /No published price/);
  });

  it('is off without a key, and routes can be changed by configuration', () => {
    assert.equal(modelRouterFromEnv({}), null);
    const r = modelRouterFromEnv({ ANTHROPIC_API_KEY: 'test-key', GENCUT_MODEL_CREATIVE: 'anthropic:claude-opus-5-5' });
    assert.deepEqual(r?.route('creative'), { provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('calls the Anthropic API with the key in a header, caches the instructions, and never echoes the key in errors', async () => {
    let seen: { headers: Record<string, string>; body: { system: { cache_control?: unknown }[]; model: string } } | null = null;
    const ok = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = { headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return Response.json({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900 } });
    }) as typeof fetch;
    const res = await new AnthropicProvider('test-secret-key', ok).complete('claude-sonnet-5-5', { role: 'creative', system: 's', user: 'u', maxOutputTokens: 5 });
    assert.equal(res.text, 'hi');
    assert.deepEqual(res.usage, { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 });
    assert.equal(seen!.headers['x-api-key'], 'test-secret-key');
    assert.ok(seen!.body.system[0]?.cache_control);
    const denied = (async () => Response.json({ error: { type: 'authentication_error' } }, { status: 401 })) as typeof fetch;
    await assert.rejects(
      new AnthropicProvider('test-secret-key', denied).complete('m', { role: 'fast', system: 's', user: 'u', maxOutputTokens: 5 }),
      (e: Error) => e instanceof ModelCallError && /401 \(authentication_error\)/.test(e.message) && !e.message.includes('test-secret-key'),
    );
  });
});

describe('campaign drafts and outcomes', () => {
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

  /** A workspace with one scored opportunity in its own ZIP. */
  async function setup(zip: string) {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, profile(zip));
    await claimCoverage(sql, '23', [zip]);
    await storeParcels(sql, roll.fileDate, [parcel(Number(zip), zip)]);
    await completeCoverage(sql, '23', [{ zip, parcelCount: 1 }], roll);
    await scoreWorkspace(sql, workspaceId, ASOF);
    const [opp] = await listOpportunities(sql, u, workspaceId);
    assert.ok(opp, 'setup produced an opportunity');
    return { u, workspaceId, opp };
  }

  it('turns an opportunity into a checked draft: one model call, logged with cost, letter saved as a DRAFT', async () => {
    const { u, workspaceId, opp } = await setup('33301');
    const { campaignId, created } = await startCampaignDraft(sql, u, workspaceId, opp.id);
    assert.equal(created, true);
    assert.equal((await startCampaignDraft(sql, u, workspaceId, opp.id)).campaignId, campaignId, 'one draft at a time');
    assert.equal((await listOpportunities(sql, u, workspaceId))[0]?.status, 'in_campaign');

    const { router, provider } = routerWith([reply(draftFor(33301))]);
    assert.equal(await generateCampaignDraft(sql, campaignId, router), 'review');
    assert.equal(await generateCampaignDraft(sql, campaignId, router), 'skipped', 'already done');
    assert.match(provider.calls[0]?.request.user ?? '', /33301 EXAMPLE WAY/);
    assert.ok(!(provider.calls[0]?.request.user ?? '').includes('NEW YORK'), 'how the owner was found is not given to the model');

    const c = await getCampaign(sql, u, workspaceId, campaignId);
    assert.equal(c.status, 'review');
    assert.equal(c.letterState, 'DRAFT');
    assert.equal(c.draft?.letter.signature[1], 'Example Bay Realty LLC');
    assert.deepEqual(
      { calls: c.usage.calls, cost: c.usage.costUsd, models: c.usage.models },
      { calls: 1, cost: 0.0096, models: ['anthropic/claude-sonnet-5-5'] },
    );
    assert.ok(c.facts.some((f) => f.key === 'property.year_built' && f.source === 'public_record'));
    const [run] = await sql<{ fact_keys: string[]; prompt_version: string }[]>`SELECT fact_keys, prompt_version FROM model_runs WHERE campaign_id = ${campaignId}`;
    assert.ok(run?.fact_keys.includes('agent.brokerage'));
    assert.equal(run?.prompt_version, 'campaign-draft-v1');
    assert.equal((await listCampaigns(sql, u, workspaceId, { opportunityId: opp.id }))[0]?.id, campaignId);
  });

  it('retries once with the problems listed, then fails with reasons if the draft still breaks the rules', async () => {
    const { u, workspaceId, opp } = await setup('33302');
    const invented = draftFor(33302, { paragraphs: ['Homes nearby sold for $2.1 million.'] });
    const first = await startCampaignDraft(sql, u, workspaceId, opp.id);
    const fixed = routerWith([reply(invented), reply(draftFor(33302))]);
    assert.equal(await generateCampaignDraft(sql, first.campaignId, fixed.router), 'review');
    assert.match(fixed.provider.calls[1]?.request.user ?? '', /"\$2\.1 million" is not in the provided facts/);
    assert.equal((await getCampaign(sql, u, workspaceId, first.campaignId)).usage.calls, 2);

    const { u: u2, workspaceId: ws2, opp: opp2 } = await setup('33303');
    const bad = await startCampaignDraft(sql, u2, ws2, opp2.id);
    const hardship = draftFor(33303, { paragraphs: ['I am sorry for your loss; if the estate is in probate I can help.'] });
    const failing = routerWith([reply(hardship), reply('not json at all')]);
    assert.equal(await generateCampaignDraft(sql, bad.campaignId, failing.router), 'generation_failed');
    const c = await getCampaign(sql, u2, ws2, bad.campaignId);
    assert.equal(c.status, 'generation_failed');
    assert.equal(c.letterState, null, 'no letter is saved from a failed draft');
    assert.ok(c.problems.length > 0);

    // Retry after failure works, and the retried draft can pass.
    await retryCampaignDraft(sql, u2, ws2, bad.campaignId);
    assert.equal(await generateCampaignDraft(sql, bad.campaignId, routerWith([reply(draftFor(33303))]).router), 'review');
  });

  it('records a provider failure as a failed model run and a failed draft, without spending more', async () => {
    const { u, workspaceId, opp } = await setup('33304');
    const { campaignId } = await startCampaignDraft(sql, u, workspaceId, opp.id);
    const down = routerWith([new ModelCallError('anthropic', 'Anthropic API returned 529 (overloaded_error).', 529)]);
    assert.equal(await generateCampaignDraft(sql, campaignId, down.router), 'generation_failed');
    assert.equal(down.provider.calls.length, 1);
    const c = await getCampaign(sql, u, workspaceId, campaignId);
    assert.match(c.error ?? '', /529/);
    assert.equal(c.usage.failedCalls, 1);
  });

  it("checks the agent's edits with the same rules and keeps the letter a DRAFT", async () => {
    const { u, workspaceId, opp } = await setup('33305');
    const { campaignId } = await startCampaignDraft(sql, u, workspaceId, opp.id);
    await generateCampaignDraft(sql, campaignId, routerWith([reply(draftFor(33305))]).router);
    const letter = draftFor(33305).letter;
    await assert.rejects(
      updateCampaignLetter(sql, u, workspaceId, campaignId, { ...letter, paragraphs: ['Perfect for families, act now!'] }),
      (e) => e instanceof ServiceError && e.code === 'invalid' && /families/.test(e.fields.letter ?? ''),
    );
    const saved = await updateCampaignLetter(sql, u, workspaceId, campaignId, { ...letter, paragraphs: ['A shorter note about your 1957 home.'] });
    assert.deepEqual(saved.letter.paragraphs, ['A shorter note about your 1957 home.']);
    const [action] = await sql<{ state: string; content: { letter: { paragraphs: string[] } } }[]>`SELECT state, content FROM outreach_actions WHERE campaign_id = ${campaignId}`;
    assert.equal(action?.state, 'DRAFT');
    assert.deepEqual(action?.content.letter.paragraphs, ['A shorter note about your 1957 home.']);
  });

  it('needs the generate permission, refuses dismissed opportunities, and keeps tenants apart', async () => {
    const { u, workspaceId, opp } = await setup('33306');
    await setOpportunityStatus(sql, u, workspaceId, opp.id, 'dismissed');
    await assert.rejects(startCampaignDraft(sql, u, workspaceId, opp.id), (e) => e instanceof ServiceError && e.code === 'invalid');
    await setOpportunityStatus(sql, u, workspaceId, opp.id, 'new');
    await sql`UPDATE workspace_permissions SET revoked_at = now() WHERE workspace_id = ${workspaceId} AND kind = 'generate'`;
    await assert.rejects(startCampaignDraft(sql, u, workspaceId, opp.id), (e) => e instanceof ServiceError && e.code === 'forbidden');

    const other = await setup('33307');
    const { campaignId } = await startCampaignDraft(sql, other.u, other.workspaceId, other.opp.id);
    const stranger = user();
    await ensureWorkspace(sql, stranger);
    for (const attempt of [
      () => getCampaign(sql, stranger, other.workspaceId, campaignId),
      () => startCampaignDraft(sql, stranger, other.workspaceId, other.opp.id),
      () => recordOutcome(sql, stranger, other.workspaceId, other.opp.id, { outcome: 'contacted', occurredOn: '2026-10-01' }),
    ]) {
      await assert.rejects(attempt(), (e) => e instanceof ServiceError && e.code === 'forbidden');
    }
  });

  it('records outcomes with the score that ranked the opportunity, and reports only from 20 opportunities', async () => {
    const { u, workspaceId, opp } = await setup('33308');
    const rec = await recordOutcome(sql, u, workspaceId, opp.id, { outcome: 'responded', occurredOn: '2026-10-10', note: 'Called back' });
    assert.equal(rec.score, opp.score);
    assert.equal(rec.scoringVersion, opp.scoringVersion);
    await assert.rejects(
      recordOutcome(sql, u, workspaceId, opp.id, { outcome: 'listing', occurredOn: '2999-01-01' }),
      (e) => e instanceof ServiceError && e.fields.occurredOn !== undefined,
    );
    await assert.rejects(recordOutcome(sql, u, workspaceId, opp.id, { outcome: 'sold' as never, occurredOn: '2026-10-01' }), ServiceError);
    assert.deepEqual((await listOutcomes(sql, u, workspaceId, opp.id)).map((o) => o.outcome), ['responded']);

    let report = await outcomeReport(sql, u, workspaceId);
    assert.equal(report.opportunities, 1);
    assert.equal(report.ready, false);
    // Twenty opportunities with outcomes make the report meaningful enough to show.
    const ids = await sql<{ id: string }[]>`
      WITH src AS (
        INSERT INTO source_records (source_id, external_id, file_date, zip, payload)
        SELECT (SELECT id FROM data_sources WHERE key = 'fl-dor-nal'), '23:SYN' || g, '2026-07-27', '33308', '{}'
        FROM generate_series(1, 19) g RETURNING id
      )
      INSERT INTO opportunities (workspace_id, source_record_id, subject_key, type, score, confidence, reasons, scoring_version)
      SELECT ${workspaceId}, src.id, 'synthetic:' || src.id, 'potential_seller', 60, 1, '[]', 'seller-v3' FROM src
      RETURNING id
    `;
    for (const { id } of ids) await recordOutcome(sql, u, workspaceId, id, { outcome: 'no_response', occurredOn: '2026-10-05' });
    report = await outcomeReport(sql, u, workspaceId);
    assert.equal(report.ready, true);
    assert.equal(report.bands.find((b) => b.band === '55–64')?.opportunities, 19);
    assert.equal(report.bands.reduce((a, b) => a + b.replied, 0), 1);
  });
});
