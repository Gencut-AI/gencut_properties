import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { appliedVersions, listMigrations, migrateDown, migrateUp } from '../src/migrate.ts';
import { type TestDb, createTestDb } from './helpers.ts';

function userTables(db: TestDb): string[] {
  const out = db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY 1",
  );
  return out ? out.split('\n') : [];
}

function userFunctions(db: TestDb): string[] {
  const out = db.query(
    "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1",
  );
  return out ? out.split('\n') : [];
}

describe('migrations', () => {
  let db: TestDb;
  before(() => {
    db = createTestDb();
  });
  after(() => db.drop());

  it('every migration has an up and a down file, numbered without gaps', () => {
    const ms = listMigrations();
    assert.ok(ms.length >= 2);
    ms.forEach((m, i) => assert.equal(Number(m.version), i + 1, m.name));
  });

  it('apply cleanly to an empty database', () => {
    const applied = migrateUp(db.url);
    assert.deepEqual(
      applied,
      listMigrations().map((m) => m.name),
    );
    assert.deepEqual(userTables(db), [
      'audit_events',
      'business_profiles',
      'campaigns',
      'consents',
      'data_sources',
      'memberships',
      'opportunities',
      'outreach_actions',
      'prospects',
      'source_records',
      'suppressions',
      'users',
      'workspace_permissions',
      'workspaces',
    ]);
  });

  it('are idempotent: a second run applies nothing', () => {
    assert.deepEqual(migrateUp(db.url), []);
  });

  it('roll back one step at a time to an empty schema', () => {
    const total = listMigrations().length;
    for (let i = total; i > 0; i--) {
      assert.equal(migrateDown(db.url, 1).length, 1);
      assert.equal(appliedVersions(db.url).length, i - 1);
    }
    assert.deepEqual(userTables(db), []);
    assert.deepEqual(userFunctions(db), []);
  });

  it('re-apply after a full rollback', () => {
    migrateUp(db.url);
    assert.equal(appliedVersions(db.url).length, listMigrations().length);
  });
});
