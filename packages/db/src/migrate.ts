/**
 * SQL-first migration runner.
 *
 * Migrations are plain, reviewed SQL files in ../migrations named
 * NNNN_name.up.sql / NNNN_name.down.sql. Each step runs in one transaction
 * together with its bookkeeping row, so a failed migration leaves nothing behind.
 *
 * It shells out to `psql` (PostgreSQL client) so it needs no npm packages.
 * The application's query layer is separate and may use a driver/ORM; it reads
 * the same schema. See docs/decisions.md (D-004).
 *
 * Usage: DATABASE_URL=... node packages/db/src/migrate.ts up|down|status
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string;
}

export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir);
  const ups = files.filter((f) => /^\d{4}_[a-z0-9_]+\.up\.sql$/.test(f)).sort();
  return ups.map((up) => {
    const base = up.replace(/\.up\.sql$/, '');
    const down = `${base}.down.sql`;
    if (!files.includes(down)) throw new Error(`Migration ${base} has no down file`);
    const version = base.slice(0, 4);
    return { version, name: base, upPath: join(dir, up), downPath: join(dir, down) };
  });
}

/** Run psql against `url`. Statements and files all run in one transaction. */
export function psql(url: string, steps: ReadonlyArray<{ sql: string } | { file: string }>): string {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-At', '-d', url];
  for (const s of steps) {
    if ('sql' in s) args.push('-c', s.sql);
    else args.push('-f', s.file);
  }
  return execFileSync('psql', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export function appliedVersions(url: string): string[] {
  const out = psql(url, [{ sql: BOOKKEEPING }, { sql: 'SELECT version FROM schema_migrations ORDER BY version' }]);
  return out ? out.split('\n') : [];
}

/** Apply every pending migration in order. Returns the names applied. */
export function migrateUp(url: string, dir: string = MIGRATIONS_DIR): string[] {
  const applied = new Set(appliedVersions(url));
  const done: string[] = [];
  for (const m of listMigrations(dir)) {
    if (applied.has(m.version)) continue;
    psql(url, [
      { file: m.upPath },
      { sql: `INSERT INTO schema_migrations (version, name) VALUES ('${m.version}', '${m.name}')` },
    ]);
    done.push(m.name);
  }
  return done;
}

/** Roll back the most recent `steps` migrations. Returns the names rolled back. */
export function migrateDown(url: string, steps = 1, dir: string = MIGRATIONS_DIR): string[] {
  const applied = appliedVersions(url).reverse().slice(0, steps);
  const byVersion = new Map(listMigrations(dir).map((m) => [m.version, m]));
  const done: string[] = [];
  for (const version of applied) {
    const m = byVersion.get(version);
    if (!m) throw new Error(`Applied migration ${version} has no file in ${dir}`);
    psql(url, [{ file: m.downPath }, { sql: `DELETE FROM schema_migrations WHERE version = '${m.version}'` }]);
    done.push(m.name);
  }
  return done;
}

function main(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const [cmd = 'status', arg] = process.argv.slice(2);
  if (cmd === 'up') {
    const done = migrateUp(url);
    console.log(done.length ? `Applied: ${done.join(', ')}` : 'Already up to date.');
  } else if (cmd === 'down') {
    const done = migrateDown(url, arg ? Number(arg) : 1);
    console.log(done.length ? `Rolled back: ${done.join(', ')}` : 'Nothing to roll back.');
  } else if (cmd === 'status') {
    const applied = new Set(appliedVersions(url));
    for (const m of listMigrations()) console.log(`${applied.has(m.version) ? '[x]' : '[ ]'} ${m.name}`);
  } else {
    console.error(`Unknown command ${cmd}. Use up, down [steps] or status.`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
