/**
 * Read the real register file without a database and print aggregates only
 * (no names): how many records parse, their status and type, and how many list
 * a person as officer. Reads the first of the archive's ten files.
 *
 *   node apps/worker/src/registry-dry-run.ts
 */
import { parseSunbizRecord } from '@gencut/core';
import { SunbizSource } from './registry.ts';

const source = new SunbizSource();
const file = await source.latest();
if (!file) {
  console.error('[registry dry-run] no register file found');
  process.exit(1);
}
console.log(`[registry dry-run] ${file.sourceFile}, ${(file.bytes / 1e9).toFixed(2)} GB`);
let parsed = 0;
let invalid = 0;
let active = 0;
let withPerson = 0;
let withAgent = 0;
let badDates = 0;
const types = new Map<string, number>();
const started = Date.now();
const lines = await source.lines(
  file,
  (line) => {
    if (!line.trim()) return;
    const r = parseSunbizRecord(line);
    if (!r) {
      invalid++;
      return;
    }
    parsed++;
    if (r.status === 'active') active++;
    if (r.officers.some((o) => o.type === 'person')) withPerson++;
    if (r.registeredAgent) withAgent++;
    if (!r.filedOn) badDates++;
    types.set(r.filingType, (types.get(r.filingType) ?? 0) + 1);
  },
  { limitMembers: 1, log: (line) => console.log(`[registry dry-run] ${line}`) },
);
const pct = (n: number) => `${((n / Math.max(parsed, 1)) * 100).toFixed(1)}%`;
console.log(`[registry dry-run] ${lines} lines in ${Math.round((Date.now() - started) / 1000)} s: ${parsed} records, ${invalid} not records`);
console.log(`[registry dry-run] active ${pct(active)}, a person as officer ${pct(withPerson)}, registered agent ${pct(withAgent)}, no valid filing date ${pct(badDates)}`);
console.log(`[registry dry-run] types: ${[...types].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t} ${n}`).join(', ')}`);
if (parsed === 0 || invalid > parsed / 100) {
  console.error('[registry dry-run] the file does not look like the documented layout');
  process.exit(1);
}
