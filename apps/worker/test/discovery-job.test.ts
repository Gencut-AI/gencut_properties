import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { RollChoice } from '@gencut/core';
import {
  type RequestContext,
  type Sql,
  createDb,
  ensureWorkspace,
  getDiscoveryStatus,
  listOpportunities,
  saveBusinessProfile,
} from '@gencut/services';
import { migrateUp } from '../../../packages/db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../../packages/db/test/helpers.ts';
import { hasErrors, runDiscovery } from '../src/discovery-job.ts';
import type { RollSource } from '../src/dor.ts';

// Synthetic roll rows in the DOR NAL layout. Not real parcels or owners.
const HEADER = ['CO_NO', 'PARCEL_ID', 'ASMNT_YR', 'DOR_UC', 'JV', 'AV_SD', 'AV_NSD', 'JV_HMSTD', 'OWN_NAME', 'OWN_ADDR1', 'OWN_CITY', 'OWN_STATE', 'PHY_ADDR1', 'PHY_CITY', 'PHY_ZIPCD'];
const row = (id: string, zip: string, absentee: boolean, use = '001') => [
  '23', id, '2026', use, '1000000', '1000000', absentee ? '500000' : '980000', absentee ? '' : '1000000',
  `TEST OWNER ${id}`, absentee ? '9 SAMPLE ST' : `${id} EXAMPLE DR`, absentee ? 'NEW YORK' : 'AVENTURA', absentee ? 'NY' : 'FL',
  `${id} EXAMPLE DR`, 'AVENTURA', zip,
];

function fakeSource(rows: string[][], opts: { header?: string[]; file?: string; fail?: boolean } = {}): RollSource & { reads: number } {
  const choice: RollChoice = {
    file: { name: opts.file ?? 'Dade 23 Preliminary NAL 2026.zip', serverRelativeUrl: '/x', length: 1, lastModified: '2026-07-27T00:00:00Z' },
    year: 2026,
    stage: 'preliminary',
    label: '2026 preliminary roll',
    fileDate: '2026-07-27',
  };
  const source = {
    reads: 0,
    async latest(county: string) {
      if (opts.fail) throw new Error('connection refused');
      return county === '23' ? choice : null;
    },
    async rows(_c: RollChoice, onRow: (f: string[]) => void) {
      source.reads++;
      onRow(opts.header ?? HEADER);
      for (const r of rows) onRow(r);
    },
  };
  return source;
}

function user(): RequestContext {
  const id = randomUUID();
  return { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
}
const profile = (zips: string[]) => ({
  licenseeName: 'Test Agent',
  brokerageName: 'Test Realty LLC',
  market: 'miami-dade',
  focusZips: zips,
  propertyUses: ['single_family'],
});
const ASOF = new Date('2026-10-13T12:00:00Z');

describe('discovery job', () => {
  let tdb: TestDb;
  let sql: Sql;
  before(() => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 3 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  it('imports requested ZIPs from the roll, scores the workspace, and does nothing more on a second run', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, profile(['33180']));
    const source = fakeSource([
      row('A1', '33180', true),
      row('A2', '33180', false),
      row('A3', '33180-0001', true),
      row('C1', '33180', true, '011'), // commercial: not imported
      row('B1', '33160', true), // not requested
    ]);
    const lines: string[] = [];
    const first = await runDiscovery({ sql, source, asOf: ASOF, log: (l) => lines.push(l) });
    assert.equal(hasErrors(first), false);
    assert.deepEqual(first.imports, [{ county: '23', file: 'Dade 23 Preliminary NAL 2026.zip', zips: ['33180'], parcels: 3 }]);
    assert.deepEqual(first.scored, [{ workspaceId, kept: 2 }]);
    assert.deepEqual((await listOpportunities(sql, u, workspaceId)).map((o) => o.parcelId), ['A1', 'A3']);
    assert.ok(lines.every((l) => !l.includes('TEST OWNER') && !l.includes('EXAMPLE DR')), 'logs carry no names or addresses');

    const second = await runDiscovery({ sql, source, asOf: ASOF });
    assert.deepEqual(second.imports, []);
    assert.deepEqual(second.scored, []);
    assert.equal(source.reads, 1);
  });

  it('marks coverage failed when the roll is missing columns, and when the portal is unreachable', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, profile(['33190']));
    const bad = await runDiscovery({ sql, source: fakeSource([], { header: ['CO_NO', 'PARCEL_ID'] }), asOf: ASOF });
    assert.ok(hasErrors(bad));
    let status = await getDiscoveryStatus(sql, u, workspaceId);
    assert.equal(status.coverage[0]?.status, 'failed');
    // Scoring still runs with whatever is covered, so the agent sees a finished (empty) result.
    assert.equal(status.status, 'ready');

    const u2 = user();
    const ws2 = await ensureWorkspace(sql, u2);
    await saveBusinessProfile(sql, u2, ws2.workspaceId, profile(['33191']));
    const offline = await runDiscovery({ sql, source: fakeSource([], { fail: true }), asOf: ASOF });
    assert.match(offline.imports[0]?.error ?? '', /Could not reach/);
    status = await getDiscoveryStatus(sql, u2, ws2.workspaceId);
    assert.equal(status.coverage[0]?.status, 'failed');
    // ZIPs imported earlier keep their data through an outage.
    const [ready] = await sql<{ status: string }[]>`SELECT status FROM zip_coverage WHERE zip = '33180'`;
    assert.equal(ready?.status, 'ready');
  });
});
