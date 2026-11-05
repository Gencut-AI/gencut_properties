import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type PropertyTransaction, type StoredParcel, ownerKey } from '@gencut/core';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  MARKET_MONTHS,
  type RequestContext,
  type Sql,
  claimCoverage,
  claimTransactionImport,
  completeCoverage,
  completeTransactionImport,
  createDb,
  createLeadPage,
  ensureWorkspace,
  getAgentDashboard,
  saveBusinessProfile,
  scoreWorkspace,
  scoreWorkspaceBuyers,
  storeParcels,
  storeTransactions,
  submitInboundLead,
} from '../src/index.ts';

// Synthetic agents, parcels, companies and sales. Not real.
const ASOF = new Date('2026-10-13T12:00:00Z');
const roll = { sourceFile: 'Dade 23 Preliminary NAL 2026.zip', rollLabel: '2026 preliminary roll', fileDate: '2026-07-27' };

function parcel(zip: string, k: number): StoredParcel {
  const n = Number(`${zip}${k}`);
  return {
    parcelId: `DB${n}`, countyCode: '23', assessmentYear: 2026, useCode: '001',
    situs: { address: `${n} EXAMPLE WAY`, city: 'AVENTURA', zip },
    owner: { name: `TEST HOLDINGS ${n} LLC`, address1: '9 SAMPLE ST', address2: '', city: 'NEW YORK', state: 'NY', zip: '10001' },
    ownerKind: 'company', justValue: 1_000_000, assessedValue: 500_000, homestead: false, sales: [], prior: null, units: 1, yearBuilt: 1957, livingArea: 2088,
  };
}

function sale(company: string, zip: string, month: number, over: Partial<PropertyTransaction> = {}): PropertyTransaction {
  return {
    countyCode: '23', parcelId: `${ownerKey(company).slice(0, 5)}${zip}${month}${over.price ?? ''}`, rollYear: 2026,
    situs: { address: `${month} SAMPLE DR`, city: 'AVENTURA', zip }, useCode: '001', units: 1, livingArea: 1800, yearBuilt: 1990,
    ownerName: company, ownerKey: ownerKey(company),
    ownerMailing: { address1: '1 SAMPLE PLAZA', address2: '', city: 'MIAMI', state: 'FL', zip: '33131' },
    saleYear: 2026, saleMonth: month, price: 500_000 + month * 10_000, qualificationCode: '01', ...over,
  };
}

describe('Agent dashboard', () => {
  let tdb: TestDb;
  let sql: Sql;
  before(async () => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 4 });
    // Company purchases: an active buyer in the first agent's ZIP, older buying in another, and a busy ZIP elsewhere.
    const purchases = [
      sale('ALPHA HOMES LLC', '33501', 6),
      sale('ALPHA HOMES LLC', '33501', 7),
      sale('ALPHA HOMES LLC', '33501', 8),
      sale('BETA HOLDINGS INC', '33502', 1),
      sale('BETA HOLDINGS INC', '33502', 2),
      ...[1, 2, 3, 4, 5].map((m) => sale(`GAMMA ${m} LLC`, '33999', m)),
      // A multi-parcel deed: counted as purchases, left out of the median price.
      sale('DELTA LLC', '33501', 5, { price: 9_000_000, qualificationCode: '05' }),
    ];
    await claimTransactionImport(sql, '23', 'roll.zip', '2026-10-28');
    await storeTransactions(sql, 'roll.zip', '2026-10-28', purchases);
    await completeTransactionImport(sql, '23', 'roll.zip', { rowsRead: 100, rowsKept: purchases.length, minSaleYear: 2025 });
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
    await scoreWorkspaceBuyers(sql, workspaceId);
    return { u, workspaceId };
  }

  it('shows an agent their own pipeline and what to do next, and nothing of another agent', async () => {
    const a = await agent('33501');
    const b = await agent('33502');
    const [review] = await sql<{ id: string }[]>`
      INSERT INTO campaigns (workspace_id, title, objective, status, created_by) VALUES (${a.workspaceId}, 'Letter', 'Introduce', 'review', ${a.u.userId}) RETURNING id
    `;
    const page = await createLeadPage(sql, a.u, a.workspaceId);
    const lead = await submitInboundLead(sql, page.slug, { name: 'Sam Sample', email: 'sam@example.com', phone: '', interest: 'selling', zip: '33501', message: '', consent: true }, { source: 'instagram', submitter: 'x'.repeat(64) });
    assert.equal(lead.ok, true);

    const da = await getAgentDashboard(sql, a.u, a.workspaceId);
    assert.deepEqual(da.zips, ['33501']);
    assert.equal(da.rollDate, '2026-10-28');
    assert.equal(da.counts.sellerLeads, 2);
    assert.equal(da.counts.campaigns, 1);
    assert.equal(da.counts.campaignsInReview, 1);
    assert.deepEqual([da.counts.socialLeads, da.counts.newSocialLeads], [1, 1]);
    assert.ok(da.counts.buyers >= 2);
    assert.equal(da.counts.activeBuyers, 1, 'Alpha bought Jun, Jul and Aug 2026');
    assert.equal(da.hasLeadPage, true);
    assert.equal(da.whatsappLinked, false);
    assert.deepEqual(da.actions.map((x) => x.kind), ['review_letters', 'social_leads', 'top_seller', 'top_active_buyer'], 'most useful first, four at most');
    assert.equal(da.actions[0]?.href, `/campaigns/${review?.id}`, 'one letter waiting: straight to it');
    assert.match(da.actions[2]?.subject ?? '', /^33501\d EXAMPLE WAY$/);
    assert.equal(da.actions[3]?.subject, 'ALPHA HOMES LLC');

    const db = await getAgentDashboard(sql, b.u, b.workspaceId);
    assert.equal(db.counts.campaigns, 0);
    assert.equal(db.counts.socialLeads, 0);
    assert.equal(db.counts.sellerLeads, 2, 'its own two parcels');
    // Buyers are ranked county-wide for every agent, so the active buyer is offered here too; no lead page, WhatsApp not linked.
    assert.deepEqual(db.actions.map((x) => x.kind), ['top_seller', 'top_active_buyer', 'lead_page', 'link_whatsapp']);

    await sql`INSERT INTO whatsapp_links (user_id, wa_id) VALUES (${b.u.userId}, '13055550199')`;
    assert.equal((await getAgentDashboard(sql, b.u, b.workspaceId)).whatsappLinked, true);

    const stranger: RequestContext = { userId: randomUUID(), email: 'x@example.com', via: 'web' };
    await assert.rejects(() => getAgentDashboard(sql, stranger, a.workspaceId), 'only members see a dashboard');
  });

  it('charts company buying in the agent’s ZIP codes and ranks the county’s busiest ZIP codes', async () => {
    const a = await agent('33501');
    const { market } = await getAgentDashboard(sql, a.u, a.workspaceId);
    assert.equal(market.months.length, MARKET_MONTHS);
    assert.equal(market.months.at(-1)?.month, '2026-08', 'ends at the newest sale on record');
    assert.equal(market.months.at(0)?.month, '2025-03');
    const byMonth = Object.fromEntries(market.months.map((m) => [m.month, m.purchases]));
    assert.deepEqual([byMonth['2026-05'], byMonth['2026-06'], byMonth['2026-07'], byMonth['2026-08'], byMonth['2026-04']], [1, 1, 1, 1, 0]);
    // Roll of Oct 2026: July to October are still filling in.
    assert.deepEqual(market.months.filter((m) => m.filling).map((m) => m.month), ['2026-07', '2026-08']);
    assert.deepEqual(market.lastYear, { purchases: 4, companies: 2, medianPrice: 570_000 }, 'the multi-parcel deed is a purchase but not a price');
    assert.deepEqual(
      market.zips.map((z) => [z.zip, z.purchases, z.yours]),
      [['33999', 5, false], ['33501', 4, true], ['33502', 2, false]],
    );
  });
});
