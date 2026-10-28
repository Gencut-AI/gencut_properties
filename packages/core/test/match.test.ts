import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MATCH_VERSION, type PropertyTransaction, buyerProfile, matchBuyerToHome } from '../src/index.ts';

// Synthetic company and purchases. Not real.
const tx = (n: number, over: Partial<PropertyTransaction> = {}): PropertyTransaction => ({
  countyCode: '23', parcelId: `P${n}`, rollYear: 2026, situs: { address: `${n} EXAMPLE DR`, city: 'AVENTURA', zip: '33180' },
  useCode: '001', units: 1, livingArea: 1800, yearBuilt: 1990, ownerName: 'SAMPLE HOMES LLC', ownerKey: 'SAMPLEHOMESLLC',
  ownerMailing: { address1: '1 SAMPLE PLAZA', address2: '', city: 'MIAMI', state: 'FL', zip: '33131' },
  saleYear: 2026, saleMonth: n, price: 500_000 + n * 10_000, qualificationCode: '01', ...over,
});
const buyer = buyerProfile([tx(1), tx(2), tx(3, { situs: { address: '9 SAMPLE ST', city: 'MIAMI', zip: '33160' } })]);

describe('Seller–buyer matching', () => {
  it('matches a home in a ZIP the company bought in, of a kind it buys, with every reason', () => {
    const m = matchBuyerToHome({ zip: '33180', useCode: '001', marketValue: 520_000 }, buyer, '2026-07-27');
    assert.ok(m);
    assert.equal(m.version, MATCH_VERSION);
    assert.deepEqual(m.reasons.map((r) => [r.code, r.points]), [['zip', 50], ['type', 25], ['price', 15], ['recent', 10]]);
    assert.equal(m.score, 100);
    assert.match(m.reasons[2]?.text ?? '', /market value on the roll is \$520,000/);
  });

  it('needs both the ZIP and the kind of home', () => {
    assert.equal(matchBuyerToHome({ zip: '33139', useCode: '001', marketValue: 520_000 }, buyer, '2026-07-27'), null, 'never bought there');
    assert.equal(matchBuyerToHome({ zip: '33180', useCode: '004', marketValue: 520_000 }, buyer, '2026-07-27'), null, 'never bought a condo');
  });

  it('leaves out price and recency when they do not fit, and never claims intent', () => {
    const m = matchBuyerToHome({ zip: '33160', useCode: '001', marketValue: 2_000_000 }, buyer, '2028-01-27');
    assert.deepEqual(m?.reasons.map((r) => r.code), ['zip', 'type']);
    assert.equal(m?.score, 65);
    for (const r of m?.reasons ?? []) assert.doesNotMatch(r.text, /buying now|looking to buy|in the market|wants/i);
  });
});
