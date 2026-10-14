import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type RollFile,
  headerIndex,
  missingColumns,
  nalRowToParcel,
  nalRowToPrior,
  parcelFacts,
  pickPriorRollFile,
  pickRollFile,
  rollFolders,
  rowZip,
  scoreSellerOpportunity,
  useCodesFor,
} from '../src/index.ts';

// Synthetic rows in the DOR NAL layout. Not real parcels or owners.
const HEADER = [
  'CO_NO', 'PARCEL_ID', 'ASMNT_YR', 'DOR_UC', 'JV', 'AV_SD', 'AV_NSD', 'JV_HMSTD', 'NO_RES_UNTS', 'ACT_YR_BLT',
  'TOT_LVG_AREA', 'QUAL_CD1', 'SALE_PRC1', 'SALE_YR1', 'SALE_MO1', 'QUAL_CD2', 'SALE_PRC2', 'SALE_YR2', 'SALE_MO2',
  'EXMPT_01', 'EXMPT_03', 'EXMPT_09', 'EXMPT_20', 'OWN_NAME', 'OWN_ADDR1', 'OWN_ADDR2', 'OWN_CITY',
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
    assert.deepEqual(p.sales, [{ year: 2025, month: 4, price: 100, qualificationCode: '11' }]);
    assert.equal(p.ownerKind, 'trust');
    const facts = parcelFacts(p);
    assert.equal(facts.propertyUse, 'single_family');
    assert.equal(facts.recentSales?.[0]?.qualified, false);
    assert.equal(facts.priorAssessment, undefined);
  });

  it('drops non-residential parcels, common elements, institutions, and confidential or incomplete records', () => {
    for (const v of [
      { DOR_UC: '010' },
      { DOR_UC: '009' },
      { OWN_NAME: '' },
      { PARCEL_ID: '' },
      { PHY_ZIPCD: '' },
      { EXMPT_09: '261714' }, // religious, charitable, scientific or literary
      { EXMPT_20: '500000' }, // government
    ]) {
      assert.equal(nalRowToParcel(row({ ...base, ...v }), idx), null, JSON.stringify(v));
    }
  });

  it('keeps parcels with personal exemptions, without reading them', () => {
    const p = nalRowToParcel(row({ ...base, EXMPT_01: '25000', EXMPT_03: '43210', JV_HMSTD: '1500000' }), idx);
    assert.ok(p);
    assert.equal(p.homestead, true);
    assert.ok(!JSON.stringify(p).includes('43210'), 'a senior exemption amount is never stored');
  });

  it('reads both sale slots, newest first, and treats codes 01-06 as qualified', () => {
    const p = nalRowToParcel(
      row({ ...base, SALE_YR1: '2025', SALE_MO1: '2', SALE_PRC1: '900000', QUAL_CD1: '06', SALE_YR2: '2026', SALE_MO2: '1', SALE_PRC2: '100', QUAL_CD2: '11' }),
      idx,
    );
    assert.ok(p);
    assert.deepEqual(p.sales.map((s) => s.year), [2026, 2025]);
    assert.deepEqual(parcelFacts(p).recentSales?.map((s) => s.qualified), [false, true]);
  });

  it('attaches last year\'s final roll and merges its sales', () => {
    const prior = nalRowToPrior(row({ ...base, ASMNT_YR: '2025', JV: '1400000', AV_NSD: '780000', SALE_YR1: '2024', SALE_MO1: '5', SALE_PRC1: '1000000', QUAL_CD1: '01' }), idx);
    assert.ok(prior);
    assert.equal(prior.parcelId, base.PARCEL_ID);
    const p = nalRowToParcel(row(base), idx, prior.prior);
    assert.ok(p);
    const facts = parcelFacts(p);
    assert.deepEqual(facts.priorAssessment, { year: 2025, homestead: false, justValue: 1_400_000, assessedValue: 780_000 });
    assert.equal(facts.recentSales?.[0]?.year, 2024);
  });

  it('picks the previous year\'s final roll for prior values', () => {
    const files = [file('Dade 23 Final NAL 2025.zip'), file('Dade 23 Preliminary NAL 2025.zip'), file('Dade 23 Preliminary NAL 2026.zip')];
    assert.equal(pickPriorRollFile(files, '23', 2026)?.file.name, 'Dade 23 Final NAL 2025.zip');
    assert.equal(pickPriorRollFile([file('Dade 23 Preliminary NAL 2025.zip')], '23', 2026), null);
  });

  it('still scores payloads stored by the previous importer', () => {
    const legacy = { ...nalRowToParcel(row(base), idx), sale: { year: 2026, month: 1, price: 2_000_000, qualificationCode: '01' } } as Record<string, unknown>;
    delete legacy.sales;
    delete legacy.prior;
    delete legacy.ownerKind;
    const facts = parcelFacts(legacy as never);
    assert.equal(facts.recentSales?.[0]?.year, 2026);
    assert.equal(facts.ownerKind, 'trust');
  });

  it('lists the stored use codes behind each property type', () => {
    assert.deepEqual(useCodesFor('multifamily').sort(), ['003', '008']);
    assert.deepEqual(useCodesFor('townhouse'), ['001']);
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
      ['in_focus', 'absentee_owner', 'out_of_state_owner', 'assessment_gap'],
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
