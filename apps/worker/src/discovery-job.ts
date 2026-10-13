/**
 * One discovery pass: import the ZIP codes agents asked for from the newest
 * public roll, score every workspace that is due, and prune records a newer
 * roll replaced. Safe to run repeatedly; each step picks up only what is due.
 *
 * Logs carry counts and county/ZIP codes only — never owner names or addresses.
 */
import {
  type StoredParcel,
  flCounty,
  headerIndex,
  missingColumns,
  nalRowToParcel,
  rowZip,
} from '@gencut/core';
import {
  type Sql,
  claimCoverage,
  completeCoverage,
  countiesWithCoverageRequests,
  coverageToImport,
  failCoverage,
  pendingCoverage,
  pruneSupersededRecords,
  requestMissingDiscovery,
  scoreWorkspace,
  storeParcels,
  workspacesToScore,
} from '@gencut/services';
import type { RollSource } from './dor.ts';

export interface DiscoveryRun {
  backfilled: number;
  imports: { county: string; file: string | null; zips: string[]; parcels: number; error?: string }[];
  scored: { workspaceId: string; kept?: number; error?: string }[];
  pruned: number;
}

export async function runDiscovery(opts: {
  sql: Sql;
  source: RollSource;
  asOf: Date;
  log?: (line: string) => void;
}): Promise<DiscoveryRun> {
  const { sql, source, asOf } = opts;
  const log = opts.log ?? (() => {});
  const run: DiscoveryRun = { backfilled: 0, imports: [], scored: [], pruned: 0 };

  run.backfilled = await requestMissingDiscovery(sql);
  if (run.backfilled) log(`requested discovery for ${run.backfilled} existing profile(s)`);

  for (const county of await countiesWithCoverageRequests(sql)) {
    const name = flCounty(county)?.name ?? `county ${county}`;
    let choice: Awaited<ReturnType<RollSource['latest']>>;
    try {
      choice = await source.latest(county, asOf);
    } catch (e) {
      const error = `Could not reach the Florida DOR data portal: ${message(e)}`;
      const zips = await pendingCoverage(sql, county);
      if (zips.length) await failCoverage(sql, county, zips, error);
      run.imports.push({ county, file: null, zips, parcels: 0, error });
      log(`${name}: ${error}`);
      continue;
    }
    if (!choice) {
      const zips = await pendingCoverage(sql, county);
      const error = `Florida DOR has not published a roll for ${name}.`;
      if (zips.length) await failCoverage(sql, county, zips, error);
      run.imports.push({ county, file: null, zips, parcels: 0, error });
      continue;
    }
    const zips = await coverageToImport(sql, county, choice.file.name);
    if (zips.length === 0) continue;
    log(`${name}: importing ${zips.length} ZIP code(s) from "${choice.file.name}"`);
    await claimCoverage(sql, county, zips);
    try {
      const wanted = new Set(zips);
      const byZip = new Map<string, StoredParcel[]>(zips.map((z) => [z, []]));
      let index: Map<string, number> | null = null;
      let rows = 0;
      await source.rows(choice, (fields) => {
        if (!index) {
          index = headerIndex(fields);
          const missing = missingColumns(index);
          if (missing.length) throw new Error(`The roll file is missing columns: ${missing.join(', ')}`);
          return;
        }
        rows++;
        const zip = rowZip(fields, index);
        if (!wanted.has(zip)) return;
        const parcel = nalRowToParcel(fields, index);
        if (parcel && parcel.countyCode === county) byZip.get(zip)?.push(parcel);
      });
      if (!index) throw new Error('The roll file is empty.');

      let parcels = 0;
      for (const [, list] of byZip) {
        await storeParcels(sql, choice.fileDate, list);
        parcels += list.length;
      }
      await completeCoverage(
        sql,
        county,
        zips.map((zip) => ({ zip, parcelCount: byZip.get(zip)?.length ?? 0 })),
        { sourceFile: choice.file.name, rollLabel: choice.label, fileDate: choice.fileDate },
      );
      run.imports.push({ county, file: choice.file.name, zips, parcels });
      log(`${name}: read ${rows} rows, kept ${parcels} residential parcels in ${zips.join(', ')}`);
    } catch (e) {
      const error = message(e);
      await failCoverage(sql, county, zips, error);
      run.imports.push({ county, file: choice.file.name, zips, parcels: 0, error });
      log(`${name}: import failed: ${error}`);
    }
  }

  for (const workspaceId of await workspacesToScore(sql)) {
    try {
      const s = await scoreWorkspace(sql, workspaceId, asOf);
      run.scored.push({ workspaceId, kept: s.kept });
      log(`workspace ${workspaceId}: ${s.considered} parcels considered, ${s.qualified} qualified, ${s.kept} kept`);
    } catch (e) {
      run.scored.push({ workspaceId, error: message(e) });
      log(`workspace ${workspaceId}: scoring failed: ${message(e)}`);
    }
  }

  run.pruned = await pruneSupersededRecords(sql);
  if (run.pruned) log(`pruned ${run.pruned} superseded record(s)`);
  return run;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function hasErrors(run: DiscoveryRun): boolean {
  return run.imports.some((i) => i.error) || run.scored.some((s) => s.error);
}
