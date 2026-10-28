import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type PropertyTransaction, type StoredParcel, ownerKey } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  ServiceError,
  type Sql,
  claimCoverage,
  claimTransactionImport,
  completeCoverage,
  completeTransactionImport,
  createDb,
  ensureWorkspace,
  listBuyers,
  listOpportunities,
  matchesForBuyer,
  matchesForSeller,
  saveBusinessProfile,
  scoreWorkspace,
  scoreWorkspaceBuyers,
  storeParcels,
  storeTransactions,
} from '../src/index.ts';

// Synthetic parcels, companies and sales. Not real.
const FILE = 'Dade 23 Preliminary NAL 2026.zip';
const roll = { sourceFile: FILE, rollLabel: '2026 preliminary roll', fileDate: '2026-07-27' };
const parcel = (n: number, useCode = '001'): StoredParcel => ({
  parcelId: `M${n}`, countyCode: '23', assessmentYear: 2026, useCode,
  situs: { address: `${n} EXAMPLE WAY`, city: 'AVENTURA', zip: '33180' },
  owner: { name: `TEST HOLDINGS ${n} LLC`, address1: '9 SAMPLE ST', address2: '', city: 'NEW YORK', state: 'NY', zip: '10001' },
  ownerKind: 'company', justValue: 550_000, assessedValue: 300_000, homestead: false, sales: [], prior: null, units: 1, yearBuilt: 1990, livingArea: 1800,
});
const sale = (company: string, n: number, zip = '33180', useCode = '001'): PropertyTransaction => ({
  countyCode: '23', parcelId: `${company.slice(0, 3)}${n}`, rollYear: 2026, situs: { address: `${n} SAMPLE DR`, city: 'AVENTURA', zip },
  useCode, units: 1, livingArea: 1800, yearBuilt: 1990, ownerName: company, ownerKey: ownerKey(company),
  ownerMailing: { address1: '1 SAMPLE PLAZA', address2: '', city: 'MIAMI', state: 'FL', zip: '33131' },
  saleYear: 2026, saleMonth: n, price: 500_000 + n * 10_000, qualificationCode: '01',
});

describe('seller–buyer matches', () => {
  let tdb: TestDb;
  let sql: Sql;
  before(() => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 2 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  it('pairs homes with companies that bought that kind of home in that ZIP, both ways, inside one workspace', async () => {
    const id = randomUUID();
    const u = { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' as const };
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, { licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', market: 'miami-dade', focusZips: ['33180'], propertyUses: ['single_family', 'condo'] });
    await claimCoverage(sql, '23', ['33180']);
    await storeParcels(sql, roll.fileDate, [parcel(1), parcel(2, '004')]);
    await completeCoverage(sql, '23', [{ zip: '33180', parcelCount: 2 }], roll);
    await scoreWorkspace(sql, workspaceId, new Date('2026-10-13T12:00:00Z'));
    await claimTransactionImport(sql, '23', FILE, roll.fileDate);
    await storeTransactions(sql, FILE, roll.fileDate, [
      sale('ALPHA HOMES LLC', 1), sale('ALPHA HOMES LLC', 2), // houses in 33180
      sale('BETA CONDOS INC', 1, '33180', '004'), sale('BETA CONDOS INC', 2, '33180', '004'), // condos in 33180
      sale('GAMMA LLC', 1, '33139'), sale('GAMMA LLC', 2, '33139'), // houses elsewhere
    ]);
    await completeTransactionImport(sql, '23', FILE, { rowsRead: 6, rowsKept: 6, minSaleYear: 2025 });
    await scoreWorkspaceBuyers(sql, workspaceId);

    const sellers = await listOpportunities(sql, u, workspaceId);
    const house = sellers.find((s) => s.parcelId === 'M1');
    const condo = sellers.find((s) => s.parcelId === 'M2');
    assert.ok(house && condo, 'both homes are opportunities');
    assert.deepEqual((await matchesForSeller(sql, u, workspaceId, house.id)).map((m) => m.name), ['ALPHA HOMES LLC']);
    assert.deepEqual((await matchesForSeller(sql, u, workspaceId, condo.id)).map((m) => m.name), ['BETA CONDOS INC']);

    const alpha = (await listBuyers(sql, u, workspaceId)).find((b) => b.profile.name === 'ALPHA HOMES LLC')!;
    const forAlpha = await matchesForBuyer(sql, u, workspaceId, alpha.id);
    assert.deepEqual(forAlpha.map((m) => m.address), ['1 EXAMPLE WAY']);
    assert.ok(forAlpha[0]!.reasons.some((r) => r.code === 'zip'));

    const otherId = randomUUID();
    const other = { userId: otherId, email: `${otherId.slice(0, 8)}@example.com`, via: 'web' as const };
    const theirs = await ensureWorkspace(sql, other);
    await assert.rejects(matchesForSeller(sql, other, workspaceId, house.id), (e) => e instanceof ServiceError && e.code === 'forbidden');
    await assert.rejects(matchesForSeller(sql, other, theirs.workspaceId, house.id), (e) => e instanceof ServiceError && e.code === 'not_found');
  });
});
