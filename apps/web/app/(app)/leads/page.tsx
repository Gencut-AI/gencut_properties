import type React from 'react';
import { monthLabel } from '@gencut/core';
import {
  type BuyerSummary,
  getBusinessProfile,
  getBuyerDiscoveryStatus,
  getDiscoveryStatus,
  getLeadsOverview,
  type LeadOutreach,
  listBuyers,
  listOpportunities,
  MARKETS,
  matchesForBuyer,
  matchesForSeller,
  type OpportunitySummary,
} from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { draftingEnabled } from '../../../lib/background.ts';
import { db } from '../../../lib/db.ts';
import { formatCount } from '../../../lib/discovery-copy.ts';
import { emailConfig } from '../../../lib/email.ts';
import { requireSession } from '../../../lib/session.ts';
import { startCampaignAction } from '../_campaign/actions.ts';
import { AutoRefresh } from '../_discovery/auto-refresh.tsx';
import { CountUp } from './count-up.tsx';

export const metadata: Metadata = { title: 'Leads' };

interface Lead {
  readonly id: string;
  readonly kind: 'seller' | 'buyer';
  readonly href: string;
  readonly title: string;
  readonly detail: string;
  readonly why: string;
  readonly score: number;
  readonly status: string;
  readonly updatedAt: Date;
  readonly outreach: LeadOutreach | undefined;
}

const fromSeller = (o: OpportunitySummary, outreach: LeadOutreach | undefined): Lead => ({
  id: o.id,
  kind: 'seller',
  href: `/opportunities/${o.id}`,
  title: o.address,
  detail: `${o.propertyType} · ${o.zip} · owner ${o.ownerName}`,
  // The focus-area reason is true of every lead here; show what sets this one apart.
  why: o.reasons.filter((r) => !/focus area/i.test(r.text)).map((r) => r.text.replace(/\.$/, '')).slice(0, 2).join(' · '),
  score: o.score,
  status: o.status,
  updatedAt: o.updatedAt,
  outreach,
});

const fromBuyer = (b: BuyerSummary, outreach: LeadOutreach | undefined): Lead => {
  const p = b.profile;
  const zips = p.zips.slice(0, 3).map((z) => z.zip).join(', ') + (p.zips.length > 3 ? ` +${p.zips.length - 3}` : '');
  return {
    id: b.id,
    kind: 'buyer',
    href: `/buyers/${b.id}`,
    title: p.name,
    detail: `Investor · ${p.purchases} verified purchases · latest ${monthLabel(p.latest.year, p.latest.month)}`,
    why: `Buys ${p.homeTypes.map((t) => t.label.toLowerCase()).slice(0, 2).join(' and ')} in ${zips}`,
    score: b.score,
    status: b.status,
    updatedAt: b.updatedAt,
    outreach,
  };
};

function stateChip(l: Lead): { label: string; className: string } {
  if (l.outreach === 'emailed') return { label: 'Emailed', className: 'bg-ink text-paper' };
  if (l.outreach === 'campaign') return { label: 'In campaign', className: 'bg-bay text-paper' };
  if (l.status === 'saved') return { label: 'Saved', className: 'bg-glass text-bay-deep' };
  return { label: 'Shortlisted', className: 'bg-[#fde4ea] text-[#8a1d3a]' };
}

const AGENTS = [
  { n: '01', name: 'Finder', does: 'Scans the county property roll and recorded sales for your ZIP codes.', live: true },
  { n: '02', name: 'Researcher', does: 'Pulls the facts: type, year built, size, value and sale history.', live: true },
  { n: '03', name: 'Signal Hunter', does: 'Finds reasons to act: out-of-state owners, no homestead, repeat buyers.', live: true },
  { n: '04', name: 'Enricher', does: 'Finds a lawful way to reach them. Mailing address today; email and phone from consented sources next.', live: false },
  { n: '05', name: 'Qualifier', does: 'Keeps only real fits. Everyone else is skipped and never contacted.', live: true },
  { n: '06', name: 'Prioritizer', does: 'Scores, ranks and matches investors to the homes that fit them.', live: true },
] as const;

/** The six stages each lead has been through: Enricher is partial until contact enrichment exists. */
function Stages({ i }: { i: number }) {
  return (
    <span aria-hidden="true" className="mt-2 flex gap-1">
      {AGENTS.map((a, s) =>
        a.live ? (
          <span key={a.n} className="stage-fill h-1.5 w-6 rounded-full bg-bay" style={{ '--i': i, '--s': s } as React.CSSProperties} />
        ) : (
          <span key={a.n} className="h-1.5 w-6 rounded-full border border-dashed border-ink-soft" />
        ),
      )}
    </span>
  );
}

/** Rise-in order for an item. */
const at = (i: number) => ({ '--i': i }) as React.CSSProperties;

export default async function LeadsPage() {
  const { ctx, workspace } = await requireSession();
  const ws = workspace.workspaceId;
  const profile = await getBusinessProfile(db(), ctx, ws);
  if (!profile) redirect('/onboarding');
  const [sellers, buyers, discovery, buyerStatus, overview] = await Promise.all([
    listOpportunities(db(), ctx, ws, { limit: 60 }),
    listBuyers(db(), ctx, ws, { limit: 60 }),
    getDiscoveryStatus(db(), ctx, ws),
    getBuyerDiscoveryStatus(db(), ctx, ws),
    getLeadsOverview(db(), ctx, ws),
  ]);
  const leads = [...sellers.map((o) => fromSeller(o, overview.outreach[o.id])), ...buyers.map((b) => fromBuyer(b, overview.outreach[b.id]))];
  const shortlist = [...leads].filter((l) => !l.outreach).sort((a, b) => b.score - a.score).slice(0, 6);
  const feed = [...leads].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.score - a.score).slice(0, 8);
  // Seller ↔ investor fit for the shortlist, from the same records (match-v1).
  const fits = await Promise.all(
    shortlist.map((l) =>
      (l.kind === 'seller' ? matchesForSeller(db(), ctx, ws, l.id, 50) : matchesForBuyer(db(), ctx, ws, l.id, 50)).then((m) => m.length),
    ),
  );

  const county = (MARKETS.find((m) => m.key === profile.market)?.label ?? profile.market).replace(/ County$/, '');
  const working = discovery.status === 'pending' || discovery.status === 'running' || buyerStatus.status === 'pending' || buyerStatus.status === 'scoring';
  const considered = discovery.parcelsConsidered;
  const qualified = discovery.parcelsQualified;
  const ranAt = discovery.finishedAt
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(discovery.finishedAt)
    : null;
  const canDraft = draftingEnabled();
  const emailOn = emailConfig() !== null;

  const stats = [
    { label: 'Homes scanned', value: overview.countyHomes, note: overview.countyZips ? `${county} roll, ${overview.countyZips} ZIP codes` : `${county} roll`, strong: false, href: null },
    { label: 'In your focus', value: considered, note: `ZIP ${profile.focusZips.join(', ')} · change in Profile`, strong: false, href: '/profile' },
    { label: 'Likely sellers', value: qualified, note: 'each with its reasons', strong: true, href: '/opportunities' },
    { label: 'Active investors', value: buyerStatus.kept, note: buyerStatus.eligible ? `kept of ${formatCount(buyerStatus.eligible)} repeat buyers` : 'repeat buyers in the county', strong: true, href: '/buyers' },
    { label: 'Skipped', value: considered !== null && qualified !== null ? considered - qualified : null, note: 'not a fit, never contacted', strong: false, href: null },
  ];
  const sources = [
    { name: `${county} property roll`, what: 'Every home, its owner of record and tax mailing address (Florida Dept. of Revenue).', state: 'Connected' },
    { name: 'Recorded sales', what: 'Deeds on the roll, used to find investors who keep buying.', state: 'Connected' },
    { name: 'Social media', what: 'Instagram and Facebook: people who comment on your posts, message you or fill in a lead form.', state: 'Not connected yet' },
  ];

  return (
    <div className="flex flex-col gap-8">
      {working && <AutoRefresh seconds={15} />}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.08em] text-bay-deep">Prospecting run · {county}</p>
          <h1 className="display mt-1 text-4xl font-bold sm:text-5xl">Leads</h1>
          <p className="mt-2 max-w-2xl text-ink-soft">
            Six agents, one workflow. Every lead arrives with the reason it is worth a call, and nobody is contacted until you approve.
          </p>
        </div>
        <span className="inline-flex min-h-9 items-center gap-2 rounded-full border border-glass-deep bg-white px-4 text-sm font-semibold">
          <span aria-hidden="true" className={`size-2 rounded-full ${working ? 'rec-dot bg-flamingo' : discovery.failed ? 'bg-[#b42345]' : 'bg-bay'}`} />
          {working ? 'Searching now…' : discovery.failed ? 'Last run failed' : ranAt ? `Updated ${ranAt}` : 'Waiting for the first run'}
        </span>
      </header>

      <section aria-label="Run totals" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s, i) => {
          const body = (
            <>
              <span className="text-xs font-bold uppercase tracking-[0.08em] text-ink-soft">{s.label}</span>
              <span className={`display text-3xl font-bold tabular-nums ${s.strong ? 'text-bay-deep' : ''}`}>{s.value === null ? '—' : <CountUp value={s.value} />}</span>
              <span className="text-sm text-ink-soft">{s.note}</span>
            </>
          );
          const box = 'rise flex h-full flex-col gap-1 rounded-panel border border-glass-deep bg-white p-4';
          return s.href ? (
            <Link key={s.label} href={s.href} className={`${box} transition-[border-color,transform] hover:-translate-y-0.5 hover:border-bay`} style={at(i)}>
              {body}
            </Link>
          ) : (
            <div key={s.label} className={box} style={at(i)}>
              {body}
            </div>
          );
        })}
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-labelledby="feed" className="flex min-w-0 flex-[999_1_520px] flex-col gap-3 rounded-panel border border-glass-deep bg-white p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="feed" className="text-xs font-bold uppercase tracking-[0.08em] text-ink-soft">Lead feed · latest</h2>
            <span className="text-sm text-ink-soft">
              {formatCount(overview.campaigns)} campaigns · {formatCount(overview.emailsSent)} emails sent
            </span>
          </div>
          {feed.length === 0 ? (
            <p className="text-ink-soft">No leads yet. They appear here as soon as the first run finishes.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {feed.map((l, i) => {
                const chip = stateChip(l);
                return (
                  <li key={l.id} className="rise" style={at(i + 5)}>
                    <Link
                      href={l.href}
                      className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-glass bg-paper p-3 hover:border-glass-deep"
                    >
                      <span
                        aria-hidden="true"
                        className={`grid size-10 place-items-center rounded-xl text-sm font-bold ${l.kind === 'seller' ? 'bg-[#fde4ea]' : 'bg-glass'}`}
                      >
                        {l.kind === 'seller' ? 'S' : 'B'}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{l.title}</span>
                        <span className="block truncate text-sm text-ink-soft">{l.detail}</span>
                        <span className="block truncate text-sm text-ink-soft">{l.why}</span>
                        <Stages i={i + 5} />
                      </span>
                      <span className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold ${chip.className}`}>{chip.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-4 pt-1 text-sm font-medium">
            <Link href="/opportunities" className="min-h-11 content-center text-bay-deep underline-offset-4 hover:underline">
              All sellers
            </Link>
            <Link href="/buyers" className="min-h-11 content-center text-bay-deep underline-offset-4 hover:underline">
              All investors
            </Link>
          </div>
        </section>

        <section aria-labelledby="shortlist" className="flex min-w-0 flex-[1_1_320px] flex-col gap-2 rounded-panel bg-ink p-5 text-paper">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="shortlist" className="text-xs font-bold uppercase tracking-[0.08em] text-glass-deep">
              Shortlist · ranked
            </h2>
            <span className="text-sm text-glass-deep">contact first</span>
          </div>
          {shortlist.length === 0 ? (
            <p className="text-glass-deep">Every lead here already has a campaign.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {shortlist.map((l, i) => (
                <li key={l.id} className="rise rounded-xl border border-white/15 bg-white/5 p-3 transition-colors hover:bg-white/10" style={at(i + 5)}>
                  <div className="grid grid-cols-[2rem_minmax(0,1fr)_2.75rem] items-center gap-3">
                    <span className="display text-lg font-bold text-glass-deep">#{i + 1}</span>
                    <Link href={l.href} className="min-w-0">
                      <span className="block truncate font-semibold">{l.title}</span>
                      <span className="block truncate text-sm text-glass-deep">{l.kind === 'seller' ? 'Likely seller' : 'Active investor'} · {l.why}</span>
                    </Link>
                    <span className="grid h-8 place-items-center rounded-lg bg-glass text-sm font-bold text-bay-deep" aria-label={`Score ${l.score}`}>
                      {l.score}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-glass-deep">
                      {(fits[i] ?? 0) > 0
                        ? l.kind === 'seller'
                          ? `${fits[i]} active investor${fits[i] === 1 ? '' : 's'} fit this home`
                          : `${fits[i]} of your likely sellers fit`
                        : ''}
                    </span>
                  {canDraft && (
                    <form action={startCampaignAction}>
                      <input type="hidden" name="opportunityId" value={l.id} />
                      {l.kind === 'buyer' && <input type="hidden" name="from" value="buyer" />}
                      <button type="submit" className="min-h-11 rounded-full bg-flamingo px-4 text-sm font-bold text-ink hover:bg-[#f27c99]">
                        Draft {l.kind === 'seller' ? 'a letter' : 'an introduction'}
                      </button>
                    </form>
                  )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="pt-1 text-center text-sm text-glass-deep">You review and approve every message before it goes out.</p>
        </section>
      </div>

      <section aria-labelledby="sources" className="flex flex-col gap-3">
        <h2 id="sources" className="text-xs font-bold uppercase tracking-[0.08em] text-ink-soft">
          Where leads come from
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {sources.map((src, i) => {
            const on = src.state === 'Connected';
            return (
              <li
                key={src.name}
                className={`rise flex flex-col gap-2 rounded-panel bg-white p-4 ${on ? 'border border-glass-deep' : 'border-2 border-dashed border-ink-soft'}`}
                style={at(i + 14)}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{src.name}</span>
                  <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${on ? 'bg-glass text-bay-deep' : 'bg-[#fde4ea] text-[#8a1d3a]'}`}>
                    {src.state}
                  </span>
                </span>
                <span className="text-sm leading-relaxed text-ink-soft">{src.what}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="workflow" className="flex flex-col gap-4 rounded-panel bg-glass p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="workflow" className="text-xs font-bold uppercase tracking-[0.08em] text-bay-deep">
            The workflow · every lead goes through all six
          </h2>
          <span className="flex gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-bay" />
              Live
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-full border-2 border-dashed border-ink" />
              Next
            </span>
          </span>
        </div>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AGENTS.map((a, i) => (
            <li key={a.n} className={`rise flex flex-col gap-2 rounded-panel bg-white p-4 ${a.live ? '' : 'border-2 border-dashed border-ink-soft'}`} style={at(i + 8)}>
              <span className="flex items-center justify-between">
                <span aria-hidden="true" className={`grid size-10 place-items-center rounded-full text-sm font-bold text-white ${a.live ? 'bg-bay' : 'bg-ink-soft'}`}>
                  {a.n}
                </span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${a.live ? 'bg-glass text-bay-deep' : 'bg-[#fde4ea] text-[#8a1d3a]'}`}>
                  {a.live ? 'Live' : 'Next'}
                </span>
              </span>
              <span className="display text-lg font-bold">{a.name}</span>
              <span className="text-sm leading-relaxed text-ink-soft">{a.does}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span className="text-bay-deep">Then the Film Crew takes over:</span>
          <span className="rounded-full bg-white px-3 py-2">Writes the letter</span>
          <span aria-hidden="true">→</span>
          <span className="rounded-full bg-white px-3 py-2">You approve</span>
          <span aria-hidden="true">→</span>
          <span className="rounded-full bg-white px-3 py-2">Compliance check</span>
          <span aria-hidden="true">→</span>
          <span className={`rounded-full px-3 py-2 ${emailOn ? 'bg-ink text-paper' : 'bg-white text-ink-soft'}`}>{emailOn ? 'Sent by email · tracked' : 'Email sending not set up'}</span>
        </div>
      </section>
    </div>
  );
}
