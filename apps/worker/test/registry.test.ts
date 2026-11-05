import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type PropertyTransaction, SUNBIZ_RECORD_LENGTH, ownerKey } from '@gencut/core';
import {
  type RequestContext,
  type Sql,
  claimTransactionImport,
  companyImportDue,
  companyRecordFor,
  companyRegistryStatus,
  completeTransactionImport,
  createDb,
  ensureWorkspace,
  getBuyer,
  listBuyers,
  saveBusinessProfile,
  scoreWorkspaceBuyers,
  storeTransactions,
} from '@gencut/services';
import { migrateUp } from '../../../packages/db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../../packages/db/test/helpers.ts';
import { type RegisterFile, type RegistrySource, lineSplitter, parseListing, runRegistryImport } from '../src/registry.ts';

// Synthetic register records (the Department of State's 1,440-character layout) and roll purchases. Not real companies or people.
function record(doc: string, name: string, over: { status?: string; officers?: [string, string, string][] } = {}): string {
  const chars = Array<string>(SUNBIZ_RECORD_LENGTH).fill(' ');
  const put = (start: number, len: number, value: string) => {
    for (let i = 0; i < len; i++) chars[start - 1 + i] = value[i] ?? ' ';
  };
  put(1, 12, doc);
  put(13, 192, name);
  put(205, 1, over.status ?? 'A');
  put(206, 15, 'FLAL');
  put(221, 42, '100 EXAMPLE BLVD');
  put(305, 28, 'MIAMI');
  put(333, 2, 'FL');
  put(335, 10, '33131');
  put(473, 8, '03152019');
  put(496, 8, '04012026');
  put(506, 4, '2026');
  put(545, 42, 'SAMPLE AGENT SERVICES LLC');
  put(587, 1, 'C');
  (over.officers ?? [['MGR', 'P', 'DOE JANE']]).forEach(([title, type, officer], i) => {
    put(669 + i * 128, 4, title);
    put(673 + i * 128, 1, type);
    put(674 + i * 128, 42, officer);
    put(716 + i * 128, 42, '1 PRIVATE HOME RD');
  });
  return chars.join('');
}

function sale(company: string, n: number): PropertyTransaction {
  return {
    countyCode: '23', parcelId: `${ownerKey(company).slice(0, 6)}${n}`, rollYear: 2026,
    situs: { address: `${n} EXAMPLE DR`, city: 'AVENTURA', zip: '33180' }, useCode: '001', units: 1, livingArea: 1800, yearBuilt: 1990,
    ownerName: company, ownerKey: ownerKey(company),
    ownerMailing: { address1: '1 SAMPLE PLAZA', address2: '', city: 'MIAMI', state: 'FL', zip: '33131' },
    saleYear: 2026, saleMonth: n, price: 500_000 + n * 10_000, qualificationCode: '01',
  };
}

const CUT = 'SAMPLE BAY RESIDENTIAL INVESTM'; // a roll name cut at 30 characters

class FakeRegister implements RegistrySource {
  reads = 0;
  file: RegisterFile = { sourceFile: 'doc/quarterly/cor/cordata.zip@2026-10-07', fileDate: '2026-10-07', bytes: 1 };
  lines_: string[];
  fail = false;
  constructor(lines: string[]) {
    this.lines_ = lines;
  }
  async latest() {
    return this.file;
  }
  async lines(_f: RegisterFile, onLine: (line: string) => void) {
    this.reads++;
    if (this.fail) throw new Error('lftp exited 1: connection refused');
    for (const l of this.lines_) onLine(`${l}\r`);
    return this.lines_.length;
  }
}

describe('Company register import', () => {
  let tdb: TestDb;
  let sql: Sql;
  const log = () => {};
  before(async () => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 4 });
    const purchases = [1, 2, 3].map((n) => sale('ALPHA HOMES LLC', n)).concat([sale(CUT, 4), sale(CUT, 5), sale('NOBODY REGISTERED LLC', 6)]);
    await claimTransactionImport(sql, '23', 'roll.zip', '2026-07-27');
    await storeTransactions(sql, 'roll.zip', '2026-07-27', purchases);
    await completeTransactionImport(sql, '23', 'roll.zip', { rowsRead: 10, rowsKept: purchases.length, minSaleYear: 2025 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  const LINES = [
    record('L19000000001', 'ALPHA HOMES, L.L.C.', { officers: [['MGR', 'P', 'DOE JANE'], ['AMBR', 'C', 'PARENT HOLDINGS LLC']] }),
    record('L15000000002', 'ALPHA HOMES LLC', { status: 'I' }),
    record('L19000000003', 'SAMPLE BAY RESIDENTIAL INVESTMENTS LLC'),
    record('L19000000004', 'UNRELATED SAMPLE LLC'),
    '',
  ];

  it('keeps only companies that bought homes, with their people, and finds a buyer’s record', async () => {
    const source = new FakeRegister(LINES);
    const run = await runRegistryImport({ sql, source, log });
    assert.deepEqual(run, { sourceFile: source.file.sourceFile, rowsRead: 5, kept: 3 });
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM company_records`;
    assert.equal(n?.n, 3, 'the unrelated company is not stored');
    const [stored] = await sql<{ officers: unknown; principal: unknown }[]>`SELECT officers, principal FROM company_records WHERE document_number = 'L19000000001'`;
    assert.ok(!JSON.stringify(stored).includes('PRIVATE HOME'), 'no officer addresses');

    const alpha = await companyRecordFor(sql, ownerKey('ALPHA HOMES LLC'), ['ALPHA HOMES LLC']);
    assert.equal(alpha?.record.documentNumber, 'L19000000001', 'the active company of that name');
    assert.equal(alpha?.match, 'exact');
    assert.equal(alpha?.fileDate, '2026-10-07');
    const cut = await companyRecordFor(sql, ownerKey(CUT), [CUT]);
    assert.deepEqual([cut?.record.name, cut?.match], ['SAMPLE BAY RESIDENTIAL INVESTMENTS LLC', 'shortened']);
    assert.equal(await companyRecordFor(sql, ownerKey('NOBODY REGISTERED LLC'), ['NOBODY REGISTERED LLC']), null);
    assert.equal(await companyRecordFor(sql, 'not a key', ['x']), null);
    assert.deepEqual(await companyRegistryStatus(sql), { sourceFile: source.file.sourceFile, fileDate: '2026-10-07', records: 3 });
  });

  it('shows the record on the buyer page', async () => {
    const id = randomUUID();
    const u: RequestContext = { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, {
      licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', market: 'miami-dade', focusZips: ['33180'], propertyUses: ['single_family'],
    });
    await scoreWorkspaceBuyers(sql, workspaceId);
    const buyers = await listBuyers(sql, u, workspaceId);
    const alpha = buyers.find((b) => b.profile.ownerKey === ownerKey('ALPHA HOMES LLC'));
    assert.ok(alpha);
    const detail = await getBuyer(sql, u, workspaceId, alpha.id);
    assert.equal(detail.registry?.record.name, 'ALPHA HOMES, L.L.C.');
    assert.deepEqual(detail.registry?.record.officers.map((o) => [o.title, o.type, o.name]), [['MGR', 'person', 'DOE JANE'], ['AMBR', 'company', 'PARENT HOLDINGS LLC']]);
  });

  it('runs again only for a new register file or after a new roll import, and records failures', async () => {
    const source = new FakeRegister(LINES);
    assert.deepEqual(await runRegistryImport({ sql, source, log }), { sourceFile: source.file.sourceFile, skipped: 'not_due' });
    assert.equal(source.reads, 0, 'up to date: nothing downloaded');

    await claimTransactionImport(sql, '23', 'roll-2.zip', '2026-10-28');
    await completeTransactionImport(sql, '23', 'roll-2.zip', { rowsRead: 1, rowsKept: 0, minSaleYear: 2025 });
    assert.equal(await companyImportDue(sql, source.file.sourceFile), true, 'new buyers may need looking up');
    await runRegistryImport({ sql, source, log });
    assert.equal(source.reads, 1);

    // A new quarter's file replaces the records; one that fails is recorded and retried later.
    const next = new FakeRegister([record('L19000000001', 'ALPHA HOMES LLC')]);
    next.file = { sourceFile: 'doc/quarterly/cor/cordata.zip@2027-01-07', fileDate: '2027-01-07', bytes: 1 };
    next.fail = true;
    const failed = await runRegistryImport({ sql, source: next, log });
    assert.match(failed.error ?? '', /connection refused/);
    assert.equal(await companyImportDue(sql, next.file.sourceFile), false, 'not retried at once');
    const [f] = await sql<{ status: string }[]>`SELECT status FROM company_imports WHERE source_file = ${next.file.sourceFile}`;
    assert.equal(f?.status, 'failed');
    const [kept] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM company_records`;
    assert.equal(kept?.n, 3, 'a failed import keeps the last good records');

    await sql`UPDATE company_imports SET finished_at = now() - interval '7 hours' WHERE source_file = ${next.file.sourceFile}`;
    next.fail = false;
    assert.deepEqual(await runRegistryImport({ sql, source: next, log }), { sourceFile: next.file.sourceFile, rowsRead: 1, kept: 1 });
    const rows = await sql<{ document_number: string; file_date: string }[]>`SELECT document_number, to_char(file_date, 'YYYY-MM-DD') AS file_date FROM company_records`;
    assert.deepEqual([...rows], [{ document_number: 'L19000000001', file_date: '2027-01-07' }], 'records the new file no longer has are dropped');
  });

  it('reads the server listing and splits streamed lines', () => {
    const listing = [
      'drwxr-xr-x                      0 2026-10-07 16:02:14 .',
      '-rw-r--r--             1793034019 2026-10-07 15:45:22 cordata.zip',
      '-rw-r--r--              195000143 2026-10-05 16:50:10 corevent.zip',
    ].join('\n');
    assert.deepEqual(parseListing(listing), { bytes: 1793034019, fileDate: '2026-10-07' });
    assert.equal(parseListing('-rw-r--r-- 195000143 2026-10-05 16:50:10 corevent.zip'), null);
    const out: string[] = [];
    const split = lineSplitter((l) => out.push(l));
    split.push('ab');
    split.push('c\r\nde');
    split.push('f\r\n');
    split.push('gh');
    split.end();
    assert.deepEqual(out, ['abc\r', 'def\r', 'gh']);
  });
});
