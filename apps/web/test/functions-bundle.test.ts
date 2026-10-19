import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { bundleFunctions } from '../scripts/bundle-functions.ts';

const out = mkdtempSync(join(tmpdir(), 'gencut-functions-'));
after(() => rmSync(out, { recursive: true, force: true }));

describe('Netlify function bundles', () => {
  it('are self-contained: no workspace or TypeScript imports left for the runtime to resolve', async () => {
    const files = await bundleFunctions(out);
    assert.ok(files.some((f) => f.endsWith('generate-campaign-background.mjs')));
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      assert.doesNotMatch(code, /from\s*["']@gencut\//, `${f} still imports a workspace package`);
      assert.doesNotMatch(code, /from\s*["'][^"']+\.m?ts["']/, `${f} still imports a TypeScript file`);
    }
  });

  it('the drafting function loads and refuses to start without its settings, naming only which are missing', async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, db: process.env.DATABASE_URL };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DATABASE_URL;
    try {
      const mod = (await import(pathToFileURL(join(out, 'generate-campaign-background.mjs')).href)) as {
        default: (req: Request) => Promise<void>;
      };
      const req = new Request('https://example.test/.netlify/functions/generate-campaign-background', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaignId: '00000000-0000-4000-8000-000000000000' }),
      });
      await assert.rejects(() => mod.default(req), /did not start: .*"campaignId":true,"modelKeyConfigured":false,"databaseConfigured":false/);
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.db !== undefined) process.env.DATABASE_URL = saved.db;
    }
  });
});
