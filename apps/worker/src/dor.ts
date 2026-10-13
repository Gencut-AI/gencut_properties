/**
 * Reads Florida DOR NAL roll files from the DOR data portal.
 *
 * Files are listed through the portal's SharePoint REST API and downloaded as
 * zip archives (tens of MB per county). The CSV inside is streamed through
 * `unzip -p` and parsed incrementally, so a county roll never sits in memory.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { type RollChoice, type RollFile, createCsvParser, pickRollFile, rollFolders } from '@gencut/core';

export const DOR_ORIGIN = 'https://floridarevenue.com';
const NAL_ROOT = '/property/dataportal/Documents/PTO Data Portal/Tax Roll Data Files/NAL';

export interface RollSource {
  /** The newest roll file for the county, or null if DOR has none published. */
  latest(countyCode: string, asOf: Date): Promise<RollChoice | null>;
  /** Stream the roll's CSV records, header first. */
  rows(choice: RollChoice, onRow: (fields: string[]) => void): Promise<void>;
}

type Fetch = typeof fetch;

export function folderListUrl(folder: string): string {
  const path = encodeURIComponent(`${NAL_ROOT}/${folder}`);
  return `${DOR_ORIGIN}/property/dataportal/_api/web/GetFolderByServerRelativeUrl('${path}')/Files?$select=Name,ServerRelativeUrl,Length,TimeLastModified`;
}

export function fileUrl(serverRelativeUrl: string): string {
  return DOR_ORIGIN + serverRelativeUrl.split('/').map(encodeURIComponent).join('/');
}

interface Listing {
  value?: { Name?: string; ServerRelativeUrl?: string; Length?: string | number; TimeLastModified?: string }[];
}

export async function listFolder(folder: string, fetchImpl: Fetch = fetch): Promise<RollFile[]> {
  const res = await fetchImpl(folderListUrl(folder), {
    headers: { accept: 'application/json;odata=nometadata' },
    signal: AbortSignal.timeout(60_000),
  });
  // A folder for a roll that is not published yet does not exist.
  if (res.status === 404 || res.status === 500) return [];
  if (!res.ok) throw new Error(`DOR listing for ${folder} returned HTTP ${res.status}`);
  const body = (await res.json()) as Listing;
  return (body.value ?? []).flatMap((f) =>
    f.Name && f.ServerRelativeUrl
      ? [{ name: f.Name, serverRelativeUrl: f.ServerRelativeUrl, length: Number(f.Length ?? 0), lastModified: f.TimeLastModified ?? '' }]
      : [],
  );
}

/** Run a command and collect stdout; reject with its stderr on failure. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

/**
 * Stream the first CSV inside a zip archive. The roll is Latin-1 encoded.
 * Calls `onRow` for every record, header first.
 */
export async function streamZippedCsv(zipPath: string, onRow: (fields: string[]) => void): Promise<void> {
  const entries = (await run('unzip', ['-Z1', zipPath])).split('\n').map((s) => s.trim());
  const csv = entries.find((e) => e.toLowerCase().endsWith('.csv'));
  if (!csv) throw new Error('The roll archive contains no CSV file.');

  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-p', zipPath, csv], { stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new TextDecoder('latin1');
    let first = true;
    const parser = createCsvParser((fields) => {
      if (first) {
        first = false;
        if (fields[0]) fields[0] = fields[0].replace(/^(\uFEFF|\u00EF\u00BB\u00BF)/, ''); // a UTF-8 BOM read as Latin-1 is three characters
      }
      onRow(fields);
    });
    let err = '';
    let failed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      try {
        parser.push(decoder.decode(chunk, { stream: true }));
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
      try {
        parser.push(decoder.decode());
        parser.end();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

export class DorRollSource implements RollSource {
  private readonly fetchImpl: Fetch;
  constructor(fetchImpl: Fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async latest(countyCode: string, asOf: Date): Promise<RollChoice | null> {
    const files: RollFile[] = [];
    for (const folder of rollFolders(asOf)) {
      files.push(...(await listFolder(folder, this.fetchImpl)));
      const choice = pickRollFile(files, countyCode);
      // Folders are newest first, so the first folder with the county's file wins.
      if (choice) return choice;
    }
    return null;
  }

  async rows(choice: RollChoice, onRow: (fields: string[]) => void): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'gencut-roll-'));
    const zipPath = join(dir, 'roll.zip');
    try {
      const res = await this.fetchImpl(fileUrl(choice.file.serverRelativeUrl), { signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`DOR download returned HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(zipPath));
      await streamZippedCsv(zipPath, onRow);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
