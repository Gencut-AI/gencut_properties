import { FEED_VIEWS, type FeedView, MARKETS, countOpportunities, getBusinessProfile, getDiscoveryStatus, listOpportunities } from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';
import { OpportunityCard } from '../_discovery/opportunity-card.tsx';
import { DiscoveryStatusPanel } from '../_discovery/status-panel.tsx';

export const metadata: Metadata = { title: 'Opportunities' };

const TABS: Record<FeedView, string> = { active: 'For you', saved: 'Saved', dismissed: 'Dismissed' };
const EMPTY: Record<FeedView, string> = {
  active: 'Nothing to review right now.',
  saved: 'Save an opportunity to keep it here.',
  dismissed: 'Dismissed opportunities appear here, in case you change your mind.',
};

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { ctx, workspace } = await requireSession();
  const id = workspace.workspaceId;
  const profile = await getBusinessProfile(db(), ctx, id);
  if (!profile) redirect('/onboarding');
  const { view: raw } = await searchParams;
  const view: FeedView = (FEED_VIEWS as readonly string[]).includes(raw ?? '') ? (raw as FeedView) : 'active';
  const [discovery, counts, items] = await Promise.all([
    getDiscoveryStatus(db(), ctx, id),
    countOpportunities(db(), ctx, id),
    listOpportunities(db(), ctx, id, { view }),
  ]);
  const county = MARKETS.find((m) => m.key === profile.market)?.label.replace(/ County$/, '') ?? profile.market;

  return (
    <div className="flex flex-col gap-8">
      <DiscoveryStatusPanel view={discovery} countyName={county} headingLevel={1} />

      <nav aria-label="Opportunity lists" className="-mb-2 flex gap-1 overflow-x-auto">
        {FEED_VIEWS.map((v) => (
          <Link
            key={v}
            href={v === 'active' ? '/opportunities' : `/opportunities?view=${v}`}
            aria-current={v === view ? 'page' : undefined}
            className={`flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium ${
              v === view ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {TABS[v]}
            <span className={`tabular-nums ${v === view ? 'text-paper/70' : 'text-ink-soft/70'}`}>{counts[v]}</span>
          </Link>
        ))}
      </nav>

      {items.length > 0 ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {items.map((o) => (
            <OpportunityCard key={o.id} o={o} />
          ))}
        </ul>
      ) : (
        <p className="rounded-panel border border-dashed border-glass-deep p-8 text-center text-ink-soft">{EMPTY[view]}</p>
      )}

      <p className="max-w-[70ch] text-sm text-ink-soft">
        Opportunities come from public property records and are ranked by an explained scoring rule, not a prediction. Public
        records allow GenCut to find and research these homes; contacting an owner needs your approval and a lawful basis for
        the channel.
      </p>
    </div>
  );
}
