import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  createDb,
  createLeadPage,
  ensureWorkspace,
  getLeadPage,
  getLeadsOverview,
  getPublicLeadPage,
  LEADS_PER_VISITOR_PER_DAY,
  listInboundLeads,
  type RequestContext,
  saveBusinessProfile,
  ServiceError,
  setInboundLeadStatus,
  type Sql,
  submitInboundLead,
  submitterKey,
} from '../src/index.ts';

// Synthetic agent and visitors.
const user = (): RequestContext => {
  const id = randomUUID();
  return { userId: id, email: `agent-${id.slice(0, 8)}@example.com`, via: 'web' };
};
const visitor = (n: number) => ({ name: `Visitor ${n}`, email: `visitor${n}@example.com`, phone: '', interest: 'selling', zip: '33180', message: '', consent: true });

describe('lead pages', () => {
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

  async function agent() {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, {
      licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', licenseNumber: 'SL3456789', market: 'miami-dade', focusZips: ['33180'], propertyUses: ['single_family'],
    });
    return { u, workspaceId };
  }

  it('creates one page per workspace, owner only, and shows the agent publicly', async () => {
    const { u, workspaceId } = await agent();
    assert.equal(await getLeadPage(sql, u, workspaceId), null);
    await assert.rejects(createLeadPage(sql, user(), workspaceId), (e: ServiceError) => e.code === 'forbidden');
    const page = await createLeadPage(sql, u, workspaceId);
    assert.match(page.slug, /^ana-test-[0-9a-f]{6}$/);
    assert.deepEqual(await createLeadPage(sql, u, workspaceId), page, 'idempotent');
    const pub = await getPublicLeadPage(sql, page.slug);
    assert.equal(pub?.agentName, 'Ana Test');
    assert.deepEqual(pub?.zips, ['33180']);
    assert.match(pub?.consentText ?? '', /Ana Test of Example Bay Realty LLC/);
    assert.equal(await getPublicLeadPage(sql, 'no-such-page'), null);
    assert.equal(await getPublicLeadPage(sql, '../x'), null);
  });

  it('stores a submission with its consent and source, lists it, and tracks status', async () => {
    const { u, workspaceId } = await agent();
    const { slug } = await createLeadPage(sql, u, workspaceId);
    const key = submitterKey('203.0.113.7', '2026-10-29');
    assert.deepEqual(await submitInboundLead(sql, slug, { ...visitor(1), consent: false }, { source: 'instagram', submitter: key }), {
      ok: false, fields: { consent: 'Tick the box so the agent may reply to you.' },
    });
    assert.deepEqual(await submitInboundLead(sql, slug, visitor(1), { source: 'instagram', submitter: key }), { ok: true });
    await submitInboundLead(sql, slug, visitor(2), { source: 'facebook', submitter: submitterKey('198.51.100.2', '2026-10-29') });

    const list = await listInboundLeads(sql, u, workspaceId);
    assert.equal(list.total, 2);
    assert.deepEqual(list.bySource, { instagram: 1, facebook: 1 });
    assert.equal(list.leads[1]?.source, 'instagram');
    const [consent] = await sql<{ address: string; scopes: string[]; disclosure_text: string }[]>`
      SELECT c.address, c.scopes, c.disclosure_text FROM inbound_leads l JOIN consents c ON c.id = l.consent_id WHERE l.email = 'visitor1@example.com'`;
    assert.equal(consent?.address, 'visitor1@example.com');
    assert.deepEqual(consent?.scopes, ['email_marketing']);
    assert.match(consent?.disclosure_text ?? '', /may contact me/);

    const id = list.leads[0]!.id;
    await setInboundLeadStatus(sql, u, workspaceId, id, 'contacted');
    await setInboundLeadStatus(sql, u, workspaceId, list.leads[1]!.id, 'dismissed');
    const after = await listInboundLeads(sql, u, workspaceId);
    assert.equal(after.leads.length, 1, 'dismissed leads are hidden');
    assert.equal(after.leads[0]?.status, 'contacted');
    await assert.rejects(listInboundLeads(sql, user(), workspaceId), (e: ServiceError) => e.code === 'forbidden');
    await assert.rejects(setInboundLeadStatus(sql, user(), workspaceId, id, 'new'), (e: ServiceError) => e.code === 'forbidden');
    const [audit] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'inbound_lead' AND workspace_id = ${workspaceId}`;
    assert.equal(audit?.n, 4);
    assert.equal((await getLeadsOverview(sql, u, workspaceId)).campaigns, 0);
  });

  it('limits submissions per visitor per day, and refuses unknown pages', async () => {
    const { u, workspaceId } = await agent();
    const { slug } = await createLeadPage(sql, u, workspaceId);
    const key = submitterKey('192.0.2.9', '2026-10-29');
    for (let i = 0; i < LEADS_PER_VISITOR_PER_DAY; i++) {
      assert.deepEqual(await submitInboundLead(sql, slug, visitor(10 + i), { source: 'link', submitter: key }), { ok: true });
    }
    const limited = await submitInboundLead(sql, slug, visitor(99), { source: 'link', submitter: key });
    assert.equal(limited.ok, false);
    assert.equal((await submitInboundLead(sql, 'no-such-page', visitor(1), { source: 'link', submitter: key })).ok, false);
    assert.notEqual(submitterKey('192.0.2.9', '2026-10-29'), submitterKey('192.0.2.9', '2026-10-30'), 'keys change daily');
  });
});
