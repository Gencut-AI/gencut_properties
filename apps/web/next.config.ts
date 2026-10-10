import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ['@gencut/core', '@gencut/services'],
  poweredByHeader: false,
  reactStrictMode: true,
  env: {
    GENCUT_VERSION: pkg.version,
    // Netlify sets COMMIT_REF; GitHub Actions sets GITHUB_SHA.
    GENCUT_COMMIT: process.env.COMMIT_REF ?? process.env.GITHUB_SHA ?? '',
  },
};

export default config;
