/**
 * Imports Florida company register records (Sunbiz) for the companies that
 * bought homes (D-028).
 *
 * The Department of State publishes the whole register quarterly as
 * `doc/quarterly/cor/cordata.zip` (about 1.8 GB, 13 million fixed-width
 * records) on its public SFTP server. The archive is downloaded with `lftp`
 * and streamed through `unzip -p`; only records whose name matches an owner on
 * the stored roll purchases are kept, so the register never sits in memory or
 * in the database.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CompanyRecord, ownerKey, parseSunbizRecord } from '@gencut/core';
import {
  type Sql,
  claimCompanyImport,
  companyImportDue,
  completeCompanyImport,
  failCompanyImport,
  isWantedCompany,
  storeCompanyRecords,
  wantedCompanies,
} from '@gencut/services';

export const SUNBIZ_HOST = 'sftp.floridados.gov';
export const SUNBIZ_QUARTERLY_FOLDER = 'doc/quarterly/cor';
export const SUNBIZ_QUARTERLY_FILE = 'cordata.zip';
/**
 * The public login the Florida Department of State publishes on its "Data
 * Downloads" page for these files. It is the same for everyone; not a secret.
 */
export const SUNBIZ_PUBLIC_LOGIN = { user: 'Public', password: 'PubAccess1845!' }; // gitleaks:allow

export interface RegisterFile {
  /** e.g. "doc/quarterly/cor/cordata.zip@2026-10-07": the file and its date, so a new quarter is a new import. */
  readonly sourceFile: string;
  readonly fileDate: string;
  readonly bytes: number;
}

export interface RegistrySource {
  latest(): Promise<RegisterFile | null>;
  /** Stream every record line of the file; `limitMembers` reads only the first n files in the archive (dry runs). Returns lines read. */
  lines(file: RegisterFile, onLine: (line: string) => void, options?: { limitMembers?: number }): Promise<number>;
}

/** The size and date of `cordata.zip` in an `lftp` listing of the quarterly folder, or null. */
export function parseListing(listing: string): { bytes: number; fileDate: string } | null {
  for (const line of listing.split('\n')) {
    const m = /\s(\d+)\s+(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}(?::\d{2})?\s+cordata\.zip\s*$/.exec(line);
    if (m?.[1] && m[2]) return { bytes: Number(m[1]), fileDate: m[2] };
  }
  return null;
}

/** Split a stream of text into lines, keeping the unfinished tail for the next chunk. */
export function lineSplitter(onLine: (line: string) => void): { push(text: string): void; end(): void } {
  let rest = '';
  return {
    push(text) {
      const parts = (rest + text).split('\n');
      rest = parts.pop() ?? '';
      for (const p of parts) onLine(p);
    },
    end() {
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}

const lftpArgs = (commands: string) => [
  '-u',
  `${SUNBIZ_PUBLIC_LOGIN.user},${SUNBIZ_PUBLIC_LOGIN.password}`,
  '-e',
  `set sftp:auto-confirm yes; set net:timeout 30; set net:max-retries 3; ${commands}; bye`,
  `sftp://${SUNBIZ_HOST}`,
];

export class SunbizSource implements RegistrySource {
  async latest(): Promise<RegisterFile | null> {
    const listing = await run('lftp', lftpArgs(`ls ${SUNBIZ_QUARTERLY_FOLDER}`), 120_000);
    const found = parseListing(listing);
    return found ? { sourceFile: `${SUNBIZ_QUARTERLY_FOLDER}/${SUNBIZ_QUARTERLY_FILE}@${found.fileDate}`, fileDate: found.fileDate, bytes: found.bytes } : null;
  }

  async lines(_file: RegisterFile, onLine: (line: string) => void, options: { limitMembers?: number } = {}): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), 'gencut-sunbiz-'));
    const zipPath = join(dir, SUNBIZ_QUARTERLY_FILE);
    try {
      await run('lftp', lftpArgs(`get ${SUNBIZ_QUARTERLY_FOLDER}/${SUNBIZ_QUARTERLY_FILE} -o ${zipPath}`), 30 * 60_000);
      const members = (await run('unzip', ['-Z1', zipPath], 60_000))
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.toLowerCase().endsWith('.txt'))
        .sort();
      if (members.length === 0) throw new Error('The register archive contains no data files.');
      let count = 0;
      for (const member of members.slice(0, options.limitMembers ?? members.length)) {
        await new Promise<void>((resolve, reject) => {
          const child = spawn('unzip', ['-p', zipPath, member], { stdio: ['ignore', 'pipe', 'pipe'] });
          const decoder = new TextDecoder('latin1');
          const split = lineSplitter((line) => {
            count++;
            onLine(line);
          });
          let err = '';
          let failed = false;
          child.stdout.on('data', (chunk: Buffer) => {
            if (failed) return;
            try {
              split.push(decoder.decode(chunk, { stream: true }));
            } catch (e) {
              failed = true;
              child.kill();
              reject(e);
            }
          });
          child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
          child.on('error', reject);
          child.on('close', (code) => {
            if (failed) return;
            if (code !== 0) return reject(new Error(`unzip exited ${code}: ${err.trim().slice(0, 300)}`));
            split.push(decoder.decode());
            split.end();
            resolve();
          });
        });
      }
      return count;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** The name field of a record line (positions 13–204), as its group key; cheap enough to run on every line. */
const NAME_START = 12;
const NAME_END = 204;

export interface RegistryRun {
  readonly sourceFile: string | null;
  readonly skipped?: 'no_file' | 'not_due' | 'no_buyers';
  readonly rowsRead?: number;
  readonly kept?: number;
  readonly error?: string;
}

/**
 * Import the register when it is due: when its file is new, or a roll import
 * finished since the last one (new buyers to look up).
 */
export async function runRegistryImport(deps: { sql: Sql; source: RegistrySource; log: (line: string) => void }): Promise<RegistryRun> {
  const { sql, source, log } = deps;
  const file = await source.latest();
  if (!file) {
    log('no register file found');
    return { sourceFile: null, skipped: 'no_file' };
  }
  if (!(await companyImportDue(sql, file.sourceFile))) {
    log(`${file.sourceFile}: up to date`);
    return { sourceFile: file.sourceFile, skipped: 'not_due' };
  }
  const wanted = await wantedCompanies(sql);
  if (wanted.keys.size === 0) {
    log('no company purchases stored yet: nothing to look up');
    return { sourceFile: file.sourceFile, skipped: 'no_buyers' };
  }
  await claimCompanyImport(sql, file.sourceFile, file.fileDate);
  log(`${file.sourceFile}: looking up ${wanted.keys.size} companies`);
  try {
    const kept = new Map<string, CompanyRecord>();
    const rowsRead = await source.lines(file, (line) => {
      const key = ownerKey(line.slice(NAME_START, NAME_END));
      if (!key || !isWantedCompany(wanted, key)) return;
      const record = parseSunbizRecord(line);
      if (record) kept.set(record.documentNumber, record);
    });
    await storeCompanyRecords(sql, file.sourceFile, file.fileDate, [...kept.values()]);
    await completeCompanyImport(sql, file.sourceFile, { rowsRead, rowsKept: kept.size });
    log(`${file.sourceFile}: ${rowsRead} records read, ${kept.size} kept`);
    return { sourceFile: file.sourceFile, rowsRead, kept: kept.size };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failCompanyImport(sql, file.sourceFile, message);
    log(`${file.sourceFile}: failed: ${message}`);
    return { sourceFile: file.sourceFile, error: message };
  }
}
