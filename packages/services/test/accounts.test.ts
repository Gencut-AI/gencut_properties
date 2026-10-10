import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createTestDb, type TestDb } from '../../db/test/helpers.ts';
import { migrateUp } from '../../db/src/migrate.ts';
import {
  type RequestContext,
  type Sql,
  ServiceError,
  createDb,
  ensureWorkspace,
  getBusinessProfile,
  getPermissions,
  saveBusinessProfile,
} from '../src/index.ts';

const validProfile = {
  licenseeName: 'Ana Rivera',
  brokerageName: 'Biscayne Bay Realty LLC',
  licenseNumber: 'sl3456789',
  officeAddress: '100 Brickell Ave, Miami, FL 33131',
  market: 'miami-dade',
  specialty: 'Waterfront condos',
  focusZips: ['33139', '33140', '33139'],
  propertyUses: ['condo', 'single_family'],
  minValue: 500_000,
  maxValue: 5_000_000,
};

function user(): RequestContext {
  const id = randomUUID();
  return { userId: id, email: `${id.slice(0, 8)}@example.com`, via: 'web' };
}

async function expectServiceError(p: Promise<unknown>, code: string): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ServiceError, `expected ServiceError, got ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  throw new Error(`expected ${code}`);
}

describe('accounts service', () => {
  let tdb: TestDb;
  let sql: Sql;

  before(() => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 4 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  it('creates exactly one owned workspace per user, even under concurrent first requests', async () => {
    const u = user();
    const results = await Promise.all([ensureWorkspace(sql, u), ensureWorkspace(sql, u), ensureWorkspace(sql, u)]);
    const ids = new Set(results.map((r) => r.workspaceId));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(results[0]?.role, 'owner');
    const again = await ensureWorkspace(sql, u);
    assert.equal(again.created, false);
    assert.equal(again.workspaceId, results[0]?.workspaceId);
  });

  it('starts with discover and generate granted and every contact channel off', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    const p = await getPermissions(sql, u, workspaceId);
    assert.equal(p.discover, true);
    assert.equal(p.generate, true);
    assert.ok(Object.values(p.contact).every((v) => v === false));
  });

  it('audits workspace creation', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    const rows = await sql<{ entity_type: string; action: string; actor_id: string; via: string }[]>`
      SELECT entity_type, action, actor_id, via FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY id
    `;
    assert.deepEqual(
      rows.map((r) => `${r.entity_type}:${r.action}`),
      ['workspace:created', 'membership:created', 'permission:granted'],
    );
    assert.ok(rows.every((r) => r.actor_id === u.userId && r.via === 'web'));
  });

  it('saves a valid profile, normalizes it, and audits create then update with changed fields', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    assert.equal(await getBusinessProfile(sql, u, workspaceId), null);

    const saved = await saveBusinessProfile(sql, u, workspaceId, validProfile);
    assert.equal(saved.licenseNumber, 'SL3456789');
    assert.deepEqual(saved.focusZips, ['33139', '33140']);
    assert.equal(saved.minValue, 500_000);

    await saveBusinessProfile(sql, u, workspaceId, { ...validProfile, specialty: 'Luxury condos', maxValue: 8_000_000 });
    const audits = await sql<{ action: string; detail: { changedFields: string[] } }[]>`
      SELECT action, detail FROM audit_events WHERE workspace_id = ${workspaceId} AND entity_type = 'business_profile' ORDER BY id
    `;
    assert.deepEqual(
      audits.map((a) => a.action),
      ['created', 'updated'],
    );
    assert.deepEqual(audits[1]?.detail.changedFields, ['specialty', 'maxValue']);
    const [ws] = await sql<{ name: string }[]>`SELECT name FROM workspaces WHERE id = ${workspaceId}`;
    assert.equal(ws?.name, 'Ana Rivera');
  });

  it('rejects invalid profiles with field messages and writes nothing', async () => {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    const err = await expectServiceError(
      saveBusinessProfile(sql, u, workspaceId, {
        ...validProfile,
        brokerageName: ' ',
        focusZips: ['3313'],
        minValue: 9_000_000,
        maxValue: 1_000_000,
        market: 'orlando',
      }),
      'invalid',
    );
    assert.deepEqual(Object.keys(err.fields).sort(), ['brokerageName', 'focusZips', 'market', 'maxValue']);
    assert.equal(await getBusinessProfile(sql, u, workspaceId), null);
  });

  it('keeps tenants apart: another user can neither read nor write the workspace', async () => {
    const owner = user();
    const stranger = user();
    const { workspaceId } = await ensureWorkspace(sql, owner);
    await ensureWorkspace(sql, stranger);
    await saveBusinessProfile(sql, owner, workspaceId, validProfile);

    await expectServiceError(getBusinessProfile(sql, stranger, workspaceId), 'forbidden');
    await expectServiceError(getPermissions(sql, stranger, workspaceId), 'forbidden');
    await expectServiceError(
      saveBusinessProfile(sql, stranger, workspaceId, { ...validProfile, brokerageName: 'Hijack Realty' }),
      'forbidden',
    );
    await expectServiceError(getBusinessProfile(sql, stranger, 'not-a-uuid'), 'forbidden');
    const still = await getBusinessProfile(sql, owner, workspaceId);
    assert.equal(still?.brokerageName, 'Biscayne Bay Realty LLC');
  });
});
