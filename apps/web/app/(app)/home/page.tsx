import { MARKETS, getBusinessProfile, getDiscoveryStatus, getPermissions, listOpportunities } from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';
import { OpportunityCard } from '../_discovery/opportunity-card.tsx';
import { DiscoveryStatusPanel } from '../_discovery/status-panel.tsx';
import { formatPriceBand } from '../_profile-form/values.ts';

export const metadata: Metadata = { title: 'Home' };

const TYPE_LABELS: Record<string, string> = {
  single_family: 'Single-family',
  condo: 'Condos',
  townhouse: 'Townhouses',
  multifamily: 'Multifamily',
  vacant_land: 'Land',
  other: 'Other',
};

function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(now));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export default async function HomePage() {
  const { ctx, workspace } = await requireSession();
  const profile = await getBusinessProfile(db(), ctx, workspace.workspaceId);
  if (!profile) redirect('/onboarding');
  const [permissions, discovery, top] = await Promise.all([
    getPermissions(db(), ctx, workspace.workspaceId),
    getDiscoveryStatus(db(), ctx, workspace.workspaceId),
    listOpportunities(db(), ctx, workspace.workspaceId, { limit: 3 }),
  ]);
  const contactOn = Object.entries(permissions.contact).filter(([, on]) => on).map(([c]) => c);
  const firstName = profile.licenseeName.split(' ')[0];
  const market = MARKETS.find((m) => m.key === profile.market)?.label ?? profile.market;
  const band = formatPriceBand(profile.minValue, profile.maxValue);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h1 className="display text-4xl font-bold sm:text-5xl">
          {greeting(new Date())}, {firstName}
        </h1>
        <p className="mt-3 text-ink-soft">{profile.brokerageName}</p>
      </section>

      <div className="flex flex-col gap-4">
        <DiscoveryStatusPanel view={discovery} countyName={market.replace(/ County$/, '')} />
        {top.length > 0 && (
          <section aria-labelledby="top" className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="top" className="display text-xl font-semibold">
                Strongest right now
              </h2>
              <Link href="/opportunities" className="min-h-11 content-center text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
                See all
              </Link>
            </div>
            <ul className="grid gap-4 lg:grid-cols-3">
              {top.map((o) => (
                <OpportunityCard key={o.id} o={o} />
              ))}
            </ul>
          </section>
        )}
      </div>

      <section aria-labelledby="focus" className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-panel border border-glass-deep p-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="focus" className="display text-xl font-semibold">
              Where GenCut will look
            </h2>
            <Link href="/profile" className="min-h-11 text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
              Edit
            </Link>
          </div>
          <dl className="mt-4 grid gap-3 text-[0.95rem]">
            <div>
              <dt className="text-sm text-ink-soft">Market</dt>
              <dd>{market}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">ZIP codes</dt>
              <dd>{profile.focusZips.join(', ')}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">Property types</dt>
              <dd>{profile.propertyUses.map((u) => TYPE_LABELS[u] ?? u).join(', ')}</dd>
            </div>
            {band && (
              <div>
                <dt className="text-sm text-ink-soft">Price range</dt>
                <dd>{band}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="rounded-panel border border-glass-deep p-6">
          <h2 className="display text-xl font-semibold">What GenCut may do</h2>
          <ul className="mt-4 grid gap-3 text-[0.95rem]">
            <li>{permissions.discover ? 'Find opportunities from public records: on' : 'Find opportunities: off'}</li>
            <li>{permissions.generate ? 'Prepare campaigns and media: on' : 'Prepare campaigns: off'}</li>
            <li>
              {contactOn.length
                ? `Contact people for you: ${contactOn.join(', ')}`
                : 'Contact anyone for you: off. GenCut prepares outreach for your approval and sends nothing on its own.'}
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
