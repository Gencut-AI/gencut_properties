import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { RollChoice } from '@gencut/core';
import {
  type RequestContext,
  type Sql,
  createDb,
  ensureWorkspace,
  getDiscoveryStatus,
  listBuyers,
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

function fakeSource(
  rows: string[][],
  opts: { header?: string[]; file?: string; fail?: boolean; prior?: string[][]; year?: number } = {},
): RollSource & { reads: number } {
  const year = opts.year ?? 2026;
  const choice: RollChoice = {
    file: { name: opts.file ?? `Dade 23 Preliminary NAL ${year}.zip`, serverRelativeUrl: '/x', length: 1, lastModified: `${year}-07-27T00:00:00Z` },
    year,
    stage: 'preliminary',
    label: `${year} preliminary roll`,
    fileDate: `${year}-07-27`,
  };
  const priorChoice: RollChoice = {
    ...choice,
    file: { ...choice.file, name: 'Dade 23 Final NAL 2025.zip' },
    year: 2025,
    stage: 'final',
    label: '2025 final roll',
  };
  const source = {
    reads: 0,
    async latest(county: string) {
      if (opts.fail) throw new Error('connection refused');
      return county === '23' ? choice : null;
    },
    async previous() {
      return opts.prior ? priorChoice : null;
    },
    async rows(c: RollChoice, onRow: (f: string[]) => void) {
      if (c !== choice) {
        onRow(opts.header ?? HEADER);
        for (const r of opts.prior ?? []) onRow(r);
        return;
      }
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
  // Each test uses its own synthetic ZIP codes; the county's ZIP counts from an earlier
  // test would (rightly) reject them, so every test starts before the county was counted.
  beforeEach(async () => {
    await sql`DELETE FROM county_zip_counts`;
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
    // The same pass counts homes per ZIP code across the county (commercial rows not counted).
    assert.deepEqual([...(await sql`SELECT zip, homes FROM county_zip_counts WHERE county_code = '23' ORDER BY zip`)], [
      { zip: '33160', homes: 1 },
      { zip: '33180', homes: 3 },
    ]);

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

  it('uses last year\'s roll to tell long ownership from a one-year revaluation, and skips institutions', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, profile(['33170']));
    const header = [...HEADER, 'EXMPT_09'];
    const withExempt = (r: string[], exempt = '') => [...r, exempt];
    const priorRow = (id: string, jv: string, av: string) => {
      const r = withExempt(row(id, '33170', true));
      r[2] = '2025';
      r[4] = jv;
      r[6] = av;
      return r;
    };
    const run = await runDiscovery({
      sql,
      source: fakeSource(
        [withExempt(row('H1', '33170', true)), withExempt(row('R1', '33170', true)), withExempt(row('X1', '33170', true), '400000')],
        { header, prior: [priorRow('H1', '900000', '450000'), priorRow('R1', '700000', '700000')] },
      ),
      asOf: ASOF,
    });
    assert.equal(hasErrors(run), false);
    assert.equal(run.imports[0]?.parcels, 2, 'the religious-exempt parcel is not imported');
    const feed = await listOpportunities(sql, u, workspaceId);
    const byId = new Map(feed.map((o) => [o.parcelId, o.reasons.map((r) => r.code)]));
    assert.ok(byId.get('H1')?.includes('long_held_strong'), 'gap in both rolls');
    assert.ok(!byId.get('R1')?.some((c) => c.startsWith('long_held') || c === 'assessment_gap'), 'gap only this year');
  });

  it('uses its own stored copy of last year\'s roll when DOR no longer publishes it', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, profile(['33171']));
    const asYear = (r: string[], y: string, jv: string, av: string) => {
      const c = [...r];
      c[2] = y;
      c[4] = jv;
      c[6] = av;
      return c;
    };
    // Last year: GenCut imports the 2025 roll as the current roll.
    await runDiscovery({ sql, source: fakeSource([asYear(row('S1', '33171', true), '2025', '900000', '450000')], { year: 2025 }), asOf: ASOF });
    // This year: DOR offers only the 2026 roll; the 2025 values come from GenCut's own records.
    const lines: string[] = [];
    await runDiscovery({ sql, source: fakeSource([row('S1', '33171', true)]), asOf: ASOF, log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes('stored records from the 2025 roll')));
    const [opp] = await listOpportunities(sql, u, workspaceId);
    assert.ok(opp?.reasons.some((r) => r.code === 'long_held_strong'), JSON.stringify(opp?.reasons.map((r) => r.code)));
  });
  it('reads county-wide company purchases in the same pass, once per roll file, and scores buyers', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, profile(['33180']));
    const H = [...HEADER, 'QUAL_CD1', 'SALE_PRC1', 'SALE_YR1', 'SALE_MO1'];
    const buy = (id: string, zip: string, owner: string, month: string, code = '01') => [
      '23', id, '2026', '001', '600000', '600000', '600000', '', owner, '1 SAMPLE PLAZA', 'MIAMI', 'FL', `${id} EXAMPLE DR`, 'MIAMI', zip,
      code, '550000', '2025', month,
    ];
    const file = 'Dade 23 Final NAL 2026.zip';
    const source = fakeSource(
      [
        buy('T1', '33139', 'SAMPLE HOMES LLC', '3'),
        buy('T2', '33141', 'SAMPLE HOMES LLC', '5'),
        buy('T3', '33141', 'SAMPLE HOMES LLC', '6', '11'), // disqualified transfer: not a purchase
        buy('T4', '33139', 'JANE SAMPLE', '4'), // an individual: never stored
        buy('T5', '33139', 'OTHER CO LLC', '7'), // one purchase: not a buyer
      ],
      { header: H, file },
    );
    const lines: string[] = [];
    const run = await runDiscovery({ sql, source, asOf: ASOF, log: (l) => lines.push(l) });
    assert.equal(hasErrors(run), false);
    assert.deepEqual(run.transactions, [{ county: '23', file, kept: 3 }]);
    assert.equal(source.reads, 1, 'one pass for ZIPs and purchases');
    const [individuals] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM property_transactions WHERE owner_name = 'JANE SAMPLE'`;
    assert.equal(individuals?.n, 0);
    const buyers = await listBuyers(sql, u, workspaceId);
    assert.deepEqual(buyers.map((b) => [b.profile.name, b.profile.purchases]), [['SAMPLE HOMES LLC', 2]]);
    assert.ok(lines.every((l) => !l.includes('SAMPLE HOMES') && !l.includes('EXAMPLE DR')), 'logs carry no names or addresses');

    const again = await runDiscovery({ sql, source, asOf: ASOF });
    assert.deepEqual(again.transactions, [], 'the same roll file is read once');
    assert.equal(source.reads, 1);
  });
});
