import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DorRollSource, fileUrl, folderListUrl, listFolder, streamZippedCsv } from '../src/dor.ts';

// A tiny synthetic roll: Latin-1 text, a BOM, a quoted field with a comma. Not real records.
const CSV = 'CO_NO,PARCEL_ID,OWN_NAME,PHY_ZIPCD\r\n23,TEST1,"PE\u00D1A TEST, TRUSTEE",33180\r\n23,TEST2,TEST OWNER,33181\r\n';

describe('DOR roll client', () => {
  let dir: string;
  let zipPath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gencut-dor-test-'));
    writeFileSync(join(dir, 'NAL23P202601.csv'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CSV, 'latin1')]));
    zipPath = join(dir, 'roll.zip');
    execFileSync('zip', ['-q', '-j', zipPath, join(dir, 'NAL23P202601.csv')]);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('builds the portal URLs the probe verified', () => {
    assert.equal(
      fileUrl('/property/dataportal/Documents/PTO Data Portal/Tax Roll Data Files/NAL/2026P/Dade 23 Preliminary NAL 2026.zip'),
      'https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/Tax%20Roll%20Data%20Files/NAL/2026P/Dade%2023%20Preliminary%20NAL%202026.zip',
    );
    assert.match(folderListUrl('2026P'), /GetFolderByServerRelativeUrl\('%2Fproperty%2Fdataportal%2F.*%2FNAL%2F2026P'\)\/Files\?\$select=/);
  });

  it('streams the CSV out of the archive, decoding Latin-1 and dropping the BOM', async () => {
    const rows: string[][] = [];
    await streamZippedCsv(zipPath, (r) => rows.push(r));
    assert.deepEqual(rows, [
      ['CO_NO', 'PARCEL_ID', 'OWN_NAME', 'PHY_ZIPCD'],
      ['23', 'TEST1', 'PE\u00D1A TEST, TRUSTEE', '33180'],
      ['23', 'TEST2', 'TEST OWNER', '33181'],
    ]);
  });

  it('stops and reports when a row handler throws', async () => {
    await assert.rejects(
      streamZippedCsv(zipPath, () => {
        throw new Error('bad header');
      }),
      /bad header/,
    );
  });

  it('lists folders, treating an unpublished folder as empty', async () => {
    const fake = (async (url: string | URL | Request) => {
      if (String(url).includes('2026F')) return new Response('not found', { status: 404 });
      return Response.json({
        value: [
          { Name: 'Dade 23 Preliminary NAL 2026.zip', ServerRelativeUrl: '/x/Dade 23 Preliminary NAL 2026.zip', Length: '61000000', TimeLastModified: '2026-07-27T14:00:00Z' },
          { Name: 'Broward Preliminary NAL 2026.zip', ServerRelativeUrl: '/x/Broward Preliminary NAL 2026.zip', Length: '1', TimeLastModified: '2026-07-28T00:00:00Z' },
        ],
      });
    }) as typeof fetch;
    assert.deepEqual(await listFolder('2026F', fake), []);
    assert.equal((await listFolder('2026P', fake)).length, 2);

    const choice = await new DorRollSource(fake).latest('23', new Date('2026-10-13T00:00:00Z'));
    assert.equal(choice?.label, '2026 preliminary roll');
    assert.equal(choice?.fileDate, '2026-07-27');
    assert.equal(await new DorRollSource(fake).latest('60', new Date('2026-10-13T00:00:00Z')), null);
  });

  it('fails clearly on portal errors', async () => {
    const fake = (async () => new Response('blocked', { status: 403 })) as typeof fetch;
    await assert.rejects(listFolder('2026P', fake), /HTTP 403/);
  });

  it('downloads the archive and streams its rows, cleaning up after itself', async () => {
    const bytes = readFileSync(zipPath);
    let requested = '';
    const fake = (async (url: string | URL | Request) => {
      requested = String(url);
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const rows: string[][] = [];
    await new DorRollSource(fake).rows(
      {
        file: { name: 'Dade 23 Preliminary NAL 2026.zip', serverRelativeUrl: '/x/Dade 23 Preliminary NAL 2026.zip', length: 1, lastModified: '' },
        year: 2026,
        stage: 'preliminary',
        label: '2026 preliminary roll',
        fileDate: '2026-07-27',
      },
      (r) => rows.push(r),
    );
    assert.equal(requested, 'https://floridarevenue.com/x/Dade%2023%20Preliminary%20NAL%202026.zip');
    assert.equal(rows.length, 3);
  });
});
