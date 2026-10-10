import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { psql } from '../src/migrate.ts';

/**
 * Each test file gets its own throwaway database on the server named by
 * TEST_DATABASE_URL (a CI service container, or `scripts/dev-db.sh start`).
 */
export function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start a local Postgres with `scripts/dev-db.sh start` and export the URL it prints.',
    );
  }
  return url;
}

/** Replace the database name in a URL or keyword/value conninfo string. */
export function withDatabase(url: string, db: string): string {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const u = new URL(url);
    u.pathname = `/${db}`;
    return u.toString();
  }
  return /\bdbname=\S+/.test(url) ? url.replace(/\bdbname=\S+/, `dbname=${db}`) : `${url} dbname=${db}`;
}

export interface TestDb {
  readonly url: string;
  readonly name: string;
  query(sql: string): string;
  drop(): void;
}

export function createTestDb(): TestDb {
  const admin = adminUrl();
  const name = `gencut_test_${randomBytes(4).toString('hex')}`;
  // CREATE/DROP DATABASE cannot run inside a transaction, so not via psql().
  const run = (sql: string) =>
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', admin, '-c', sql], { stdio: 'pipe' });
  run(`CREATE DATABASE ${name}`);
  const url = withDatabase(admin, name);
  return {
    url,
    name,
    query: (sql: string) => psql(url, [{ sql }]),
    drop: () => run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/** Expect a SQL statement to fail; returns psql's error text. */
export function expectSqlError(db: TestDb, sql: string): string {
  try {
    db.query(sql);
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr;
    return String(stderr ?? e);
  }
  throw new Error(`Expected SQL to fail but it succeeded: ${sql}`);
}
