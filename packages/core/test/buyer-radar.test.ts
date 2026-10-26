import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentFocus,
  BUYER_SCORING_VERSION,
  type PropertyTransaction,
  buyerProfile,
  headerIndex,
  monthLabel,
  nalRowToTransaction,
  ownerKey,
  scoreBuyer,
} from '../src/index.ts';

// Synthetic rows and companies in the DOR NAL layout. Not real parcels, owners or sales.
const HEADER = [
  'CO_NO', 'PARCEL_ID', 'ASMNT_YR', 'DOR_UC', 'JV', 'AV_SD', 'AV_NSD', 'JV_HMSTD', 'NO_RES_UNTS', 'ACT_YR_BLT',
  'TOT_LVG_AREA', 'QUAL_CD1', 'SALE_PRC1', 'SALE_YR1', 'SALE_MO1', 'QUAL_CD2', 'SALE_PRC2', 'SALE_YR2', 'SALE_MO2',
  'EXMPT_20', 'OWN_NAME', 'OWN_ADDR1', 'OWN_ADDR2', 'OWN_CITY', 'OWN_STATE', 'OWN_ZIPCD', 'PHY_ADDR1', 'PHY_CITY', 'PHY_ZIPCD',
];
const idx = headerIndex(HEADER);
const row = (v: Record<string, string>) => HEADER.map((h) => v[h] ?? '');
const base = {
  CO_NO: '23', PARCEL_ID: '0000000000001', ASMNT_YR: '2026', DOR_UC: '001', JV: '700000', AV_SD: '700000', AV_NSD: '700000',
  NO_RES_UNTS: '1', ACT_YR_BLT: '1990', TOT_LVG_AREA: '1800', QUAL_CD1: '01', SALE_PRC1: '650000', SALE_YR1: '2025', SALE_MO1: '3',
  OWN_NAME: 'SAMPLE HOMES L.L.C.', OWN_ADDR1: '1 SAMPLE PLAZA', OWN_CITY: 'MIAMI', OWN_STATE: 'FL', OWN_ZIPCD: '33131',
  PHY_ADDR1: '200 EXAMPLE DR', PHY_CITY: 'AVENTURA', PHY_ZIPCD: '33180',
};

const tx = (n: number, over: Partial<PropertyTransaction> = {}): PropertyTransaction => ({
  countyCode: '23', parcelId: `P${n}`, rollYear: 2026, situs: { address: `${n} EXAMPLE DR`, city: 'AVENTURA', zip: '33180' },
  useCode: '001', units: 1, livingArea: 1800, yearBuilt: 1990, ownerName: 'SAMPLE HOMES LLC', ownerKey: 'SAMPLEHOMESLLC',
  ownerMailing: { address1: '1 SAMPLE PLAZA', address2: '', city: 'MIAMI', state: 'FL', zip: '33131' },
  saleYear: 2025, saleMonth: n, price: 500_000 + n * 10_000, qualificationCode: '01', ...over,
});
const focus: AgentFocus = { zips: ['33180'], propertyUses: ['single_family'], minValue: 400_000, maxValue: 900_000 };

describe('Buyer Radar: verified purchases from the roll', () => {
  it('keeps a qualified 2025–2026 purchase whose owner of record is a company', () => {
    const t = nalRowToTransaction(row(base), idx);
    assert.ok(t);
    assert.equal(t.ownerKey, 'SAMPLEHOMESLLC');
    assert.deepEqual([t.saleYear, t.saleMonth, t.price, t.qualificationCode], [2025, 3, 650_000, '01']);
    assert.equal(t.situs.zip, '33180');
  });

  it('never keeps purchases by individuals, trusts or estates', () => {
    for (const name of ['JANE SAMPLE', 'SAMPLE FAMILY TRUST', 'ESTATE OF JOHN SAMPLE']) {
      assert.equal(nalRowToTransaction(row({ ...base, OWN_NAME: name }), idx), null, name);
    }
  });

  it('drops unqualified, nominal, old or future-dated sales, and institutional or non-residential parcels', () => {
    assert.equal(nalRowToTransaction(row({ ...base, QUAL_CD1: '11' }), idx), null, 'disqualified transfer');
    assert.equal(nalRowToTransaction(row({ ...base, SALE_PRC1: '100' }), idx), null, 'nominal price');
    assert.equal(nalRowToTransaction(row({ ...base, SALE_YR1: '2023' }), idx), null, 'outside the roll window');
    assert.equal(nalRowToTransaction(row({ ...base, SALE_YR1: '2027' }), idx), null, 'after the roll year');
    assert.equal(nalRowToTransaction(row({ ...base, EXMPT_20: '5000' }), idx), null, 'institutional exemption');
    assert.equal(nalRowToTransaction(row({ ...base, DOR_UC: '011' }), idx), null, 'commercial');
    assert.equal(nalRowToTransaction(row({ ...base, SALE_YR1: '' }), idx), null, 'no sale');
  });

  it('groups spellings of the same company name, never different companies', () => {
    assert.equal(ownerKey('Sample Homes, L.L.C.'), 'SAMPLEHOMESLLC');
    assert.equal(ownerKey('SAMPLE HOMES LIMITED LIABILITY COMPANY'), 'SAMPLEHOMESLLC');
    assert.equal(ownerKey('A & B PROPERTIES INCORPORATED'), 'AANDBPROPERTIESINC');
    assert.equal(ownerKey('D R SAMPLE INC'), ownerKey('DR SAMPLE INC'), 'the roll spaces initials either way');
    assert.notEqual(ownerKey('SAMPLE HOMES LLC'), ownerKey('SAMPLE HOMES II LLC'));
  });
});

describe('Buyer Radar: profiles and score', () => {
  it('derives every profile number from the purchases and nothing else', () => {
    const p = buyerProfile([tx(3), tx(1, { situs: { address: '1 X', city: 'MIAMI', zip: '33160' }, useCode: '004' }), tx(7)]);
    assert.equal(p.purchases, 3);
    assert.deepEqual(p.first, { year: 2025, month: 1 });
    assert.deepEqual(p.latest, { year: 2025, month: 7 });
    assert.deepEqual(p.zips, [{ zip: '33180', count: 2 }, { zip: '33160', count: 1 }]);
    assert.deepEqual(p.homeTypes.map((t) => [t.label, t.count]), [['Single family', 2], ['Condominium', 1]]);
    assert.deepEqual(p.price, { min: 510_000, median: 530_000, max: 570_000 });
    assert.equal(buyerProfile([tx(2), tx(4)]).price?.median, 530_000, 'median of an even count');
  });

  it('counts a multi-parcel sale as one purchase, with its price as the total and never a price per home', () => {
    // One deed of three lots (code 05: the full price on each parcel), plus one single-parcel purchase.
    const lots = [1, 2, 3].map((n) => tx(n + 10, { parcelId: `L${n}`, saleMonth: 6, price: 3_000_000, qualificationCode: '05', useCode: '000' }));
    const p = buyerProfile([...lots, tx(2)]);
    assert.deepEqual([p.purchases, p.parcels, p.multiParcelPurchases], [2, 4, 1]);
    assert.deepEqual(p.price, { min: 520_000, median: 520_000, max: 520_000 }, 'prices of single-parcel purchases only');
    assert.deepEqual(p.zips, [{ zip: '33180', count: 2 }], 'ZIP counts are per purchase');
    assert.equal(buyerProfile(lots).purchases, 1);
    assert.equal(buyerProfile(lots).price, null);
    assert.equal(scoreBuyer(buyerProfile(lots), focus, '2026-07-27').eligible, false, 'one bulk deed is one purchase, not a repeat buyer');
    const s = scoreBuyer(p, focus, '2026-07-27');
    assert.ok(s.eligible);
    assert.match(s.reasons[0]?.text ?? '', /^2 qualified purchases on the county roll \(4 parcels, 1 of them multi-parcel sales\)/);
  });

  it('needs two purchases, and ranks volume, recency and fit with the agent, each with a reason', () => {
    const one = scoreBuyer(buyerProfile([tx(1)]), focus, '2026-07-27');
    assert.equal(one.eligible, false);

    const s = scoreBuyer(buyerProfile([tx(1), tx(2)]), focus, '2026-07-27');
    assert.ok(s.eligible);
    assert.equal(s.version, BUYER_SCORING_VERSION);
    // 2 purchases 30, latest Feb 2025 is 17 months before Jul 2026 (no recency), focus ZIP 15 + mostly 10, type 10, price 5.
    assert.deepEqual(s.reasons.map((r) => [r.code, r.points]), [['purchases', 30], ['focus_zip', 15], ['mostly_focus_zip', 10], ['focus_type', 10], ['focus_price', 5]]);
    assert.equal(s.score, 70);

    const busy = scoreBuyer(buyerProfile([1, 2, 3, 4, 5].map((n) => tx(n, { saleYear: 2026 }))), { zips: ['33101'], propertyUses: ['condo'] }, '2026-07-27');
    assert.ok(busy.eligible);
    assert.deepEqual(busy.reasons.map((r) => [r.code, r.points]), [['purchases', 50], ['recent', 20]]);
    assert.match(busy.reasons[0]?.text ?? '', /5 qualified purchases on the county roll, Jan 2026 to May 2026/);
  });

  it('says nothing about intent: reasons describe past purchases and fit only', () => {
    const s = scoreBuyer(buyerProfile([tx(5), tx(6)]), focus, '2026-07-27');
    assert.ok(s.eligible);
    const text = s.reasons.map((r) => r.text).join(' ').toLowerCase();
    for (const claim of ['buying now', 'actively', 'looking to buy', 'in the market', 'will buy', 'likely to buy']) assert.ok(!text.includes(claim), claim);
  });

  it('labels months for people', () => {
    assert.equal(monthLabel(2025, 3), 'Mar 2025');
    assert.equal(monthLabel(2025, null), '2025');
  });
});
