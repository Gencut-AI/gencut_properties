/**
 * One discovery pass: import the ZIP codes agents asked for from the newest
 * public roll, score every workspace that is due, and prune records a newer
 * roll replaced. Safe to run repeatedly; each step picks up only what is due.
 *
 * Logs carry counts and county/ZIP codes only — never owner names or addresses.
 */
import {
  type PriorRoll,
  type PropertyTransaction,
  type RollChoice,
  type StoredParcel,
  flCounty,
  headerIndex,
  missingColumns,
  nalRowToParcel,
  nalRowToPrior,
  nalRowToTransaction,
  rowZip,
} from '@gencut/core';
import {
  type Sql,
  claimCoverage,
  claimTransactionImport,
  completeTransactionImport,
  failTransactionImport,
  scoreWorkspaceBuyers,
  storeTransactions,
  transactionImportDue,
  workspacesToScoreBuyers,
  completeCoverage,
  countiesWithCoverageRequests,
  coverageToImport,
  failCoverage,
  pendingCoverage,
  pruneSupersededRecords,
  requestMissingDiscovery,
  scoreWorkspace,
  storeParcels,
  storedPriorRolls,
  workspacesToScore,
} from '@gencut/services';
import type { RollSource } from './dor.ts';

export interface DiscoveryRun {
  backfilled: number;
  imports: { county: string; file: string | null; zips: string[]; parcels: number; error?: string }[];
  /** County-wide company purchases read for Buyer Radar, once per roll file. */
  transactions: { county: string; file: string; kept: number; error?: string }[];
  scored: { workspaceId: string; kept?: number; error?: string }[];
  buyers: { workspaceId: string; kept?: number; error?: string }[];
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
  const run: DiscoveryRun = { backfilled: 0, imports: [], transactions: [], scored: [], buyers: [], pruned: 0 };

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
    const wantTransactions = await transactionImportDue(sql, county, choice.file.name);
    if (zips.length === 0 && !wantTransactions) continue;
    if (zips.length) {
      log(`${name}: importing ${zips.length} ZIP code(s) from "${choice.file.name}"`);
      await claimCoverage(sql, county, zips);
    }
    if (wantTransactions) {
      log(`${name}: reading company purchases from "${choice.file.name}"`);
      await claimTransactionImport(sql, county, choice.file.name, choice.fileDate);
    }
    try {
      const wanted = new Set(zips);
      let prior = new Map<string, PriorRoll>();
      if (zips.length) {
        prior = await readPriorRoll(source, choice, wanted, county, log);
        if (prior.size === 0) {
          prior = await storedPriorRolls(sql, county, zips, choice.year - 1);
          if (prior.size) log(`county ${county}: using ${prior.size} stored records from the ${choice.year - 1} roll as the previous roll`);
        }
      }
      const byZip = new Map<string, StoredParcel[]>(zips.map((z) => [z, []]));
      const purchases: PropertyTransaction[] = [];
      let index: Map<string, number> | null = null;
      let rows = 0;
      // One pass over the file serves both the ZIP import and the county-wide purchases.
      await source.rows(choice, (fields) => {
        if (!index) {
          index = headerIndex(fields);
          const missing = missingColumns(index);
          if (missing.length) throw new Error(`The roll file is missing columns: ${missing.join(', ')}`);
          return;
        }
        rows++;
        if (wantTransactions) {
          const t = nalRowToTransaction(fields, index);
          if (t && t.countyCode === county) purchases.push(t);
        }
        const zip = rowZip(fields, index);
        if (!wanted.has(zip)) return;
        const parcel = nalRowToParcel(fields, index, prior.get(fields[index.get('PARCEL_ID') ?? -1]?.trim() ?? '') ?? null);
        if (parcel && parcel.countyCode === county) byZip.get(zip)?.push(parcel);
      });
      if (!index) throw new Error('The roll file is empty.');

      if (zips.length) {
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
        log(`${name}: read ${rows} rows, kept ${parcels} residential parcels in ${zips.join(', ')}; ${prior.size} matched on the previous roll`);
      }
      if (wantTransactions) {
        await storeTransactions(sql, choice.file.name, choice.fileDate, purchases);
        await completeTransactionImport(sql, county, choice.file.name, { rowsRead: rows, rowsKept: purchases.length, minSaleYear: choice.year - 1 });
        run.transactions.push({ county, file: choice.file.name, kept: purchases.length });
        log(`${name}: kept ${purchases.length} qualified company purchases from ${rows} rows`);
      }
    } catch (e) {
      const error = message(e);
      if (zips.length) {
        await failCoverage(sql, county, zips, error);
        run.imports.push({ county, file: choice.file.name, zips, parcels: 0, error });
      }
      if (wantTransactions) {
        await failTransactionImport(sql, county, choice.file.name, error);
        run.transactions.push({ county, file: choice.file.name, kept: 0, error });
      }
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

  for (const workspaceId of await workspacesToScoreBuyers(sql)) {
    try {
      const b = await scoreWorkspaceBuyers(sql, workspaceId);
      run.buyers.push({ workspaceId, kept: b.kept });
      log(`workspace ${workspaceId}: ${b.eligible} buyers eligible, ${b.kept} kept`);
    } catch (e) {
      run.buyers.push({ workspaceId, error: message(e) });
      log(`workspace ${workspaceId}: buyer scoring failed: ${message(e)}`);
    }
  }

  run.pruned = await pruneSupersededRecords(sql);
  if (run.pruned) log(`pruned ${run.pruned} superseded record(s)`);
  return run;
}

/**
 * Last year's values for the parcels in the wanted ZIPs, keyed by parcel id.
 * Optional: if the previous final roll is missing or unreadable, the import
 * goes ahead and tenure falls back to the single-roll reason.
 */
async function readPriorRoll(
  source: RollSource,
  current: RollChoice,
  wanted: Set<string>,
  county: string,
  log: (line: string) => void,
): Promise<Map<string, PriorRoll>> {
  const prior = new Map<string, PriorRoll>();
  let choice: RollChoice | null;
  try {
    choice = await source.previous(current);
  } catch (e) {
    log(`county ${county}: previous roll not listed (${message(e)}); continuing without it`);
    return prior;
  }
  if (!choice) {
    log(`county ${county}: no previous final roll published; continuing without it`);
    return prior;
  }
  const found = choice;
  try {
    let index: Map<string, number> | null = null;
    await source.rows(found, (fields) => {
      if (!index) {
        index = headerIndex(fields);
        const missing = missingColumns(index);
        if (missing.length) throw new Error(`The previous roll is missing columns: ${missing.join(', ')}`);
        return;
      }
      if (!wanted.has(rowZip(fields, index))) return;
      const r = nalRowToPrior(fields, index);
      if (r) prior.set(r.parcelId, r.prior);
    });
  } catch (e) {
    log(`county ${county}: could not read "${found.file.name}" (${message(e)}); continuing without it`);
    prior.clear();
  }
  return prior;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function hasErrors(run: DiscoveryRun): boolean {
  return run.imports.some((i) => i.error) || run.transactions.some((t) => t.error) || run.scored.some((s) => s.error) || run.buyers.some((b) => b.error);
}
