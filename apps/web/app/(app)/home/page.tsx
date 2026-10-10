import { MARKETS, getBusinessProfile, getPermissions } from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';
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
  const permissions = await getPermissions(db(), ctx, workspace.workspaceId);
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

      <section aria-labelledby="attention" className="rounded-panel bg-glass p-6">
        <h2 id="attention" className="display text-2xl font-semibold">
          Nothing needs you yet
        </h2>
        <p className="mt-2 max-w-[60ch] text-ink-soft">
          Opportunity discovery is the next part of GenCut being built. When it is switched on, homeowners in your ZIP codes
          worth a conversation will appear here, each with the public records behind it.
        </p>
      </section>

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
