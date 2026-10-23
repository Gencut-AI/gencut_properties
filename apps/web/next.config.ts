import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ['@gencut/core', '@gencut/services'],
  poweredByHeader: false,
  // Headshot uploads go through a server action; the service caps them at 3 MB.
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
  reactStrictMode: true,
  env: {
    GENCUT_VERSION: pkg.version,
    // Netlify sets COMMIT_REF; GitHub Actions sets GITHUB_SHA.
    GENCUT_COMMIT: process.env.COMMIT_REF ?? process.env.GITHUB_SHA ?? '',
    // Where sign-in emails link back to. Netlify sets CONTEXT, URL and
    // DEPLOY_PRIME_URL at build time; empty locally (request origin is used).
    GENCUT_SITE_URL:
      process.env.CONTEXT === 'production' ? (process.env.URL ?? '') : (process.env.DEPLOY_PRIME_URL ?? ''),
  },
};

export default config;
