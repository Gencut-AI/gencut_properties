import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentFocus,
  type ParcelFacts,
  SCORING_VERSION,
  matchesPropertyFocus,
  ownerKindOf,
  scoreSellerOpportunity,
} from '../src/index.ts';

// Synthetic parcels for tests; not real people or properties.
const AS_OF = new Date('2026-10-13T12:00:00Z');

const focus: AgentFocus = {
  zips: ['33180', '33160'],
  propertyUses: ['single_family', 'condo', 'multifamily'],
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

/** Absentee, out of state, and assessed far below market in both rolls. */
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
  priorAssessment: { year: 2025, justValue: 1_800_000, assessedValue: 1_000_000, homestead: false },
};

function eligible(p: ParcelFacts, f: AgentFocus = focus) {
  const r = scoreSellerOpportunity(p, f, AS_OF);
  assert.equal(r.eligible, true, r.eligible ? '' : r.why);
  if (!r.eligible) throw new Error('unreachable');
  return r;
}
const codes = (p: ParcelFacts) => eligible(p).reasons.map((r) => r.code);

describe('seller opportunity scoring v3', () => {
  it('scores an absentee, out-of-state, long-held parcel well above an owner-occupied one', () => {
    const high = eligible(absenteeLongHeld);
    assert.deepEqual(
      high.reasons.map((r) => r.code),
      ['in_focus', 'absentee_owner', 'out_of_state_owner', 'long_held_strong', 'value_in_band'],
    );
    assert.equal(high.score, 95); // 20+25+10+30+10
    assert.equal(eligible(ownerOccupied).score, 30); // in_focus 20 + value_in_band 10
  });

  it('claims tenure only when the gap is in both rolls', () => {
    const strong = eligible(absenteeLongHeld).reasons.find((r) => r.code === 'long_held_strong');
    assert.match(strong?.text ?? '', /55% of market value now and 56% on the 2025 roll/);
    assert.match(strong?.text ?? '', /at least two years/);

    // The cross-check case: assessed equalled market last year, then market jumped. No tenure claim.
    const revalued = { ...absenteeLongHeld, priorAssessment: { year: 2025, justValue: 1_760_000, assessedValue: 1_760_000, homestead: false } };
    assert.ok(!codes(revalued).some((c) => c.startsWith('long_held') || c === 'assessment_gap'));

    // A moderate gap in both years earns the smaller reason.
    const moderate = { ...absenteeLongHeld, assessedValue: 1_500_000, priorAssessment: { year: 2025, justValue: 1_800_000, assessedValue: 1_450_000, homestead: false } };
    assert.ok(codes(moderate).includes('long_held'));

    // Homesteads use the tighter 3% cap's thresholds.
    const homestead = { ...ownerOccupied, justValue: 1_000_000, assessedValue: 450_000, priorAssessment: { year: 2025, justValue: 950_000, assessedValue: 437_000, homestead: true } };
    assert.ok(codes(homestead).includes('long_held_strong'));
  });

  it('with one roll only, notes the gap without claiming how long it has been held', () => {
    const { priorAssessment: _p, ...oneRoll } = absenteeLongHeld;
    const gap = eligible(oneRoll).reasons.find((r) => r.code === 'assessment_gap');
    assert.equal(gap?.points, 10);
    assert.match(gap?.text ?? '', /One roll cannot show how long/);
  });

  it('penalises a sale on either roll in the last three years but ignores nominal transfers', () => {
    const sold = eligible({ ...absenteeLongHeld, recentSales: [{ year: 2024, month: 3, price: 1_900_000, qualified: true }] });
    assert.equal(sold.reasons.find((r) => r.code === 'recent_purchase')?.text, 'Sold in March 2024; a sale is unlikely soon.');
    assert.ok(!codes({ ...absenteeLongHeld, recentSales: [{ year: 2026, month: 3, price: 100, qualified: false }] }).includes('recent_purchase'));
    assert.ok(!codes({ ...absenteeLongHeld, recentSales: [{ year: 2022, month: 1, price: 900_000, qualified: true }] }).includes('recent_purchase'));
  });

  it('notes estates of record', () => {
    assert.ok(codes({ ...ownerOccupied, ownerName: 'ESTATE OF TEST OWNER' }).includes('estate_owner'));
    assert.ok(!codes({ ...ownerOccupied, ownerName: 'REAL ESTATE HOLDINGS LLC' }).includes('estate_owner'));
  });

  it('leaves out buildings of 10+ units unless the profile includes them', () => {
    const tower = { ...absenteeLongHeld, propertyUse: 'multifamily' as const, largeBuilding: true, units: 180 };
    const r = scoreSellerOpportunity(tower, focus, AS_OF);
    assert.equal(r.eligible, false);
    assert.equal(eligible(tower, { ...focus, includeLargeBuildings: true }).eligible, true);
  });

  it('clamps to 0–100', () => {
    const r = eligible({
      ...ownerOccupied,
      justValue: 9_000_000,
      assessedValue: 9_000_000,
      recentSales: [{ year: 2026, month: 1, price: 8_000_000, qualified: true }],
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

  it('classifies owners of record by name only', () => {
    assert.equal(ownerKindOf('TEST HOLDINGS LLC'), 'company');
    assert.equal(ownerKindOf('1 SAMPLE ST L.L.C.'), 'company');
    assert.equal(ownerKindOf('JANE TEST TRS'), 'trust');
    assert.equal(ownerKindOf('JANE TEST REV TR'), 'trust');
    assert.equal(ownerKindOf('EST OF JOHN TEST'), 'estate');
    assert.equal(ownerKindOf('JOHN TEST ESTATE'), 'estate');
    assert.notEqual(ownerKindOf('JANE TEST LIFE ESTATE'), 'estate');
    assert.notEqual(ownerKindOf('JANE TEST LIFE EST'), 'estate');
    assert.equal(ownerKindOf('JOHN TEST &W JANE'), 'individual');
    assert.equal(ownerKindOf('TRUSTCO TEST'), 'individual');
  });

  it('cites the fact fields behind every reason, is deterministic and versioned', () => {
    const r = eligible(absenteeLongHeld);
    for (const reason of r.reasons) assert.ok(reason.facts.length > 0 && reason.text.length > 0);
    assert.deepEqual(eligible(absenteeLongHeld), r);
    assert.equal(r.version, SCORING_VERSION);
    assert.equal(r.confidence, 1);
    const { justValue: _a, assessedValue: _b, priorAssessment: _c, ...sparse } = absenteeLongHeld;
    assert.equal(eligible(sparse).confidence, 0.25);
  });
});
