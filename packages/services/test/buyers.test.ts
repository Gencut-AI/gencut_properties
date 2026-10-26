import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type PropertyTransaction, buyerProfile, ownerKey } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  type RequestContext,
  ServiceError,
  type Sql,
  claimTransactionImport,
  completeTransactionImport,
  countBuyers,
  countOpportunities,
  createDb,
  ensureWorkspace,
  getBuyer,
  getBuyerDiscoveryStatus,
  listBuyers,
  outcomeReport,
  parseBuyerFilters,
  recordOutcome,
  saveBusinessProfile,
  scoreWorkspaceBuyers,
  setOpportunityStatus,
  storeTransactions,
  transactionImportDue,
  workspacesToScoreBuyers,
} from '../src/index.ts';

// Synthetic companies and sales. Not real owners, parcels or prices.
const FILE = 'Dade 23 Preliminary NAL 2026.zip';
const FILE_DATE = '2026-07-27';

function sale(company: string, n: number, over: Partial<PropertyTransaction> = {}): PropertyTransaction {
  return {
    countyCode: '23', parcelId: `${company.slice(0, 4).toUpperCase()}${n}`, rollYear: 2026,
    situs: { address: `${n} EXAMPLE DR`, city: 'AVENTURA', zip: '33180' }, useCode: '001', units: 1, livingArea: 1800, yearBuilt: 1990,
    ownerName: company, ownerKey: ownerKey(company),
    ownerMailing: { address1: '1 SAMPLE PLAZA', address2: '', city: 'MIAMI', state: 'FL', zip: '33131' },
    saleYear: 2025, saleMonth: n, price: 500_000 + n * 10_000, qualificationCode: '01', ...over,
  };
}

const PURCHASES: PropertyTransaction[] = [
  // Four purchases, recent, in the agent's ZIP: the top buyer.
  ...[1, 2, 3].map((n) => sale('ALPHA HOMES LLC', n, { saleYear: 2026 })),
  sale('Alpha Homes, L.L.C.', 4, { saleYear: 2026 }),
  // Two purchases elsewhere, condos, older.
  sale('BETA HOLDINGS INC', 1, { situs: { address: '9 SAMPLE ST', city: 'MIAMI', zip: '33131' }, useCode: '004' }),
  sale('BETA HOLDINGS INC', 2, { situs: { address: '10 SAMPLE ST', city: 'MIAMI', zip: '33131' }, useCode: '004' }),
  // One purchase only: not a buyer.
  sale('GAMMA LLC', 5),
];

function user(): RequestContext {
  const id = randomUUID();
  return { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
}

describe('Buyer Radar services', () => {
  let tdb: TestDb;
  let sql: Sql;
  before(async () => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 4 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  async function workspace(zips = ['33180']) {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, {
      licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', market: 'miami-dade', focusZips: zips,
      propertyUses: ['single_family'], minValue: 400_000, maxValue: 900_000,
    });
    return { u, workspaceId };
  }

  it('imports a roll file once, and waits for it before scoring buyers', async () => {
    const { workspaceId } = await workspace();
    assert.ok(!(await workspacesToScoreBuyers(sql)).includes(workspaceId), 'nothing to score before an import');
    assert.equal(await transactionImportDue(sql, '23', FILE), true);
    await claimTransactionImport(sql, '23', FILE, FILE_DATE);
    assert.equal(await transactionImportDue(sql, '23', FILE), false, 'claimed');
    assert.equal(await storeTransactions(sql, FILE, FILE_DATE, PURCHASES), PURCHASES.length);
    assert.equal(await storeTransactions(sql, FILE, FILE_DATE, PURCHASES), PURCHASES.length, 'reading again updates in place');
    await completeTransactionImport(sql, '23', FILE, { rowsRead: 100, rowsKept: PURCHASES.length, minSaleYear: 2025 });
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM property_transactions`;
    assert.equal(n?.n, PURCHASES.length);
    assert.equal(await transactionImportDue(sql, '23', FILE), false);
    assert.ok((await workspacesToScoreBuyers(sql)).includes(workspaceId));
  });

  it('ranks companies with 2+ purchases, cites each purchase, and keeps sellers separate', async () => {
    const { u, workspaceId } = await workspace();
    assert.deepEqual(await scoreWorkspaceBuyers(sql, workspaceId), { eligible: 2, kept: 2 });
    const buyers = await listBuyers(sql, u, workspaceId);
    assert.deepEqual(buyers.map((b) => b.profile.name), ['Alpha Homes, L.L.C.', 'BETA HOLDINGS INC']);
    const alpha = buyers[0]!;
    assert.equal(alpha.profile.purchases, 4, 'spellings of one company are grouped');
    assert.equal(alpha.scoringVersion, 'buyer-v1');
    assert.equal(alpha.rollFileDate, FILE_DATE);
    // 4 purchases 40, latest Apr 2026 within 6 months of Jul 2026 20, all in focus 15 + 10, single-family 10, price 5.
    assert.equal(alpha.score, 100);
    assert.deepEqual(await countOpportunities(sql, u, workspaceId), { active: 0, saved: 0, dismissed: 0 }, 'seller counts exclude buyers');
    assert.equal((await countBuyers(sql, u, workspaceId)).active, 2);

    const detail = await getBuyer(sql, u, workspaceId, alpha.id);
    assert.equal(detail.purchases.length, 4);
    assert.equal(detail.missingPurchases, 0);
    assert.equal(detail.purchases[0]?.sourceFile, FILE);
    // Every number on the profile recomputes from the cited purchases.
    const recomputed = buyerProfile(detail.purchases.map((p) => sale(p.ownerNameOnRoll, 0, {
      parcelId: p.parcelId, situs: { address: p.address, city: p.city, zip: p.zip }, useCode: p.useCode, saleYear: p.saleYear,
      saleMonth: p.saleMonth, price: p.price,
    })));
    assert.deepEqual(
      { purchases: recomputed.purchases, zips: recomputed.zips, price: recomputed.price, latest: recomputed.latest },
      { purchases: alpha.profile.purchases, zips: alpha.profile.zips, price: alpha.profile.price, latest: alpha.profile.latest },
    );
    const status = await getBuyerDiscoveryStatus(sql, u, workspaceId);
    assert.deepEqual([status.status, status.kept, status.importedFile], ['ready', 2, FILE]);
  });

  it('filters by ZIP, home type and purchase count', async () => {
    const { u, workspaceId } = await workspace();
    await scoreWorkspaceBuyers(sql, workspaceId);
    const names = async (q: Record<string, string>) => (await listBuyers(sql, u, workspaceId, { filters: parseBuyerFilters(q) })).map((b) => b.profile.name);
    assert.deepEqual(await names({ zip: '33131' }), ['BETA HOLDINGS INC']);
    assert.deepEqual(await names({ type: 'condo' }), ['BETA HOLDINGS INC']);
    assert.deepEqual(await names({ min: '3' }), ['Alpha Homes, L.L.C.']);
    assert.deepEqual(parseBuyerFilters({ zip: 'x', type: 'castle', min: '1' }), {}, 'invalid filters are ignored');
  });

  it('keeps triage and outcomes through re-scoring, and reports buyers apart from sellers', async () => {
    const { u, workspaceId } = await workspace();
    await scoreWorkspaceBuyers(sql, workspaceId);
    const [alpha] = await listBuyers(sql, u, workspaceId);
    assert.ok(alpha);
    await setOpportunityStatus(sql, u, workspaceId, alpha.id, 'saved');
    await recordOutcome(sql, u, workspaceId, alpha.id, { outcome: 'qualified_conversation', occurredOn: '2026-10-20' });
    await scoreWorkspaceBuyers(sql, workspaceId);
    const again = (await listBuyers(sql, u, workspaceId, { view: 'saved' }))[0];
    assert.equal(again?.id, alpha.id, 'same buyer, still saved');
    const buyersReport = await outcomeReport(sql, u, workspaceId, 'investor_buyer');
    assert.equal(buyersReport.opportunities, 1);
    assert.deepEqual(buyersReport.scoringVersions, ['buyer-v1']);
    assert.equal(buyersReport.bands[0]?.replied, 1);
    assert.equal((await outcomeReport(sql, u, workspaceId)).opportunities, 0, 'seller report excludes buyers');
  });

  it('keeps workspaces apart', async () => {
    const a = await workspace();
    await scoreWorkspaceBuyers(sql, a.workspaceId);
    const [buyer] = await listBuyers(sql, a.u, a.workspaceId);
    const b = await workspace();
    await assert.rejects(getBuyer(sql, b.u, a.workspaceId, buyer!.id), (e) => e instanceof ServiceError && e.code === 'forbidden');
    await assert.rejects(getBuyer(sql, b.u, b.workspaceId, buyer!.id), (e) => e instanceof ServiceError && e.code === 'not_found');
  });

  it('drops purchases that fall out of the sale window when a newer roll is imported', async () => {
    const next = 'Dade 23 Preliminary NAL 2027.zip';
    await claimTransactionImport(sql, '23', next, '2027-07-27');
    await completeTransactionImport(sql, '23', next, { rowsRead: 1, rowsKept: 0, minSaleYear: 2026 });
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM property_transactions WHERE sale_year < 2026`;
    assert.equal(n?.n, 0);
  });
});
