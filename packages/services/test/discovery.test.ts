import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { StoredParcel } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  type RequestContext,
  ServiceError,
  type Sql,
  claimCoverage,
  completeCoverage,
  countOpportunities,
  coverageToImport,
  createDb,
  ensureWorkspace,
  failCoverage,
  getDiscoveryStatus,
  getOpportunity,
  listOpportunities,
  pruneSupersededRecords,
  requestMissingDiscovery,
  saveBusinessProfile,
  scoreWorkspace,
  setOpportunityStatus,
  storeParcels,
  workspacesToScore,
} from '../src/index.ts';

// Synthetic parcels; not real properties or owners.
function parcel(n: number, over: Partial<StoredParcel> = {}): StoredParcel {
  return {
    parcelId: `TEST${String(n).padStart(6, '0')}`,
    countyCode: '23',
    assessmentYear: 2026,
    useCode: '001',
    situs: { address: `${n} EXAMPLE DR`, city: 'AVENTURA', zip: '33180' },
    owner: { name: `TEST OWNER ${n}`, address1: `${n} EXAMPLE DR`, address2: '', city: 'AVENTURA', state: 'FL', zip: '' },
    justValue: 1_000_000,
    assessedValue: 950_000,
    homestead: true,
    sale: null,
    units: 1,
    yearBuilt: 1970,
    livingArea: 2000,
    ...over,
  };
}
const absentee = (n: number, over: Partial<StoredParcel> = {}) =>
  parcel(n, {
    homestead: false,
    owner: { name: `TEST LLC ${n}`, address1: '9 SAMPLE ST', address2: '', city: 'NEW YORK', state: 'NY', zip: '10001' },
    assessedValue: 500_000,
    ...over,
  });

const profile = {
  licenseeName: 'Test Agent',
  brokerageName: 'Test Realty LLC',
  market: 'miami-dade',
  focusZips: ['33180'],
  propertyUses: ['single_family'],
};
const roll = { sourceFile: 'Dade 23 Preliminary NAL 2026.zip', rollLabel: '2026 preliminary roll', fileDate: '2026-07-27' };
const ASOF = new Date('2026-10-13T12:00:00Z');

function user(): RequestContext {
  const id = randomUUID();
  return { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
}

describe('discovery', () => {
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

  /** coverageToImport, limited to the ZIPs a test owns (tests share one database). */
  async function due(zips: string[], file = roll.sourceFile) {
    return (await coverageToImport(sql, '23', file)).filter((z) => zips.includes(z));
  }

  async function importZip(zip: string, parcels: StoredParcel[], r = roll) {
    await claimCoverage(sql, '23', [zip]);
    await storeParcels(sql, r.fileDate, parcels);
    await completeCoverage(sql, '23', [{ zip, parcelCount: parcels.length }], r);
  }

  it('runs the whole loop: profile → coverage request → import → scoring → feed', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    assert.equal((await getDiscoveryStatus(sql, u, workspaceId)).status, 'not_requested');
    await saveBusinessProfile(sql, u, workspaceId, profile);

    let status = await getDiscoveryStatus(sql, u, workspaceId);
    assert.equal(status.status, 'pending');
    assert.deepEqual(status.coverage.map((c) => [c.zip, c.status]), [['33180', 'pending']]);
    assert.deepEqual(await due(['33180']), ['33180']);
    assert.ok(!(await workspacesToScore(sql)).includes(workspaceId), 'waits for its ZIP import');

    const parcels = [absentee(1), absentee(2), parcel(3), absentee(4, { useCode: '004' }), parcel(5, { situs: { address: '5 X', city: 'A', zip: '33160' } })];
    await importZip('33180', parcels);
    assert.deepEqual(await due(['33180']), []);
    assert.deepEqual(await due(['33180'], 'Dade 23 Final NAL 2026.zip'), ['33180'], 'a newer roll re-imports');
    assert.ok((await workspacesToScore(sql)).includes(workspaceId));

    const result = await scoreWorkspace(sql, workspaceId, ASOF);
    // Parcels 1–4 are in 33180 (5 is stored under its own ZIP); 4 is a condo, outside the focus,
    // and 3 is owner-occupied with no other signal, so only the two absentee owners clear the bar.
    assert.equal(result.considered, 4);
    assert.equal(result.qualified, 2);
    assert.equal(result.kept, 2);

    const feed = await listOpportunities(sql, u, workspaceId);
    assert.deepEqual(feed.map((o) => o.parcelId), ['TEST000001', 'TEST000002']);
    assert.ok(feed.every((o) => o.score >= 40 && o.reasons.some((r) => r.code === 'absentee_owner')));
    assert.equal(feed[0]?.ownerLocation, 'NEW YORK, NY');

    const detail = await getOpportunity(sql, u, workspaceId, feed[0]!.id);
    assert.equal(detail.source.rollLabel, '2026 preliminary roll');
    assert.equal(detail.source.fileDate, '2026-07-27');
    assert.match(detail.source.name, /Florida Department of Revenue/);

    status = await getDiscoveryStatus(sql, u, workspaceId);
    assert.equal(status.status, 'ready');
    assert.equal(status.opportunityCount, 2);
    assert.equal(status.coverage[0]?.parcelCount, 5);
    const [audit] = await sql<{ detail: { kept: number } }[]>`
      SELECT detail FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'discovery_scored'
    `;
    assert.equal(audit?.detail.kept, 2);
  });

  it('keeps triage on re-score, drops unreviewed ones that no longer qualify, and audits status changes', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, { ...profile, focusZips: ['33181'] });
    await importZip('33181', [absentee(11, { situs: { address: '11 X', city: 'A', zip: '33181' } }), absentee(12, { situs: { address: '12 X', city: 'A', zip: '33181' } })]);
    await scoreWorkspace(sql, workspaceId, ASOF);
    const [first, second] = await listOpportunities(sql, u, workspaceId);
    assert.ok(first && second);

    assert.equal(await setOpportunityStatus(sql, u, workspaceId, first.id, 'saved'), 'saved');
    assert.equal(await setOpportunityStatus(sql, u, workspaceId, second.id, 'dismissed'), 'dismissed');
    await assert.rejects(setOpportunityStatus(sql, u, workspaceId, first.id, 'in_campaign'), ServiceError);
    assert.deepEqual(await countOpportunities(sql, u, workspaceId), { active: 1, saved: 1, dismissed: 1 });

    // A newer roll where both parcels were bought by homesteaders: neither qualifies any more.
    const final = { ...roll, sourceFile: 'Dade 23 Final NAL 2026.zip', fileDate: '2026-10-05' };
    await importZip('33181', [
      parcel(11, { situs: { address: '11 X', city: 'A', zip: '33181' } }),
      parcel(12, { situs: { address: '12 X', city: 'A', zip: '33181' } }),
    ], final);
    await scoreWorkspace(sql, workspaceId, ASOF);
    // Reviewed opportunities stay, with their status; nothing new was added.
    assert.deepEqual(await countOpportunities(sql, u, workspaceId), { active: 1, saved: 1, dismissed: 1 });

    const audits = await sql<{ from_state: string; to_state: string }[]>`
      SELECT from_state, to_state FROM audit_events WHERE workspace_id = ${workspaceId} AND entity_type = 'opportunity' ORDER BY id
    `;
    assert.deepEqual(audits.map((a) => `${a.from_state}>${a.to_state}`), ['new>saved', 'new>dismissed']);
    // Records from the old roll are still referenced by the kept opportunities, so they are not pruned.
    await pruneSupersededRecords(sql);
    assert.equal((await getOpportunity(sql, u, workspaceId, first.id)).source.fileDate, '2026-07-27');
  });

  it('prunes superseded records nothing refers to', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, { ...profile, focusZips: ['33182'] });
    const p = parcel(21, { situs: { address: '21 X', city: 'A', zip: '33182' } });
    await importZip('33182', [p]);
    await importZip('33182', [p], { ...roll, sourceFile: 'newer.zip', fileDate: '2026-10-06' });
    const count = async () =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_records WHERE zip = '33182'`)[0]?.n;
    assert.equal(await count(), 2);
    assert.ok((await pruneSupersededRecords(sql)) >= 1);
    assert.equal(await count(), 1);
  });

  it('retries failed imports when the profile is saved again, and backfills old profiles', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, { ...profile, focusZips: ['33183'] });
    await claimCoverage(sql, '23', ['33183']);
    await failCoverage(sql, '23', ['33183'], 'download failed');
    assert.deepEqual(await due(['33183']), [], 'not retried immediately');
    await saveBusinessProfile(sql, u, workspaceId, { ...profile, focusZips: ['33183'], specialty: 'Estates' });
    assert.equal((await getDiscoveryStatus(sql, u, workspaceId)).coverage[0]?.status, 'failed', 'specialty alone does not re-request');
    await saveBusinessProfile(sql, u, workspaceId, { ...profile, focusZips: ['33183', '33184'] });
    assert.deepEqual(await due(['33183', '33184']), ['33183', '33184']);

    await sql`DELETE FROM workspace_discovery WHERE workspace_id = ${workspaceId}`;
    assert.ok((await requestMissingDiscovery(sql)) >= 1);
    assert.equal((await getDiscoveryStatus(sql, u, workspaceId)).status, 'pending');
  });

  it('fails scoring when discovery permission is revoked', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, { ...profile, focusZips: ['33185'] });
    await sql`UPDATE workspace_permissions SET revoked_at = now() WHERE workspace_id = ${workspaceId} AND kind = 'discover'`;
    await assert.rejects(scoreWorkspace(sql, workspaceId, ASOF), /not permitted/);
    assert.equal((await getDiscoveryStatus(sql, u, workspaceId)).status, 'failed');
  });

  it('keeps tenants apart', async () => {
    const owner = user();
    const stranger = user();
    const { workspaceId } = await ensureWorkspace(sql, owner);
    const theirs = await ensureWorkspace(sql, stranger);
    await saveBusinessProfile(sql, owner, workspaceId, { ...profile, focusZips: ['33186'] });
    await importZip('33186', [absentee(31, { situs: { address: '31 X', city: 'A', zip: '33186' } })]);
    await scoreWorkspace(sql, workspaceId, ASOF);
    const [opp] = await listOpportunities(sql, owner, workspaceId);
    assert.ok(opp);

    for (const attempt of [
      () => listOpportunities(sql, stranger, workspaceId),
      () => getOpportunity(sql, stranger, workspaceId, opp.id),
      () => setOpportunityStatus(sql, stranger, workspaceId, opp.id, 'dismissed'),
      () => getDiscoveryStatus(sql, stranger, workspaceId),
    ]) {
      await assert.rejects(attempt(), (e) => e instanceof ServiceError && e.code === 'forbidden');
    }
    // Their own workspace id does not unlock another workspace's opportunity.
    await assert.rejects(getOpportunity(sql, stranger, theirs.workspaceId, opp.id), (e) => e instanceof ServiceError && e.code === 'not_found');
    await assert.rejects(getOpportunity(sql, owner, workspaceId, 'nope'), (e) => e instanceof ServiceError && e.code === 'not_found');
  });
});
