import 'server-only';
import { type Sql, createDb } from '@gencut/services';

let pool: Sql | undefined;

/** Server-only database pool. DATABASE_URL is a secret and never reaches the browser. */
export function db(): Sql {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured.');
  pool = createDb(url, { max: 3 });
  return pool;
}
