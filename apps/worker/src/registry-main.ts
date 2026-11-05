/**
 * Import Florida company register records for the companies that bought homes.
 *
 *   DATABASE_URL=... pnpm --filter @gencut/worker registry
 *
 * Needs `lftp` and `unzip`. Does nothing when the register is up to date.
 * Exits non-zero when the import failed, so a scheduled run shows up red.
 */
import { createDb } from '@gencut/services';
import { SunbizSource, runRegistryImport } from './registry.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const sql = createDb(url, { max: 2 });
const log = (line: string) => console.log(`[registry] ${line}`);
try {
  const run = await runRegistryImport({ sql, source: new SunbizSource(), log });
  process.exitCode = run.error ? 1 : 0;
} catch (e) {
  console.error(`[registry] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 10 });
}
