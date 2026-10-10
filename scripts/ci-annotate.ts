/**
 * Turn failed tests in a node:test JUnit report into GitHub annotations, so
 * failures are readable from the pull request's checks without opening logs.
 *
 *   node scripts/ci-annotate.ts test-results.xml
 */
import { readFileSync } from 'node:fs';

function unescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Escape for a workflow command message (newlines become %0A). */
function cmd(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
}

export function failures(xml: string): { name: string; message: string }[] {
  const out: { name: string; message: string }[] = [];
  const re = /<testcase\b[^>]*\bname="([^"]*)"[^>]*>\s*<failure\b[^>]*?(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/failure>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const body = unescape(m[3] ?? '').trim().split('\n').slice(0, 12).join('\n');
    out.push({ name: unescape(m[1] ?? ''), message: unescape(m[2] ?? '') + (body ? `\n${body}` : '') });
  }
  return out;
}

const file = process.argv[2];
if (file) {
  for (const f of failures(readFileSync(file, 'utf8')).slice(0, 20)) {
    console.log(`::error title=${cmd(f.name.slice(0, 120))}::${cmd(f.message.slice(0, 1500))}`);
  }
}
