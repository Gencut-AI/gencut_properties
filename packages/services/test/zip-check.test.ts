import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import { ServiceError, type Sql, createDb, ensureWorkspace, saveBusinessProfile, storeZipIndex, zipIndexDue, zipsWithoutHomes } from '../src/index.ts';

// Synthetic counts. Not a real roll.
const profile = (zips: string[], market = 'miami-dade') => ({ licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', market, focusZips: zips, propertyUses: ['single_family'] });

describe('focus ZIP codes must have homes in the chosen county', () => {
  let tdb: TestDb;
  let sql: Sql;
  before(() => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 2 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  it('accepts anything before a county has been read, then rejects ZIP codes with no homes, naming the right county', async () => {
    const id = randomUUID();
    const u = { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' as const };
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, profile(['33002']));

    assert.equal(await zipIndexDue(sql, '23', 'Dade 23 Preliminary NAL 2026.zip'), true);
    await storeZipIndex(sql, '23', 'Dade 23 Preliminary NAL 2026.zip', '2026-07-27', new Map([['33180', 18796], ['33160', 25000]]));
    await storeZipIndex(sql, '16', 'Broward 16 Preliminary NAL 2026.zip', '2026-07-27', new Map([['33004', 6000]]));
    assert.equal(await zipIndexDue(sql, '23', 'Dade 23 Preliminary NAL 2026.zip'), false);
    assert.equal(await zipIndexDue(sql, '23', 'Dade 23 Final NAL 2026.zip'), true, 'a new roll file is counted again');

    assert.deepEqual(await zipsWithoutHomes(sql, 'miami-dade', ['33180', '33002', '33004']), [
      { zip: '33002', otherMarket: null },
      { zip: '33004', otherMarket: 'broward' },
    ]);
    await assert.rejects(
      saveBusinessProfile(sql, u, workspaceId, profile(['33180', '33002', '33004'])),
      (e) => e instanceof ServiceError && /33002, 33004 have no homes on the Miami-Dade County property roll \(33004 is in Broward County\)/.test(e.fields?.focusZips ?? ''),
    );
    const saved = await saveBusinessProfile(sql, u, workspaceId, profile(['33180', '33160']));
    assert.deepEqual(saved.focusZips, ['33180', '33160']);
    assert.deepEqual((await saveBusinessProfile(sql, u, workspaceId, profile(['33004'], 'broward'))).focusZips, ['33004']);
    assert.deepEqual(await zipsWithoutHomes(sql, 'palm-beach', ['33401']), [], 'a county not read yet rejects nothing');
  });
});
