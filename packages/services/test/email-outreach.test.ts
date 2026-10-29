import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { CampaignDraft, StoredParcel } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  approveAndSendEmail,
  claimCoverage,
  completeCoverage,
  createDb,
  type EmailConfig,
  emailConfigFromEnv,
  enableEmailOutreach,
  ensureWorkspace,
  generateCampaignDraft,
  getEmailOutreach,
  getLeadsOverview,
  listOpportunities,
  ModelRouter,
  prepareEmailOutreach,
  RecordedEmailTransport,
  RecordedProvider,
  type RequestContext,
  ResendTransport,
  saveBusinessProfile,
  scoreWorkspace,
  ServiceError,
  type Sql,
  startCampaignDraft,
  storeParcels,
  storeZipIndex,
  unsubscribeByToken,
  unsubscribeToken,
  updateCampaignLetter,
  verifyUnsubscribeToken,
} from '../src/index.ts';

// Synthetic parcels, agent, letters and addresses. Nothing here is a real person or property.
const ASOF = new Date('2026-10-13T12:00:00Z');
const roll = { sourceFile: 'Dade 23 Preliminary NAL 2026.zip', rollLabel: '2026 preliminary roll', fileDate: '2026-07-27' };
const OFFICE = '100 Example Blvd, Miami, FL 33131';
// A fake signing secret (low-entropy on purpose, so secret scanners do not flag it).
const SECRET = 'x'.repeat(40);

const config = (over: Partial<EmailConfig> = {}): EmailConfig => ({
  apiKey: 'test-resend-key',
  fromAddress: 'outreach@mail.example.com',
  mode: 'test_only',
  testInboxes: ['tester@example.com', '@team.example.org'],
  unsubscribeSecret: SECRET,
  siteUrl: 'https://gencut.example',
  ...over,
});

function parcel(n: number, zip: string): StoredParcel {
  return {
    parcelId: `MAIL${String(n).padStart(6, '0')}`,
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

const draftFor = (n: number): CampaignDraft => ({
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
  },
  followUp: [{ day: 21, channel: 'mail', action: 'Send a short second letter if there is no reply.' }],
  factsUsed: ['property.address', 'property.year_built', 'agent.brokerage'],
});

function user(): RequestContext {
  const id = randomUUID();
  return { userId: id, email: `agent-${id.slice(0, 8)}@example.com`, via: 'web' };
}

describe('email outreach', () => {
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

  /** A workspace with a reviewed campaign letter, ready to email. */
  async function setup(zip: string, office: string | null = OFFICE) {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, {
      licenseeName: 'Ana Test',
      brokerageName: 'Example Bay Realty LLC',
      licenseNumber: 'SL3456789',
      ...(office ? { officeAddress: office } : {}),
      market: 'miami-dade',
      focusZips: [zip],
      propertyUses: ['single_family'],
    });
    await claimCoverage(sql, '23', [zip]);
    await storeParcels(sql, roll.fileDate, [parcel(Number(zip), zip)]);
    await completeCoverage(sql, '23', [{ zip, parcelCount: 1 }], roll);
    await scoreWorkspace(sql, workspaceId, ASOF);
    const [opp] = await listOpportunities(sql, u, workspaceId);
    assert.ok(opp);
    const { campaignId } = await startCampaignDraft(sql, u, workspaceId, opp.id);
    const provider = new RecordedProvider([{ text: JSON.stringify(draftFor(Number(zip))), usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } }]);
    assert.equal(await generateCampaignDraft(sql, campaignId, new ModelRouter({ providers: { anthropic: provider } })), 'review');
    return { u, workspaceId, campaignId };
  }

  const states = (actionId: string) =>
    sql<{ to_state: string; actor_type: string; action: string }[]>`
      SELECT to_state, actor_type, action FROM audit_events WHERE entity_type = 'outreach_action' AND entity_id = ${actionId} ORDER BY id`;

  it('requires the email permission, a complete profile and a test inbox before preparing', async () => {
    const { u, workspaceId, campaignId } = await setup('33401', null);
    const view = await getEmailOutreach(sql, u, workspaceId, campaignId, config());
    assert.deepEqual({ configured: view.configured, permitted: view.permitted, missing: view.missing, action: view.action }, {
      configured: true, permitted: false, missing: ['your office address'], action: null,
    });
    assert.equal((await getEmailOutreach(sql, u, workspaceId, campaignId, null)).configured, false);

    await assert.rejects(prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'Hello there' }, null), /not set up/);
    await assert.rejects(
      prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'not an email', subject: 'Hello there' }, config()),
      (e: ServiceError) => e.fields.to === 'Enter a valid email address.',
    );
    await assert.rejects(
      prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'Re: your home' }, config()),
      (e: ServiceError) => Boolean(e.fields.subject),
    );
    await assert.rejects(
      prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'owner@example.net', subject: 'Hello there' }, config()),
      /test mode/,
    );
    await assert.rejects(
      prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'Hello there' }, config({ mode: 'off' })),
      /switched off/,
    );
    await assert.rejects(
      prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'Hello there' }, config()),
      /office address/,
    );

    // A member who is not the owner cannot switch the channel on; a stranger cannot see anything.
    await assert.rejects(enableEmailOutreach(sql, user(), workspaceId), (e: ServiceError) => e.code === 'forbidden');
    await assert.rejects(getEmailOutreach(sql, user(), workspaceId, campaignId, config()), (e: ServiceError) => e.code === 'forbidden');
  });

  it('prepares, approves and sends one exact email through the gate, with an audit trail', async () => {
    const { u, workspaceId, campaignId } = await setup('33402');
    const transport = new RecordedEmailTransport();
    // Without the email permission the gate blocks even an approved message.
    const { actionId: blockedId } = await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config());
    const blocked = await approveAndSendEmail(sql, u, workspaceId, blockedId, config(), transport);
    assert.equal(blocked.state, 'FAILED');
    assert.match(blocked.failureReason ?? '', /not enabled contact by email/);
    assert.equal(transport.sent.length, 0, 'nothing sent');

    await enableEmailOutreach(sql, u, workspaceId);
    await enableEmailOutreach(sql, u, workspaceId); // idempotent
    const [grants] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workspace_permissions WHERE workspace_id = ${workspaceId} AND kind = 'contact' AND channel = 'email'`;
    assert.equal(grants?.n, 1);

    // Preparing again reuses the failed action: FAILED → DRAFT → READY.
    const { actionId } = await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: ' Tester@Example.com ', subject: 'A note from Ana' }, config());
    assert.equal(actionId, blockedId);
    const ready = await getEmailOutreach(sql, u, workspaceId, campaignId, config());
    assert.equal(ready.action?.state, 'READY');
    assert.equal(ready.action?.to, 'tester@example.com');
    assert.ok(ready.action?.text.includes(OFFICE));
    assert.ok(ready.action?.text.includes(`https://gencut.example/u/${unsubscribeToken(SECRET, actionId)}`));

    const sent = await approveAndSendEmail(sql, u, workspaceId, actionId, config(), transport, () => ASOF);
    assert.equal(sent.state, 'COMPLETED');
    assert.ok(sent.checks.every((c) => c.passed));
    assert.equal(transport.sent.length, 1);
    const m = transport.sent[0]!;
    assert.equal(m.to, 'tester@example.com');
    assert.equal(m.from, 'Ana Test (Example Bay Realty LLC) <outreach@mail.example.com>');
    assert.equal(m.replyTo, u.email, 'replies go to the agent');
    assert.equal(m.idempotencyKey, actionId);
    assert.match(m.headers['List-Unsubscribe'] ?? '', /^<https:\/\/gencut\.example\/api\/unsubscribe\?t=/);
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

    const [row] = await sql<{ state: string; approved_by: string; executed_at: Date | null }[]>`SELECT state, approved_by, executed_at FROM outreach_actions WHERE id = ${actionId}`;
    assert.equal(row?.state, 'COMPLETED');
    assert.equal(row?.approved_by, u.userId);
    assert.ok(row?.executed_at);
    assert.deepEqual(
      (await states(actionId)).map((e) => `${e.actor_type}:${e.action}:${e.to_state}`),
      [
        'user:prepared:READY',
        'user:approved:APPROVED',
        'executor:blocked:FAILED',
        'user:prepared:READY',
        'user:approved:APPROVED',
        'executor:gate_passed:EXECUTING',
        'executor:sent:COMPLETED',
      ],
    );
    // The mailed letter's state is separate and unchanged.
    const view = await getEmailOutreach(sql, u, workspaceId, campaignId, config());
    assert.deepEqual(view.sentTo, ['tester@example.com']);
    assert.ok(view.action?.sentAt);

    // Sent once: it cannot be approved again, and the same address cannot be emailed twice from this campaign.
    await assert.rejects(approveAndSendEmail(sql, u, workspaceId, actionId, config(), transport), /already sent/);
    await assert.rejects(
      prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config()),
      /already emailed/,
    );
    // Another test inbox gets a new action.
    const second = await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'someone@team.example.org', subject: 'A note from Ana' }, config());
    assert.notEqual(second.actionId, actionId);
  });

  it('refuses to send an email built from an earlier version of the letter', async () => {
    const { u, workspaceId, campaignId } = await setup('33403');
    await enableEmailOutreach(sql, u, workspaceId);
    const { actionId } = await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config());
    const d = draftFor(33403);
    await updateCampaignLetter(sql, u, workspaceId, campaignId, { ...d.letter, paragraphs: [...d.letter.paragraphs, 'Thank you for reading.'] });
    assert.equal((await getEmailOutreach(sql, u, workspaceId, campaignId, config())).action?.stale, true);
    const transport = new RecordedEmailTransport();
    await assert.rejects(approveAndSendEmail(sql, u, workspaceId, actionId, config(), transport), /letter changed/);
    assert.equal(transport.sent.length, 0);
    // Preparing again picks up the new letter.
    await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config());
    const view = await getEmailOutreach(sql, u, workspaceId, campaignId, config());
    assert.equal(view.action?.stale, false);
    assert.ok(view.action?.text.includes('Thank you for reading.'));
  });

  it('records a provider failure as FAILED, without the key', async () => {
    const { u, workspaceId, campaignId } = await setup('33404');
    await enableEmailOutreach(sql, u, workspaceId);
    const { actionId } = await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config());
    const transport = new RecordedEmailTransport();
    transport.failWith = 'The email service refused the message (403, validation_error): domain not verified';
    const r = await approveAndSendEmail(sql, u, workspaceId, actionId, config(), transport);
    assert.equal(r.state, 'FAILED');
    assert.match(r.failureReason ?? '', /domain not verified/);
    assert.equal((await states(actionId)).at(-1)?.action, 'send_failed');
  });

  it('unsubscribe links add a suppression that blocks later email to that address', async () => {
    const { u, workspaceId, campaignId } = await setup('33405');
    await enableEmailOutreach(sql, u, workspaceId);
    const { actionId } = await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config());
    const token = unsubscribeToken(SECRET, actionId);
    assert.equal(verifyUnsubscribeToken(SECRET, token), actionId);
    assert.equal(verifyUnsubscribeToken('y'.repeat(40), token), null, 'forged with another secret');
    assert.equal(verifyUnsubscribeToken(SECRET, `${actionId}.${'A'.repeat(32)}`), null);
    assert.equal(verifyUnsubscribeToken(SECRET, 'garbage'), null);
    assert.deepEqual(await unsubscribeByToken(sql, SECRET, 'garbage'), { ok: false, sender: null });

    const done = await unsubscribeByToken(sql, SECRET, token);
    assert.deepEqual(done, { ok: true, sender: 'Ana Test (Example Bay Realty LLC)' });
    assert.equal((await unsubscribeByToken(sql, SECRET, token)).ok, true, 'idempotent');
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = ${workspaceId} AND address = 'tester@example.com'`;
    assert.equal(n?.n, 1);

    // The prepared email is now blocked by the gate, and new ones cannot be prepared.
    const transport = new RecordedEmailTransport();
    const r = await approveAndSendEmail(sql, u, workspaceId, actionId, config(), transport);
    assert.equal(r.state, 'FAILED');
    assert.match(r.failureReason ?? '', /opted out/);
    assert.equal(transport.sent.length, 0);
    await assert.rejects(
      prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config()),
      /unsubscribed/,
    );
  });

  it('the Leads overview counts the county, campaigns and emails, and marks emailed leads', async () => {
    const { u, workspaceId, campaignId } = await setup('33406');
    const [{ opportunity_id: oppId } = { opportunity_id: '' }] = await sql<{ opportunity_id: string }[]>`SELECT opportunity_id FROM campaigns WHERE id = ${campaignId}`;
    const before = await getLeadsOverview(sql, u, workspaceId);
    assert.equal(before.campaigns, 1);
    assert.equal(before.emailsSent, 0);
    assert.equal(before.outreach[oppId], 'campaign');

    await storeZipIndex(sql, '23', 'Dade 23 Preliminary NAL 2026.zip', roll.fileDate, new Map([['33406', 1200], ['33407', 800]]));
    await enableEmailOutreach(sql, u, workspaceId);
    const { actionId } = await prepareEmailOutreach(sql, u, workspaceId, campaignId, { to: 'tester@example.com', subject: 'A note from Ana' }, config());
    await approveAndSendEmail(sql, u, workspaceId, actionId, config(), new RecordedEmailTransport());

    const after = await getLeadsOverview(sql, u, workspaceId);
    assert.equal(after.outreach[oppId], 'emailed');
    assert.equal(after.emailsSent, 1);
    assert.ok((after.countyHomes ?? 0) >= 2000);
    assert.ok((after.countyZips ?? 0) >= 2);
    await assert.rejects(getLeadsOverview(sql, user(), workspaceId), (e: ServiceError) => e.code === 'forbidden');
  });

  it('reads configuration from the environment and sends through Resend with the key only in a header', async () => {
    assert.equal(emailConfigFromEnv({}), null);
    const env = {
      RESEND_API_KEY: 'test-resend-key',
      GENCUT_EMAIL_FROM: 'Outreach@Mail.Example.com',
      GENCUT_UNSUBSCRIBE_SECRET: SECRET,
      GENCUT_SITE_URL: 'https://gencut.example/',
      GENCUT_EMAIL_TEST_INBOXES: 'tester@example.com',
    };
    assert.deepEqual(emailConfigFromEnv(env), {
      apiKey: 'test-resend-key', fromAddress: 'outreach@mail.example.com', mode: 'off', testInboxes: ['tester@example.com'],
      unsubscribeSecret: SECRET, siteUrl: 'https://gencut.example',
    });
    assert.equal(emailConfigFromEnv({ ...env, GENCUT_EMAIL_MODE: 'test_only' })?.mode, 'test_only');
    assert.equal(emailConfigFromEnv({ ...env, GENCUT_UNSUBSCRIBE_SECRET: 'short' }), null);

    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const ok = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return Response.json({ id: 'msg_123' });
    }) as typeof fetch;
    const message = {
      from: 'Ana <outreach@mail.example.com>', replyTo: 'agent@example.com', to: 'tester@example.com', subject: 's', text: 't', html: '<p>t</p>',
      headers: { 'List-Unsubscribe': '<https://x>' }, idempotencyKey: 'action-1',
    };
    assert.deepEqual(await new ResendTransport('test-resend-key', ok).send(message), { id: 'msg_123' });
    assert.equal(seen!.url, 'https://api.resend.com/emails');
    assert.equal(seen!.headers.authorization, 'Bearer test-resend-key');
    assert.equal(seen!.headers['idempotency-key'], 'action-1');
    assert.deepEqual(seen!.body.to, ['tester@example.com']);
    assert.equal(seen!.body.reply_to, 'agent@example.com');
    assert.ok(!JSON.stringify(seen!.body).includes('test-resend-key'));

    const denied = (async () => Response.json({ name: 'validation_error', message: 'bad key test-resend-key' }, { status: 403 })) as typeof fetch;
    await assert.rejects(
      new ResendTransport('test-resend-key', denied).send(message),
      (e: Error) => /403, validation_error/.test(e.message) && !e.message.includes('test-resend-key'),
    );
  });
});
