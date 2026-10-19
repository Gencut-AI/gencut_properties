/**
 * Bundle each Netlify function in functions-src/ into one self-contained ES
 * module in netlify/functions/, which Netlify deploys as is.
 *
 * Why: the functions import GenCut's workspace packages, which are TypeScript
 * source. Netlify's own packaging leaves those imports in place and the
 * function fails at runtime with ERR_MODULE_NOT_FOUND (seen in production on
 * 14 and 19 Oct 2026, with and without `node_bundler = "esbuild"`). Bundling
 * here makes the deployed file independent of how Netlify packages it.
 *
 * Usage: node scripts/bundle-functions.ts [outDir]
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(webDir, 'functions-src');

export async function bundleFunctions(outDir: string = join(webDir, 'netlify', 'functions')): Promise<string[]> {
  const entries = readdirSync(srcDir).filter((f) => f.endsWith('.mts') || f.endsWith('.ts'));
  const outputs: string[] = [];
  for (const file of entries) {
    const outfile = join(outDir, file.replace(/\.m?ts$/, '.mjs'));
    await build({
      entryPoints: [join(srcDir, file)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      // Some dependencies call require() for Node built-ins; give the ES module one.
      banner: { js: "import { createRequire as __gencutCreateRequire } from 'node:module'; const require = __gencutCreateRequire(import.meta.url);" },
      logLevel: 'warning',
      legalComments: 'none',
    });
    outputs.push(outfile);
  }
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outs = await bundleFunctions(process.argv[2] ? resolve(process.argv[2]) : undefined);
  process.stdout.write(`bundled ${outs.length} function(s): ${outs.map((o) => o.slice(webDir.length + 1)).join(', ')}\n`);
}
