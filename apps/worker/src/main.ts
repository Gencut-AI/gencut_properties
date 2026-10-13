/**
 * Run one discovery pass against the database in DATABASE_URL.
 *
 *   DATABASE_URL=... pnpm --filter @gencut/worker discover
 *
 * Exits non-zero if any import or scoring step failed (work that succeeded is
 * kept), so a scheduled run shows up red.
 */
import { createDb } from '@gencut/services';
import { runDiscovery, hasErrors } from './discovery-job.ts';
import { DorRollSource } from './dor.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const sql = createDb(url, { max: 2 });
const log = (line: string) => console.log(`[discovery] ${line}`);
try {
  const run = await runDiscovery({ sql, source: new DorRollSource(), asOf: new Date(), log });
  log(
    `done: ${run.imports.length} county import(s), ${run.scored.length} workspace(s) scored, ${run.pruned} record(s) pruned`,
  );
  process.exitCode = hasErrors(run) ? 1 : 0;
} catch (e) {
  console.error(`[discovery] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 10 });
}
