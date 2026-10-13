/**
 * Plain-language status for the agent, from the discovery view. Pure, so the
 * wording is tested; every number comes from the database, never estimated.
 */
import type { DiscoveryView } from '@gencut/services';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('en-US');

export function formatMoney(v: number | null | undefined): string {
  return v == null ? '—' : usd.format(v);
}

/** "$1.2M", "$850K": for tight spaces. */
export function formatMoneyShort(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return usd.format(v);
}

export function formatCount(v: number): string {
  return count.format(v);
}

/** "27 Jul 2026" from YYYY-MM-DD, without time-zone drift. */
export function formatDay(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export type DiscoveryPhase = 'not_requested' | 'reading' | 'scoring' | 'ready' | 'failed';

export interface DiscoveryHeadline {
  readonly phase: DiscoveryPhase;
  readonly title: string;
  readonly body: string;
  /** Still working: the page should refresh itself. */
  readonly working: boolean;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function discoveryHeadline(v: DiscoveryView, countyName: string): DiscoveryHeadline {
  const reading = v.coverage.filter((c) => c.status === 'pending' || c.status === 'importing' || c.status === 'not_requested');
  const failedZips = v.coverage.filter((c) => c.status === 'failed').map((c) => c.zip);
  const failedNote = failedZips.length
    ? ` GenCut could not read the records for ${list(failedZips)} and will try again automatically.`
    : '';

  if (v.status === 'not_requested') {
    return {
      phase: 'not_requested',
      title: 'Discovery starts when your profile is saved',
      body: 'Save your profile and GenCut will start reading public records for your ZIP codes.',
      working: false,
    };
  }
  if (reading.length > 0) {
    return {
      phase: 'reading',
      title: 'Reading public records',
      body: `GenCut is reading the ${countyName} property roll for ${list(reading.map((c) => c.zip))}. This usually takes under 20 minutes; this page updates by itself.`,
      working: true,
    };
  }
  if (v.status === 'pending' || v.status === 'running') {
    return {
      phase: 'scoring',
      title: 'Scoring opportunities',
      body: `Records are in. GenCut is scoring every home in your focus area.${failedNote}`,
      working: true,
    };
  }
  if (v.status === 'failed') {
    return {
      phase: 'failed',
      title: 'Discovery hit a problem',
      body: `GenCut could not finish scoring your area. It retries automatically when your profile or the records change.${failedNote}`,
      working: false,
    };
  }
  const considered = v.parcelsConsidered ?? 0;
  const qualified = v.parcelsQualified ?? 0;
  const shown = v.opportunityCount ?? 0;
  const roll = v.coverage.find((c) => c.rollLabel)?.rollLabel;
  const source = roll ? `the Florida DOR ${roll}` : 'the Florida DOR roll';
  const body =
    considered === 0
      ? `No homes of your property types were found in your ZIP codes in ${source}.${failedNote}`
      : `${formatCount(considered)} homes in your focus area reviewed from ${source}. ${formatCount(qualified)} showed seller signals${
          qualified > shown ? `; the strongest ${formatCount(shown)} are here` : ''
        }.${failedNote}`;
  return { phase: 'ready', title: shown ? `${formatCount(shown)} opportunities` : 'No strong signals yet', body, working: false };
}
