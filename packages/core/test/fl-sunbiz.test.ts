import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CompanyRecord,
  SUNBIZ_RECORD_LENGTH,
  filingTypeLabel,
  officerTitleLabel,
  ownerKey,
  parseSunbizRecord,
  peopleOnRecord,
  pickCompanyRecord,
  sunbizDate,
} from '../src/index.ts';

// Synthetic records in the Department of State's 1,440-character layout. Not real companies or people.
type Officer = { title: string; type: string; name: string; address?: string; city?: string; state?: string; zip?: string };
function line(v: {
  doc: string; name: string; status?: string; type?: string; filed?: string; lastTx?: string; more?: string; fei?: string;
  years?: [string, string, string]; agent?: string; agentType?: string; agentAddress?: string; officers?: Officer[];
}): string {
  const chars = Array<string>(SUNBIZ_RECORD_LENGTH).fill(' ');
  const put = (start: number, len: number, value: string) => {
    for (let i = 0; i < len; i++) chars[start - 1 + i] = value[i] ?? ' ';
  };
  put(1, 12, v.doc);
  put(13, 192, v.name);
  put(205, 1, v.status ?? 'A');
  put(206, 15, v.type ?? 'FLAL');
  put(221, 42, '100 EXAMPLE BLVD');
  put(263, 42, 'SUITE 5');
  put(305, 28, 'MIAMI');
  put(333, 2, 'FL');
  put(335, 10, '33131');
  put(345, 2, 'US');
  put(347, 42, 'PO BOX 1');
  put(431, 28, 'MIAMI');
  put(459, 2, 'FL');
  put(461, 10, '331310000');
  put(473, 8, v.filed ?? '03152019');
  put(481, 14, v.fei ?? '00-0000000');
  put(495, 1, v.more ?? 'N');
  put(496, 8, v.lastTx ?? '04012026');
  const [y1, y2, y3] = v.years ?? ['2026', '2025', '2024'];
  put(506, 4, y1);
  put(519, 4, y2);
  put(532, 4, y3);
  put(545, 42, v.agent ?? 'SAMPLE AGENT SERVICES LLC');
  put(587, 1, v.agentType ?? 'C');
  put(588, 42, v.agentAddress ?? '9 AGENT WAY');
  (v.officers ?? []).forEach((o, i) => {
    const at = 669 + i * 128;
    put(at, 4, o.title);
    put(at + 4, 1, o.type);
    put(at + 5, 42, o.name);
    put(at + 47, 42, o.address ?? '1 PRIVATE HOME RD');
    put(at + 89, 28, o.city ?? 'MIAMI');
    put(at + 117, 2, o.state ?? 'FL');
    put(at + 119, 9, o.zip ?? '33133');
  });
  return `${chars.join('')}\r\n`;
}

describe('Florida company register (Sunbiz)', () => {
  it('reads a record: name, status, type, business addresses, dates, reports, agent and officers', () => {
    const r = parseSunbizRecord(line({
      doc: 'L19000000001', name: 'SAMPLE BAY HOMES, LLC',
      officers: [{ title: 'MGR', type: 'P', name: 'DOE JANE' }, { title: 'AMBR', type: 'C', name: 'EXAMPLE HOLDINGS LLC' }],
    }));
    assert.ok(r);
    assert.equal(r.documentNumber, 'L19000000001');
    assert.equal(r.name, 'SAMPLE BAY HOMES, LLC');
    assert.equal(r.nameKey, ownerKey('SAMPLE BAY HOMES LLC'), 'the same key as the roll owner name');
    assert.equal(r.status, 'active');
    assert.equal(r.filingType, 'FLAL');
    assert.deepEqual(r.principal, { address1: '100 EXAMPLE BLVD', address2: 'SUITE 5', city: 'MIAMI', state: 'FL', zip: '33131', country: 'US' });
    assert.equal(r.mailing.zip, '33131', 'a +4 of 0000 is dropped');
    assert.equal(r.filedOn, '2019-03-15');
    assert.equal(r.lastTransactionOn, '2026-04-01');
    assert.deepEqual(r.reportYears, [2026, 2025, 2024]);
    assert.deepEqual(r.registeredAgent, { name: 'SAMPLE AGENT SERVICES LLC', type: 'company' });
    assert.deepEqual(r.officers, [
      { title: 'MGR', type: 'person', name: 'DOE JANE' },
      { title: 'AMBR', type: 'company', name: 'EXAMPLE HOLDINGS LLC' },
    ]);
    assert.equal(r.moreOfficers, false);
  });

  it('never keeps officers’ own addresses, the agent’s address or the tax number', () => {
    const r = parseSunbizRecord(line({ doc: 'L19000000002', name: 'SAMPLE LLC', fei: '12-3456789', officers: [{ title: 'MGR', type: 'P', name: 'DOE JANE' }] }));
    const text = JSON.stringify(r);
    for (const leaked of ['1 PRIVATE HOME RD', '33133', '9 AGENT WAY', '12-3456789']) assert.ok(!text.includes(leaked), leaked);
  });

  it('skips blank officer slots, reads inactive records, the more-officers flag and bad dates', () => {
    const r = parseSunbizRecord(line({
      doc: 'P10000000003', name: 'EXAMPLE CORP', status: 'I', type: 'DOMP', filed: '13452010', more: 'Y', years: ['2012', '', ''],
      officers: [{ title: '', type: '', name: '' }, { title: 'PD', type: 'P', name: 'ROE RICHARD' }],
    }));
    assert.ok(r);
    assert.equal(r.status, 'inactive');
    assert.equal(r.filedOn, null);
    assert.deepEqual(r.reportYears, [2012]);
    assert.equal(r.moreOfficers, true);
    assert.deepEqual(r.officers.map((o) => o.name), ['ROE RICHARD']);
    assert.equal(parseSunbizRecord('L190000'), null, 'too short');
    assert.equal(parseSunbizRecord(' '.repeat(SUNBIZ_RECORD_LENGTH)), null, 'no document number');
  });

  it('turns dates and codes into words', () => {
    assert.equal(sunbizDate('02292024'), '2024-02-29');
    assert.equal(sunbizDate('02292025'), null);
    assert.equal(sunbizDate('00000000'), null);
    assert.equal(officerTitleLabel('MGR'), 'Manager');
    assert.equal(officerTitleLabel('ambr'), 'Authorized member');
    assert.equal(officerTitleLabel('PD'), 'President, director');
    assert.equal(officerTitleLabel('PTS'), 'President, treasurer, secretary');
    assert.equal(officerTitleLabel('ZZZ'), 'ZZZ');
    assert.equal(officerTitleLabel(''), 'Officer');
    assert.equal(filingTypeLabel('FLAL'), 'Florida LLC');
    assert.equal(filingTypeLabel('XYZ'), 'XYZ');
  });

  it('lists the people on a record, leaving out companies that hold an office', () => {
    const r = parseSunbizRecord(line({ doc: 'L1', name: 'SAMPLE LLC', officers: [{ title: 'AMBR', type: 'C', name: 'PARENT LLC' }, { title: 'MGR', type: 'P', name: 'DOE JANE' }] }))!;
    assert.deepEqual(peopleOnRecord(r), [{ name: 'DOE JANE', title: 'Manager' }]);
  });
});

describe('Matching a roll owner to the register', () => {
  const rec = (doc: string, name: string, over: Partial<CompanyRecord> = {}): CompanyRecord => ({ ...parseSunbizRecord(line({ doc, name }))!, ...over });

  it('matches the exact name, preferring an active company, then the most recently updated', () => {
    const old = rec('L10', 'SAMPLE HOMES LLC', { status: 'inactive', lastTransactionOn: '2026-01-01' });
    const live = rec('L11', 'Sample Homes, L.L.C.', { status: 'active', lastTransactionOn: '2020-01-01' });
    const other = rec('L12', 'SAMPLE HOMES 2 LLC');
    assert.deepEqual(pickCompanyRecord('SAMPLE HOMES LLC', [old, other, live]), { record: live, match: 'exact' });
    const newer = rec('L13', 'SAMPLE HOMES LLC', { lastTransactionOn: '2026-05-01' });
    assert.equal(pickCompanyRecord('SAMPLE HOMES LLC', [live, newer])?.record.documentNumber, 'L13');
  });

  it('uses a longer registered name only when the roll name was cut at 30 characters and one company fits', () => {
    const cut = 'SAMPLE BAY RESIDENTIAL INVESTM'; // 30 characters
    assert.equal(cut.length, 30);
    const full = rec('L20', 'SAMPLE BAY RESIDENTIAL INVESTMENTS LLC');
    assert.deepEqual(pickCompanyRecord(cut, [full]), { record: full, match: 'shortened' });
    assert.equal(pickCompanyRecord('SAMPLE BAY RESIDENTIAL', [full]), null, 'a name under 30 characters is complete: no guessing');
    const twin = rec('L21', 'SAMPLE BAY RESIDENTIAL INVESTMENT GROUP LLC');
    assert.equal(pickCompanyRecord(cut, [full, twin]), null, 'two active companies fit: ambiguous');
    const closed = rec('L22', 'SAMPLE BAY RESIDENTIAL INVESTMENT GROUP LLC', { status: 'inactive' });
    assert.equal(pickCompanyRecord(cut, [full, closed])?.record.documentNumber, 'L20', 'the only active one');
    assert.equal(pickCompanyRecord(cut, []), null);
  });
});
