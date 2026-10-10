import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AgentFocus, type ParcelFacts, SCORING_VERSION, scoreSellerOpportunity } from '../src/index.ts';

const AS_OF = new Date('2026-10-10T12:00:00Z');

const focus: AgentFocus = {
  zips: ['33139', '33140'],
  propertyUses: ['single_family', 'condo'],
  minValue: 500_000,
  maxValue: 5_000_000,
};

const ownerOccupied: ParcelFacts = {
  parcelId: '02-3234-001-0010',
  countyCode: '23',
  situsAddress: '12 Palm Way, Miami Beach, FL',
  situsZip: '33139',
  ownerMailingAddress: '12 PALM WAY MIAMI BEACH FL',
  ownerMailingState: 'FL',
  ownerMailingZip: '33139',
  homesteadExemption: true,
  propertyUse: 'single_family',
  justValue: 1_200_000,
  lastSaleDate: '2019-06-01',
  lastSalePrice: 900_000,
};

const absenteeLongHeld: ParcelFacts = {
  ...ownerOccupied,
  parcelId: '02-3234-001-0020',
  ownerMailingAddress: '500 Park Ave, New York, NY',
  ownerMailingState: 'NY',
  ownerMailingZip: '10022',
  homesteadExemption: false,
  lastSaleDate: '2003-03-15',
  lastSalePrice: 400_000,
  justValue: 2_100_000,
};

function eligible(p: ParcelFacts) {
  const r = scoreSellerOpportunity(p, focus, AS_OF);
  assert.equal(r.eligible, true);
  if (!r.eligible) throw new Error('unreachable');
  return r;
}

describe('seller opportunity scoring v1', () => {
  it('scores a long-held absentee property well above an owner-occupied one', () => {
    const high = eligible(absenteeLongHeld);
    const low = eligible(ownerOccupied);
    assert.ok(high.score > low.score + 40, `${high.score} vs ${low.score}`);
    assert.deepEqual(
      high.reasons.map((r) => r.code),
      ['in_focus', 'absentee_owner', 'out_of_state_owner', 'very_long_tenure', 'value_growth', 'value_in_band'],
    );
    assert.equal(high.score, 100); // 20+25+10+30+15+10 = 110, capped
    assert.equal(low.score, 30); // in_focus 20 + value_in_band 10
  });

  it('cites the fact fields behind every reason', () => {
    for (const r of eligible(absenteeLongHeld).reasons) {
      assert.ok(r.facts.length > 0, r.code);
      assert.ok(r.text.length > 0, r.code);
    }
  });

  it('penalises a recent purchase and never goes below zero', () => {
    const r = eligible({ ...ownerOccupied, lastSaleDate: '2025-12-01', justValue: 6_000_000 });
    assert.ok(r.reasons.some((x) => x.code === 'recent_purchase'));
    assert.ok(r.reasons.some((x) => x.code === 'value_out_of_band'));
    assert.equal(r.score, 0);
  });

  it('excludes confidential owners, other ZIPs and other property types', () => {
    for (const p of [
      { ...absenteeLongHeld, confidential: true },
      { ...absenteeLongHeld, situsZip: '33101' },
      { ...absenteeLongHeld, propertyUse: 'vacant_land' as const },
    ]) {
      const r = scoreSellerOpportunity(p, focus, AS_OF);
      assert.equal(r.eligible, false);
    }
  });

  it('treats an in-state absentee owner without the out-of-state bonus', () => {
    const r = eligible({ ...absenteeLongHeld, ownerMailingState: 'FL', ownerMailingAddress: '9 Bay Rd, Tampa, FL' });
    assert.ok(r.reasons.some((x) => x.code === 'absentee_owner'));
    assert.ok(!r.reasons.some((x) => x.code === 'out_of_state_owner'));
  });

  it('matches mailing and situs addresses despite punctuation and case', () => {
    const r = eligible({ ...ownerOccupied, homesteadExemption: false, ownerMailingAddress: '12 palm way, miami beach, fl.' });
    assert.ok(!r.reasons.some((x) => x.code === 'absentee_owner'));
  });

  it('reports confidence from data completeness', () => {
    assert.equal(eligible(absenteeLongHeld).confidence, 1);
    const { justValue: _a, lastSalePrice: _b, ...sparse } = absenteeLongHeld;
    assert.equal(eligible(sparse).confidence, 0.33);
  });

  it('is deterministic and versioned', () => {
    assert.deepEqual(eligible(absenteeLongHeld), eligible(absenteeLongHeld));
    assert.equal(eligible(absenteeLongHeld).version, SCORING_VERSION);
  });
});
