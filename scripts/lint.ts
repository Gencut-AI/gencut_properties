/**
 * Repository rules that a general-purpose linter does not know about.
 * Runs locally and in CI (`pnpm lint`). CI additionally runs gitleaks.
 *
 * 1. No secrets in tracked files.
 * 2. No hard-coded model names in domain code: models are chosen by
 *    configuration through the ModelRouter (docs/decisions.md D-005).
 * 3. No console output from the domain package.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

export const SECRET_PATTERNS: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: 'openai-key', re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { rule: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
];

const MODEL_NAME = /\b(?:claude-(?:opus|sonnet|haiku|fable|mythos)|gpt-\d|o\d-(?:mini|pro)|gemini-\d)/i;

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  const isDomain = file.startsWith('packages/core/src/');
  lines.forEach((content, i) => {
    for (const { rule, re } of SECRET_PATTERNS) {
      if (re.test(content)) findings.push({ file, line: i + 1, rule });
    }
    if (isDomain && MODEL_NAME.test(content)) findings.push({ file, line: i + 1, rule: 'model-name-in-domain' });
    if (isDomain && /\bconsole\.(log|info|debug)\(/.test(content)) {
      findings.push({ file, line: i + 1, rule: 'console-in-domain' });
    }
  });
  return findings;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|mp4|mov|pdf|woff2?|ttf|zip)$/i;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => f && !BINARY.test(f));
}

function main(): void {
  const findings = trackedFiles().flatMap((f) => {
    try {
      return scanText(f, readFileSync(f, 'utf8'));
    } catch {
      return []; // deleted but still listed
    }
  });
  for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}`);
  if (findings.length) {
    console.error(`\n${findings.length} problem(s).`);
    process.exit(1);
  }
  console.log('lint: no problems');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
