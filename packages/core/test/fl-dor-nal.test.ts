import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type RollFile,
  headerIndex,
  missingColumns,
  nalRowToParcel,
  parcelFacts,
  pickRollFile,
  rollFolders,
  rowZip,
  scoreSellerOpportunity,
} from '../src/index.ts';

// Synthetic rows in the DOR NAL layout. Not real parcels or owners.
const HEADER = [
  'CO_NO', 'PARCEL_ID', 'ASMNT_YR', 'DOR_UC', 'JV', 'AV_SD', 'AV_NSD', 'JV_HMSTD', 'NO_RES_UNTS', 'ACT_YR_BLT',
  'TOT_LVG_AREA', 'QUAL_CD1', 'SALE_PRC1', 'SALE_YR1', 'SALE_MO1', 'OWN_NAME', 'OWN_ADDR1', 'OWN_ADDR2', 'OWN_CITY',
  'OWN_STATE', 'OWN_ZIPCD', 'PHY_ADDR1', 'PHY_CITY', 'PHY_ZIPCD',
];
const idx = headerIndex(HEADER);

function row(values: Record<string, string>): string[] {
  return HEADER.map((h) => values[h] ?? '');
}

const base = {
  CO_NO: '23',
  PARCEL_ID: '0000000000001',
  ASMNT_YR: '2026',
  DOR_UC: '001',
  JV: '1500000',
  AV_SD: '1500000',
  AV_NSD: '800000',
  JV_HMSTD: '',
  NO_RES_UNTS: '1',
  ACT_YR_BLT: '1961',
  TOT_LVG_AREA: '2400',
  OWN_NAME: 'TEST TRUST',
  OWN_ADDR1: '1 SAMPLE PLAZA',
  OWN_CITY: 'BOSTON',
  OWN_STATE: 'MA',
  PHY_ADDR1: '200 EXAMPLE DR',
  PHY_CITY: 'AVENTURA',
  PHY_ZIPCD: '33180-1234',
};

const file = (name: string, lastModified = '2026-07-27T14:00:00Z'): RollFile => ({
  name,
  serverRelativeUrl: `/property/dataportal/Documents/NAL/${name}`,
  length: 1,
  lastModified,
});

describe('FL DOR NAL adapter', () => {
  it('looks in this year’s final, then preliminary, then last year’s final folder', () => {
    assert.deepEqual(rollFolders(new Date('2026-10-13T00:00:00Z')), ['2026F', '2026P', '2025F']);
  });

  it('picks the newest roll for the county, final over preliminary', () => {
    const files = [
      file('Dade 23 Preliminary NAL 2026.zip'),
      file('Broward Preliminary NAL 2026.zip'),
      file('Dade 23 Final NAL 2025.zip', '2025-10-30T00:00:00Z'),
      file('Palm Beach 60 Final NAL 2026.zip', '2026-10-02T00:00:00Z'),
      file('Palm Beach 60 Preliminary NAL 2026.zip'),
      file('Dade 23 Preliminary NAL 2026 layout.pdf'),
    ];
    const dade = pickRollFile(files, '23');
    assert.equal(dade?.file.name, 'Dade 23 Preliminary NAL 2026.zip');
    assert.equal(dade?.label, '2026 preliminary roll');
    assert.equal(dade?.fileDate, '2026-07-27');
    assert.equal(pickRollFile(files, '60')?.label, '2026 final roll');
    assert.equal(pickRollFile(files, '16')?.file.name, 'Broward Preliminary NAL 2026.zip');
    assert.equal(pickRollFile(files, '11'), null);
    assert.equal(pickRollFile([], '23'), null);
  });

  it('checks the header has the columns the importer needs', () => {
    assert.deepEqual(missingColumns(idx), []);
    assert.deepEqual(missingColumns(headerIndex(['CO_NO', 'PARCEL_ID'])).slice(0, 2), ['DOR_UC', 'PHY_ADDR1']);
  });

  it('turns a residential row into a stored parcel with the non-school assessed value', () => {
    const r = row({ ...base, SALE_YR1: '2025', SALE_MO1: '4', SALE_PRC1: '100', QUAL_CD1: '11' });
    assert.equal(rowZip(r, idx), '33180');
    const p = nalRowToParcel(r, idx);
    assert.ok(p);
    assert.equal(p.situs.zip, '33180');
    assert.equal(p.assessedValue, 800_000);
    assert.equal(p.homestead, false);
    assert.deepEqual(p.sale, { year: 2025, month: 4, price: 100, qualificationCode: '11' });
    const facts = parcelFacts(p);
    assert.equal(facts.propertyUse, 'single_family');
    assert.equal(facts.recentSale?.qualified, false);
  });

  it('drops non-residential parcels, common elements, and confidential or incomplete records', () => {
    for (const v of [{ DOR_UC: '010' }, { DOR_UC: '009' }, { OWN_NAME: '' }, { PARCEL_ID: '' }, { PHY_ZIPCD: '' }]) {
      assert.equal(nalRowToParcel(row({ ...base, ...v }), idx), null, JSON.stringify(v));
    }
  });

  it('maps DOR use codes onto GenCut property types', () => {
    const use = (code: string) => {
      const p = nalRowToParcel(row({ ...base, DOR_UC: code }), idx);
      return p ? parcelFacts(p).propertyUse : null;
    };
    assert.deepEqual(['000', '001', '003', '004', '005', '008', '002'].map(use), [
      'vacant_land', 'single_family', 'multifamily', 'condo', 'condo', 'multifamily', 'other',
    ]);
  });

  it('scores a stored parcel end to end', () => {
    const p = nalRowToParcel(row(base), idx);
    assert.ok(p);
    const r = scoreSellerOpportunity(parcelFacts(p), { zips: ['33180'], propertyUses: ['single_family'] }, new Date('2026-10-13'));
    assert.ok(r.eligible);
    assert.deepEqual(
      r.reasons.map((x) => x.code),
      ['in_focus', 'absentee_owner', 'out_of_state_owner', 'long_held_strong'],
    );
  });

  it('does not call a condo owner absentee when only the unit notation differs', () => {
    const p = nalRowToParcel(
      row({ ...base, DOR_UC: '004', OWN_ADDR1: '300 EXAMPLE BLVD APT 1203', OWN_STATE: 'FL', PHY_ADDR1: '300 EXAMPLE BLVD 1203', JV_HMSTD: '' }),
      idx,
    );
    assert.ok(p);
    const r = scoreSellerOpportunity(parcelFacts(p), { zips: ['33180'], propertyUses: ['condo'] }, new Date('2026-10-13'));
    assert.ok(r.eligible && !r.reasons.some((x) => x.code === 'absentee_owner'));
  });
});
