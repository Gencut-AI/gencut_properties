/**
 * End-to-end check against the real Florida DOR roll, writing only to a
 * throwaway database: migrate it, create a test workspace focused on the given
 * ZIP codes, run one discovery pass, and print aggregate results.
 *
 *   DATABASE_URL=<empty test database> node apps/worker/src/dry-run.ts 33180 33160
 *
 * Output is counts and score distributions only — no names or addresses.
 */
import { randomUUID } from 'node:crypto';
import { createDb, ensureWorkspace, listBuyers, listOpportunities, saveBusinessProfile } from '@gencut/services';
import { migrateUp } from '../../../packages/db/src/migrate.ts';
import { hasErrors, runDiscovery } from './discovery-job.ts';
import { DorRollSource } from './dor.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}
const zips = process.argv.slice(2).filter((z) => /^\d{5}$/.test(z));
if (zips.length === 0) zips.push('33180');

migrateUp(url);
const sql = createDb(url, { max: 2 });
const notice = (title: string, body: string) => console.log(`::notice title=${title}::${body}`);
try {
  const ctx = { userId: randomUUID(), email: 'dry-run@example.com', via: 'worker' as const };
  const { workspaceId } = await ensureWorkspace(sql, ctx);
  await saveBusinessProfile(sql, ctx, workspaceId, {
    licenseeName: 'Dry Run',
    brokerageName: 'Dry Run Realty',
    market: 'miami-dade',
    focusZips: zips,
    propertyUses: ['single_family', 'condo', 'multifamily'],
  });
  const started = Date.now();
  // Job log lines carry counts and codes only, never names or addresses, so they can be annotations.
  const run = await runDiscovery({ sql, source: new DorRollSource(), asOf: new Date(), log: (l) => notice('log', l) });
  notice('run', `${((Date.now() - started) / 1000).toFixed(0)}s; imports=${JSON.stringify(run.imports)} scored=${JSON.stringify(run.scored.map((s) => ({ kept: s.kept, error: s.error })))}`);

  const [d] = await sql<{ parcels_considered: number; parcels_qualified: number; opportunity_count: number }[]>`
    SELECT parcels_considered, parcels_qualified, opportunity_count FROM workspace_discovery WHERE workspace_id = ${workspaceId}
  `;
  notice('discovery', JSON.stringify(d));
  const opps = await listOpportunities(sql, ctx, workspaceId, { limit: 200 });
  const scores = new Map<number, number>();
  const reasons = new Map<string, number>();
  const types = new Map<string, number>();
  for (const o of opps) {
    scores.set(o.score, (scores.get(o.score) ?? 0) + 1);
    types.set(o.propertyType, (types.get(o.propertyType) ?? 0) + 1);
    for (const r of o.reasons) reasons.set(r.code, (reasons.get(r.code) ?? 0) + 1);
  }
  notice('scores', JSON.stringify(Object.fromEntries([...scores].sort((a, b) => b[0] - a[0]))));
  notice('reasons', JSON.stringify(Object.fromEntries(reasons)));
  notice('types', JSON.stringify(Object.fromEntries(types)));
  // Every-reason text of the top opportunity, without the parcel's identity, to review the copy.
  if (opps[0]) notice('top reasons', opps[0].reasons.map((r) => `${r.points > 0 ? '+' : ''}${r.points} ${r.text}`).join(' | '));

  // Buyer Radar: county-wide company purchases and buyers, as counts only.
  const [t] = await sql<{ purchases: number; companies: number; repeat: number; mb: string; years: Record<string, number> }[]>`
    SELECT count(*)::int AS purchases, count(DISTINCT owner_key)::int AS companies,
           (SELECT count(*)::int FROM (SELECT owner_key FROM property_transactions GROUP BY owner_key HAVING count(*) >= 2) g) AS repeat,
           pg_size_pretty(pg_total_relation_size('property_transactions')) AS mb,
           (SELECT jsonb_object_agg(sale_year, n) FROM (SELECT sale_year, count(*) AS n FROM property_transactions GROUP BY sale_year) y) AS years
    FROM property_transactions
  `;
  notice('purchases', JSON.stringify(t));
  const buyers = await listBuyers(sql, ctx, workspaceId);
  const sizes = new Map<number, number>();
  const buyerScores = new Map<number, number>();
  for (const b of buyers) {
    const k = Math.min(b.profile.purchases, 10);
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
    buyerScores.set(b.score, (buyerScores.get(b.score) ?? 0) + 1);
  }
  notice('buyers', `${buyers.length} kept; purchases per buyer (10 = 10+): ${JSON.stringify(Object.fromEntries([...sizes].sort((a, b) => a[0] - b[0])))}`);
  notice('buyer scores', JSON.stringify(Object.fromEntries([...buyerScores].sort((a, b) => b[0] - a[0]))));
  if (buyers[0]) notice('top buyer reasons', buyers[0].reasons.map((r) => `+${r.points} ${r.text}`).join(' | '));
  process.exitCode = hasErrors(run) ? 1 : 0;
} finally {
  await sql.end({ timeout: 10 });
}
