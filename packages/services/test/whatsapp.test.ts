import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { CampaignDraft, StoredParcel } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  ModelRouter,
  RecordedProvider,
  RecordedSender,
  type RequestContext,
  type Sql,
  WhatsAppCloudSender,
  claimCoverage,
  completeCoverage,
  createDb,
  createLinkCode,
  ensureWorkspace,
  getWhatsAppLink,
  listCampaigns,
  listOpportunities,
  parseWebhook,
  processInbound,
  saveBusinessProfile,
  scoreWorkspace,
  storeInbound,
  storeParcels,
  unlinkWhatsApp,
  verifySubscription,
  verifyWebhookSignature,
  whatsappConfigFromEnv,
  whatsappMessageBody,
} from '../src/index.ts';

// Synthetic numbers, people, parcels and model replies. Not real.
const SITE = 'https://app.example.com';
const ASOF = new Date('2026-10-13T12:00:00Z');
const roll = { sourceFile: 'Dade 23 Preliminary NAL 2026.zip', rollLabel: '2026 preliminary roll', fileDate: '2026-07-27' };

/** House numbers are the ZIP plus a digit, so every test agent's homes are distinct: 334021 EXAMPLE WAY. */
function parcel(zip: string, k: number): StoredParcel {
  const n = Number(`${zip}${k}`);
  return {
    parcelId: `WA${n}`, countyCode: '23', assessmentYear: 2026, useCode: '001',
    situs: { address: `${n} EXAMPLE WAY`, city: 'AVENTURA', zip },
    owner: { name: `TEST HOLDINGS ${n} LLC`, address1: '9 SAMPLE ST', address2: '', city: 'NEW YORK', state: 'NY', zip: '10001' },
    ownerKind: 'company', justValue: 1_000_000, assessedValue: 500_000, homestead: false, sales: [], prior: null, units: 1, yearBuilt: 1957, livingArea: 2088,
  };
}

const letter = (n: number): CampaignDraft => ({
  title: `Introduction to the owner of ${n} Example Way`,
  strategy: { summary: 'A short introduction.', angle: 'Local single-family specialist.', reasons: [{ text: 'Built in 1957.', factKeys: ['property.year_built'] }] },
  letter: {
    greeting: `Dear Owner of ${n} Example Way,`,
    paragraphs: ['I work with owners of single-family homes in Aventura.', 'If you would like to talk about the property, I am glad to help, with no obligation.'],
    closing: 'Warm regards,',
    signature: ['Ana Test', 'Example Bay Realty LLC'],
  },
  followUp: [{ day: 21, channel: 'mail', action: 'Send a short second letter.' }],
  factsUsed: ['property.address', 'agent.brokerage'],
});
const modelReply = (d: unknown) => ({ text: JSON.stringify(d), usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0 } });

let wamid = 0;
const inbound = (waId: string, text: string, kind: 'text' | 'button' = 'text') => ({ wamid: `wamid.test.${++wamid}`, waId, kind, text, phoneNumberId: '100' });

describe('WhatsApp webhook', () => {
  it('accepts only POSTs signed with the app secret, and the subscription token', () => {
    const body = '{"object":"whatsapp_business_account"}';
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    assert.equal(verifyWebhookSignature(body, sig, 'app-secret'), true);
    assert.equal(verifyWebhookSignature(`${body} `, sig, 'app-secret'), false, 'a changed body');
    assert.equal(verifyWebhookSignature(body, sig, 'other-secret'), false);
    assert.equal(verifyWebhookSignature(body, null, 'app-secret'), false);
    assert.equal(verifyWebhookSignature(body, 'sha256=abc', 'app-secret'), false);
    const q = (token: string) => new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' });
    assert.equal(verifySubscription(q('verify-me'), 'verify-me'), '12345');
    assert.equal(verifySubscription(q('wrong'), 'verify-me'), null);
  });

  it('reads text messages and button taps, and ignores status updates', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: '100', display_phone_number: '15550000000' },
        contacts: [{ wa_id: '13055550100', profile: { name: 'Anyone' } }],
        messages: [
          { from: '13055550100', id: 'wamid.A', timestamp: '1', type: 'text', text: { body: 'buyers' } },
          { from: '13055550100', id: 'wamid.B', timestamp: '2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'draft 2', title: 'Draft a letter' } } },
          { from: '13055550100', id: 'wamid.C', timestamp: '3', type: 'image', image: { id: 'x' } },
        ],
        statuses: [{ id: 'wamid.out', status: 'delivered' }],
      } }] }],
    };
    assert.deepEqual(parseWebhook(payload).map((m) => [m.wamid, m.kind, m.text]), [['wamid.A', 'text', 'buyers'], ['wamid.B', 'button', 'draft 2'], ['wamid.C', 'other', '']]);
    assert.deepEqual(parseWebhook({ object: 'page', entry: [] }), []);
  });

  it('is off until every secret is configured, and sends buttons only when they fit', async () => {
    assert.equal(whatsappConfigFromEnv({ WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_APP_SECRET: 's' }), null);
    const cfg = whatsappConfigFromEnv({ WHATSAPP_ACCESS_TOKEN: 'token-xyz', WHATSAPP_PHONE_NUMBER_ID: '100', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v' });
    assert.ok(cfg);
    const withButtons = whatsappMessageBody('13055550100', { text: 'Hi', buttons: [{ title: 'Buyers', command: 'buyers' }] });
    assert.equal(withButtons.type, 'interactive');
    assert.equal(whatsappMessageBody('13055550100', { text: 'x'.repeat(1500), buttons: [{ title: 'Buyers', command: 'buyers' }] }).type, 'text');
    let seen: { url: string; auth: string } | null = null;
    const ok = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: (init?.headers as Record<string, string>).authorization ?? '' };
      return Response.json({ messages: [{ id: 'wamid.sent' }] });
    }) as typeof fetch;
    assert.equal(await new WhatsAppCloudSender(cfg, ok).send('13055550100', { text: 'Hi' }), 'wamid.sent');
    assert.match(seen!.url, /^https:\/\/graph\.facebook\.com\/v\d+\.0\/100\/messages$/);
    assert.equal(seen!.auth, 'Bearer token-xyz');
    const denied = (async () => Response.json({ error: { message: 'Invalid OAuth access token token-xyz', code: 190 } }, { status: 401 })) as typeof fetch;
    await assert.rejects(new WhatsAppCloudSender(cfg, denied).send('1', { text: 'x' }), (e: Error) => /401, code 190/.test(e.message) && !e.message.includes('token-xyz'));
  });
});

describe('WhatsApp assistant', () => {
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

  async function agent(zip: string) {
    const id = randomUUID();
    const u: RequestContext = { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, { licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', market: 'miami-dade', focusZips: [zip], propertyUses: ['single_family'] });
    await claimCoverage(sql, '23', [zip]);
    await storeParcels(sql, roll.fileDate, [parcel(zip, 1), parcel(zip, 2)]);
    await completeCoverage(sql, '23', [{ zip, parcelCount: 2 }], roll);
    await scoreWorkspace(sql, workspaceId, ASOF);
    return { u, workspaceId };
  }

  async function say(waId: string, text: string, deps: { sender: RecordedSender; router: ModelRouter | null }, kind: 'text' | 'button' = 'text') {
    const before = deps.sender.sent.length;
    await storeInbound(sql, [inbound(waId, text, kind)]);
    await processInbound(sql, { ...deps, siteUrl: SITE });
    return deps.sender.sent.slice(before).map((s) => s.reply);
  }

  it('answers an unlinked number with how to link, and shows it nothing', async () => {
    const sender = new RecordedSender();
    const [r] = await say('13055550001', 'sellers', { sender, router: null });
    assert.match(r?.text ?? '', /not linked/);
    assert.ok(!(r?.text ?? '').includes('EXAMPLE WAY'));
  });

  it('links a number with a one-time code, limits wrong codes, and unlinks on STOP', async () => {
    const { u } = await agent('33401');
    const sender = new RecordedSender();
    const deps = { sender, router: null };
    const waId = '13055550002';
    const { code } = await createLinkCode(sql, u);
    const [bad] = await say(waId, `LINK ${code === '000000' ? '111111' : '000000'}`, deps);
    assert.match(bad?.text ?? '', /not valid/);
    const [ok] = await say(waId, `link ${code}`, deps);
    assert.match(ok?.text ?? '', /^Linked\. Hi Ana/);
    assert.deepEqual(await getWhatsAppLink(sql, u), { linked: true, number: '+1 ••• ••• 0002', linkedAt: (await getWhatsAppLink(sql, u)).linkedAt });
    const [again] = await say(waId, `LINK ${code}`, deps);
    assert.match(again?.text ?? '', /not valid/, 'a code works once');
    const [audit] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'whatsapp_link' AND action = 'linked' AND actor_id = ${u.userId}`;
    assert.equal(audit?.n, 1);

    const [stop] = await say(waId, 'STOP', deps);
    assert.match(stop?.text ?? '', /unlinked/);
    assert.equal((await getWhatsAppLink(sql, u)).linked, false);

    const other = '13055550003';
    for (let i = 0; i < 5; i++) await say(other, 'LINK 999999', deps);
    const { code: fresh } = await createLinkCode(sql, u);
    const [blocked] = await say(other, `LINK ${fresh}`, deps);
    assert.match(blocked?.text ?? '', /Too many attempts/, 'five wrong codes in an hour block the number');
  });

  it('serves a linked agent from the same services as the web app: lists, details, triage, a letter draft', async () => {
    const { u, workspaceId } = await agent('33402');
    const waId = '13055550004';
    const { code } = await createLinkCode(sql, u);
    const sender = new RecordedSender();
    // The letter the model "writes" is for the first home in the list, as the list will be ordered.
    const first = (await listOpportunities(sql, u, workspaceId, { limit: 5 }))[0]!;
    const house = Number(first.address.split(' ')[0]);
    const provider = new RecordedProvider([modelReply({ command: 'sellers' }), modelReply(letter(house))]);
    let t = 0;
    const router = new ModelRouter({ providers: { anthropic: provider }, now: () => (t += 500) });
    const deps = { sender, router };
    await say(waId, `LINK ${code}`, deps);

    const [summary] = await say(waId, 'hi', deps);
    assert.match(summary?.text ?? '', /2 seller opportunities/);

    const [list] = await say(waId, 'anything interesting in my area?', deps);
    assert.equal(provider.calls.length, 1, 'free text the parser did not know went to the fast model');
    assert.match(list?.text ?? '', new RegExp(`Best seller opportunities[\\s\\S]*1\\. ${house} EXAMPLE WAY`));
    const [run] = await sql<{ purpose: string; role: string; prompt_version: string }[]>`SELECT purpose, role, prompt_version FROM model_runs WHERE workspace_id = ${workspaceId}`;
    assert.deepEqual(run, { purpose: 'assistant_intent', role: 'fast', prompt_version: 'assistant-intent-v1' });

    const [detail] = await say(waId, '2', deps);
    assert.match(detail?.text ?? '', /Public record: https:\/\/app\.example\.com\/opportunities\//);
    assert.deepEqual(detail?.buttons?.map((b) => b.command), ['draft 2', 'save 2', 'dismiss 2']);

    await say(waId, 'save 2', deps, 'button');
    const saved = await listOpportunities(sql, u, workspaceId, { view: 'saved' });
    assert.equal(saved.length, 1);

    const replies = await say(waId, 'draft 1', deps);
    assert.match(replies[0]?.text ?? '', /^Writing a letter/);
    assert.match(replies[1]?.text ?? '', new RegExp(`draft ready for review[\\s\\S]*Dear Owner of ${house} Example Way[\\s\\S]*Nothing has been sent`));
    const campaigns = await listCampaigns(sql, u, workspaceId);
    assert.equal(campaigns.length, 1);
    const [actions] = await sql<{ state: string; n: number }[]>`SELECT min(state) AS state, count(*)::int AS n FROM outreach_actions WHERE campaign_id = ${campaigns[0]!.id}`;
    assert.deepEqual(actions, { state: 'DRAFT', n: 1 });

    const [same] = await say(waId, 'draft 1', deps);
    assert.match(same?.text ?? '', new RegExp(`Dear Owner of ${house}`), 'an existing letter is shown, not written again');
    assert.equal(provider.calls.length, 2);

    const [refused] = await say(waId, 'send it to the owner now', { sender, router: null });
    assert.match(refused?.text ?? '', /Sending, approving and mailing are done in the app/);

    const [audited] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = ${workspaceId} AND via = 'whatsapp'`;
    assert.ok((audited?.n ?? 0) >= 2, 'actions taken from WhatsApp are audited as such');
  });

  it('keeps accounts apart: a number sees only its own agent, and the web can unlink it', async () => {
    const a = await agent('33403');
    const b = await agent('33404');
    const sender = new RecordedSender();
    const deps = { sender, router: null };
    await say('13055550005', `LINK ${(await createLinkCode(sql, a.u)).code}`, deps);
    await say('13055550006', `LINK ${(await createLinkCode(sql, b.u)).code}`, deps);
    const [listA] = await say('13055550005', 'sellers', deps);
    assert.match(listA?.text ?? '', /33403[12] EXAMPLE WAY/);
    assert.ok(!(listA?.text ?? '').includes('33404'), 'nothing from the other agent');
    assert.equal(await unlinkWhatsApp(sql, { ...a.u }), true);
    const [after] = await say('13055550005', 'sellers', deps);
    assert.match(after?.text ?? '', /not linked/);
  });

  it('answers each message once, even when the webhook is retried', async () => {
    const sender = new RecordedSender();
    const m = inbound('13055550007', 'help');
    assert.equal(await storeInbound(sql, [m]), 1);
    assert.equal(await storeInbound(sql, [m]), 0);
    await Promise.all([processInbound(sql, { sender, router: null, siteUrl: SITE }), processInbound(sql, { sender, router: null, siteUrl: SITE })]);
    assert.equal(sender.sent.filter((s) => s.to === '13055550007').length, 1);
  });
});
