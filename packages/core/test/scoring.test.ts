import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentFocus,
  type ParcelFacts,
  SCORING_VERSION,
  matchesPropertyFocus,
  scoreSellerOpportunity,
} from '../src/index.ts';

// Synthetic parcels for tests; not real people or properties.
const AS_OF = new Date('2026-10-13T12:00:00Z');

const focus: AgentFocus = {
  zips: ['33180', '33160'],
  propertyUses: ['single_family', 'condo'],
  minValue: 500_000,
  maxValue: 5_000_000,
};

const ownerOccupied: ParcelFacts = {
  parcelId: 'TEST-0001',
  countyCode: '23',
  situsAddress: '100 Example Way',
  situsCity: 'Aventura',
  situsZip: '33180',
  ownerName: 'TEST OWNER A',
  ownerMailingAddress: '100 EXAMPLE WAY',
  ownerMailingState: 'FL',
  homestead: true,
  propertyUse: 'single_family',
  justValue: 1_200_000,
  assessedValue: 1_150_000,
};

const absenteeLongHeld: ParcelFacts = {
  ...ownerOccupied,
  parcelId: 'TEST-0002',
  ownerName: 'TEST HOLDINGS LLC',
  ownerMailingAddress: '500 Sample Ave',
  ownerMailingCity: 'New York',
  ownerMailingState: 'NY',
  homestead: false,
  justValue: 2_000_000,
  assessedValue: 1_100_000,
};

function eligible(p: ParcelFacts) {
  const r = scoreSellerOpportunity(p, focus, AS_OF);
  assert.equal(r.eligible, true, r.eligible ? '' : r.why);
  if (!r.eligible) throw new Error('unreachable');
  return r;
}

describe('seller opportunity scoring v2', () => {
  it('scores an absentee, out-of-state, long-held parcel well above an owner-occupied one', () => {
    const high = eligible(absenteeLongHeld);
    const low = eligible(ownerOccupied);
    assert.deepEqual(
      high.reasons.map((r) => r.code),
      ['in_focus', 'absentee_owner', 'out_of_state_owner', 'long_held_strong', 'value_in_band'],
    );
    assert.equal(high.score, 95); // 20+25+10+30+10
    assert.equal(low.score, 30); // in_focus 20 + value_in_band 10
  });

  it('reads tenure from the assessed-to-market gap, with the right cap for homesteads', () => {
    const homesteadDeep = eligible({ ...ownerOccupied, justValue: 1_000_000, assessedValue: 450_000 });
    assert.ok(homesteadDeep.reasons.some((r) => r.code === 'long_held_strong' && r.text.includes('45%')));
    const homesteadMid = eligible({ ...ownerOccupied, justValue: 1_000_000, assessedValue: 700_000 });
    assert.ok(homesteadMid.reasons.some((r) => r.code === 'long_held'));
    // 70% is strong for non-homestead (10% cap) but only mid for homestead (3% cap)
    const nonHomestead = eligible({ ...absenteeLongHeld, justValue: 1_000_000, assessedValue: 550_000 });
    assert.ok(nonHomestead.reasons.some((r) => r.code === 'long_held_strong' && r.text.includes('10% cap')));
    const noGap = eligible({ ...ownerOccupied, assessedValue: 1_200_000 });
    assert.ok(!noGap.reasons.some((r) => r.code.startsWith('long_held')));
  });

  it('penalises a recent qualified or priced sale but ignores nominal transfers', () => {
    const sold = eligible({ ...absenteeLongHeld, recentSale: { year: 2026, month: 3, price: 1_900_000, qualified: true } });
    const reason = sold.reasons.find((r) => r.code === 'recent_purchase');
    assert.equal(reason?.text, 'Sold in March 2026; a sale is unlikely soon.');
    const nominal = eligible({ ...absenteeLongHeld, recentSale: { year: 2026, month: 3, price: 100, qualified: false } });
    assert.ok(!nominal.reasons.some((r) => r.code === 'recent_purchase'));
    const old = eligible({ ...absenteeLongHeld, recentSale: { year: 2023, month: 1, price: 900_000, qualified: true } });
    assert.ok(!old.reasons.some((r) => r.code === 'recent_purchase'));
  });

  it('notes estates of record', () => {
    const r = eligible({ ...ownerOccupied, ownerName: 'ESTATE OF TEST OWNER' });
    assert.ok(r.reasons.some((x) => x.code === 'estate_owner'));
    assert.ok(!eligible({ ...ownerOccupied, ownerName: 'REAL ESTATE HOLDINGS LLC' }).reasons.some((x) => x.code === 'estate_owner'));
  });

  it('clamps to 0–100', () => {
    const r = eligible({
      ...ownerOccupied,
      justValue: 9_000_000,
      assessedValue: 9_000_000,
      recentSale: { year: 2026, month: 1, price: 8_000_000, qualified: true },
    });
    assert.equal(r.score, 0);
  });

  it('excludes confidential or nameless owners, other ZIPs and other property types', () => {
    for (const p of [
      { ...absenteeLongHeld, confidential: true },
      { ...absenteeLongHeld, ownerName: ' ' },
      { ...absenteeLongHeld, situsZip: '33101' },
      { ...absenteeLongHeld, propertyUse: 'vacant_land' as const },
    ]) {
      assert.equal(scoreSellerOpportunity(p, focus, AS_OF).eligible, false);
    }
  });

  it('matches townhouse focus to single-family parcels (the roll does not separate them)', () => {
    assert.equal(matchesPropertyFocus('single_family', ['townhouse']), true);
    assert.equal(matchesPropertyFocus('condo', ['townhouse']), false);
  });

  it('cites the fact fields behind every reason, is deterministic and versioned', () => {
    const r = eligible(absenteeLongHeld);
    for (const reason of r.reasons) assert.ok(reason.facts.length > 0 && reason.text.length > 0);
    assert.deepEqual(eligible(absenteeLongHeld), r);
    assert.equal(r.version, SCORING_VERSION);
    assert.equal(r.confidence, 1);
    const { justValue: _a, assessedValue: _b, ...sparse } = absenteeLongHeld;
    assert.equal(eligible(sparse).confidence, 0.33);
  });
});
