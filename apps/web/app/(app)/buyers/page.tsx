import {
  FEED_VIEWS,
  type FeedView,
  MARKETS,
  countBuyers,
  getBusinessProfile,
  getBuyerDiscoveryStatus,
  listBuyers,
  parseBuyerFilters,
} from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { formatDay } from '../../../lib/discovery-copy.ts';
import { requireSession } from '../../../lib/session.ts';
import { BuyerCard } from '../_buyers/buyer-card.tsx';
import { AutoRefresh } from '../_discovery/auto-refresh.tsx';

export const metadata: Metadata = { title: 'Buyers' };

const TABS: Record<FeedView, string> = { active: 'For you', saved: 'Saved', dismissed: 'Dismissed' };
const TYPES = [
  ['', 'Any home type'],
  ['single_family', 'Single family'],
  ['condo', 'Condo'],
  ['multifamily', 'Multifamily'],
  ['vacant_land', 'Vacant land'],
] as const;
const field = 'h-11 rounded-lg border border-glass-deep bg-white px-3 text-sm';

export default async function BuyersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx, workspace } = await requireSession();
  const id = workspace.workspaceId;
  const profile = await getBusinessProfile(db(), ctx, id);
  if (!profile) redirect('/onboarding');
  const params = await searchParams;
  const raw = typeof params.view === 'string' ? params.view : '';
  const view: FeedView = (FEED_VIEWS as readonly string[]).includes(raw) ? (raw as FeedView) : 'active';
  const filters = parseBuyerFilters(params);
  const filtering = Object.keys(filters).length > 0;
  const [status, counts, items] = await Promise.all([
    getBuyerDiscoveryStatus(db(), ctx, id),
    countBuyers(db(), ctx, id),
    listBuyers(db(), ctx, id, { view, filters }),
  ]);
  const county = MARKETS.find((m) => m.key === profile.market)?.label ?? profile.market;
  const working = status.status === 'pending' || status.status === 'scoring';

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="display text-4xl font-bold">Buyers</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          Companies that bought two or more homes in {county}, from qualified sales on the county roll
          {status.rollFileDate ? ` of ${formatDay(status.rollFileDate)}` : ''}. These are past purchases: they show what a company bought, not
          that it is buying now.
        </p>
        {working && (
          <p className="mt-3 rounded-xl bg-glass p-4 text-sm" role="status">
            <AutoRefresh seconds={20} />
            {status.importedFile
              ? 'Ranking buyers for your profile. This takes a minute.'
              : 'GenCut is reading this year’s county roll for company purchases. The first read can take a few minutes.'}
          </p>
        )}
        {status.status === 'failed' && (
          <p className="mt-3 rounded-xl border border-[#e7b3c0] bg-[#fdf4f6] p-4 text-sm" role="alert">
            Buyers could not be ranked: {status.error}
          </p>
        )}
        {status.status === 'ready' && status.eligible !== null && (
          <p className="mt-3 text-sm text-ink-soft">
            {status.eligible.toLocaleString('en-US')} companies qualified; the best {status.kept ?? 0} for your profile are shown.
          </p>
        )}
      </header>

      <nav aria-label="Buyer lists" className="-mb-2 flex gap-1 overflow-x-auto">
        {FEED_VIEWS.map((v) => (
          <Link
            key={v}
            href={v === 'active' ? '/buyers' : `/buyers?view=${v}`}
            aria-current={v === view ? 'page' : undefined}
            className={`flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium ${v === view ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'}`}
          >
            {TABS[v]}
            <span className={`tabular-nums ${v === view ? 'text-paper/70' : 'text-ink-soft/70'}`}>{counts[v]}</span>
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filter buyers">
        {view !== 'active' && <input type="hidden" name="view" value={view} />}
        <label className="grid gap-1 text-sm">
          ZIP bought in
          <input name="zip" inputMode="numeric" pattern="\d{5}" placeholder="Any" defaultValue={filters.zip ?? ''} className={`${field} w-28`} />
        </label>
        <label className="grid gap-1 text-sm">
          Home type
          <select name="type" defaultValue={filters.propertyUse ?? ''} className={field}>
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          At least
          <select name="min" defaultValue={String(filters.minPurchases ?? '')} className={field}>
            <option value="">2 purchases</option>
            <option value="3">3 purchases</option>
            <option value="5">5 purchases</option>
            <option value="10">10 purchases</option>
          </select>
        </label>
        <button type="submit" className="h-11 rounded-full bg-ink px-5 text-sm font-medium text-paper">
          Filter
        </button>
        {filtering && (
          <Link href={view === 'active' ? '/buyers' : `/buyers?view=${view}`} className="min-h-11 content-center text-sm text-bay-deep underline-offset-4 hover:underline">
            Clear
          </Link>
        )}
      </form>

      {items.length > 0 ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {items.map((b) => (
            <BuyerCard key={b.id} b={b} />
          ))}
        </ul>
      ) : (
        <p className="rounded-panel border border-glass-deep p-6 text-ink-soft">
          {filtering
            ? 'No buyers match these filters.'
            : view === 'active'
              ? working
                ? 'Buyers appear here once the county roll has been read.'
                : 'No companies with two or more purchases yet.'
              : view === 'saved'
                ? 'Save a buyer to keep it here.'
                : 'Dismissed buyers appear here, in case you change your mind.'}
        </p>
      )}
    </div>
  );
}
