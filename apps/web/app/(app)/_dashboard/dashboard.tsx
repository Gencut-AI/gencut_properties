import type { AgentDashboard, DashboardAction, DashboardMonth, DashboardZip } from '@gencut/services';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatMoneyShort } from '../../../lib/discovery-copy.ts';

/**
 * The agent's dashboard pieces (D-029). Pure display: everything comes from
 * `getAgentDashboard`, so the Home page and previews render the same thing.
 */

const n = (v: number) => v.toLocaleString('en-US');
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string, long = false) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${long ? ym.slice(0, 4) : `’${ym.slice(2, 4)}`}`;

function Tile({ href, label, value, note, accent }: { href: string; label: string; value: ReactNode; note: ReactNode; accent?: boolean }) {
  return (
    <Link
      href={href}
      className={`group flex min-h-32 flex-col justify-between gap-3 rounded-panel border p-4 transition-colors sm:p-5 ${
        accent ? 'border-[#f4c4d0] bg-[#fdf4f6] hover:border-flamingo' : 'border-glass-deep bg-white hover:border-bay'
      }`}
    >
      <span className="text-sm font-medium text-ink-soft">{label}</span>
      <span className="display text-3xl font-bold tabular-nums sm:text-4xl">{value}</span>
      <span className="flex items-end justify-between gap-2 text-sm text-ink-soft">
        <span>{note}</span>
        <span aria-hidden="true" className="text-bay-deep transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </span>
    </Link>
  );
}

/** Six figures an agent checks first, each a door into its tab. */
export function DashboardTiles({ d }: { d: AgentDashboard }) {
  const c = d.counts;
  return (
    <section aria-label="Your pipeline" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Tile href="/opportunities" label="Seller leads" value={n(c.sellerLeads)} note="Owners likely to sell" />
      <Tile
        href="/buyers?active=1"
        label="Active buyers"
        value={n(c.activeBuyers)}
        note={`of ${n(c.buyers)} investor ${plural(c.buyers, 'buyer', 'buyers')}`}
        accent={c.activeBuyers > 0}
      />
      <Tile href="/campaigns" label="Letters to review" value={n(c.campaignsInReview)} note={`${n(c.campaigns)} ${plural(c.campaigns, 'campaign', 'campaigns')}`} />
      <Tile href="/campaigns" label="Emails sent" value={n(c.emailsSent)} note="Approved by you" />
      <Tile href="/leads#social" label="Social leads" value={n(c.socialLeads)} note={c.newSocialLeads ? `${n(c.newSocialLeads)} new` : 'From your lead page'} accent={c.newSocialLeads > 0} />
      <Tile href="/profile" label="WhatsApp" value={d.whatsappLinked ? 'On' : 'Off'} note={d.whatsappLinked ? 'Ask GenCut anytime' : 'Link your phone'} />
    </section>
  );
}

function actionText(a: DashboardAction): { title: string; detail: string } {
  const count = a.count ?? 0;
  switch (a.kind) {
    case 'review_letters':
      return { title: `Review ${n(count)} ${plural(count, 'letter', 'letters')} GenCut drafted`, detail: 'Nothing is sent until you approve it.' };
    case 'social_leads':
      return { title: `${n(count)} new ${plural(count, 'lead', 'leads')} from your lead page`, detail: 'They asked to be contacted. Reply while it’s fresh.' };
    case 'instagram':
      return { title: `${n(count)} Instagram ${plural(count, 'comment', 'comments')} asking for your link`, detail: 'Send each one your lead page in a private reply.' };
    case 'top_seller':
      return { title: `Strongest seller lead: ${a.subject ?? 'a home in your ZIP codes'}`, detail: `Score ${a.score ?? ''}. Draft a letter to the owner.` };
    case 'top_active_buyer':
      return { title: `Active buyer: ${a.subject ?? 'an investor company'}`, detail: `Score ${a.score ?? ''}. Recent repeat buying on the county records.` };
    case 'lead_page':
      return { title: 'Create your lead page', detail: 'One link for your Instagram and Facebook bio. Leads land here.' };
    case 'link_whatsapp':
      return { title: 'Link WhatsApp', detail: 'Ask GenCut for leads, letters and your share kit from your phone.' };
  }
}

/** What to do next, most useful first. */
export function NextActions({ actions }: { actions: readonly DashboardAction[] }) {
  return (
    <section aria-labelledby="next" className="flex flex-col gap-3 rounded-panel bg-ink p-5 text-paper sm:p-6">
      <h2 id="next" className="display text-xl font-semibold">
        Do next
      </h2>
      {actions.length === 0 ? (
        <p className="text-glass-deep">Nothing is waiting for you. GenCut keeps watching your ZIP codes.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {actions.map((a) => {
            const t = actionText(a);
            return (
              <li key={`${a.kind}-${a.href}`}>
                <Link href={a.href} className="flex items-center gap-4 rounded-xl bg-white/5 p-4 transition-colors hover:bg-white/10">
                  <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${a.count ? 'bg-flamingo' : 'bg-glass-deep'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold [overflow-wrap:anywhere]">{t.title}</span>
                    <span className="block text-sm text-glass-deep">{t.detail}</span>
                  </span>
                  <span aria-hidden="true" className="text-glass-deep">
                    →
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = [1, 2, 2.5, 5, 10].find((x) => x * p >= v) ?? 10;
  return f * p;
}

/** Company purchases in the agent's ZIP codes by month; months the roll is still filling in are muted. */
export function MarketBars({ months, lagMonths }: { months: readonly DashboardMonth[]; lagMonths: number }) {
  const max = niceMax(Math.max(0, ...months.map((m) => m.purchases)));
  const total = months.reduce((a, m) => a + m.purchases, 0);
  const every = Math.max(1, Math.ceil(months.length / 6));
  return (
    <figure className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={`${n(total)} homes bought by companies in your ZIP codes from ${months[0] ? monthLabel(months[0].month, true) : ''} to ${months.at(-1) ? monthLabel(months.at(-1)!.month, true) : ''}.`}
        className="relative grid h-44 grid-cols-[2.25rem_1fr]"
      >
        <div aria-hidden="true" className="flex flex-col justify-between pb-6 text-right text-xs tabular-nums text-ink-soft">
          <span className="-translate-y-1/2 pr-2">{n(max)}</span>
          <span className="-translate-y-1/2 pr-2">{n(max / 2)}</span>
          <span className="translate-y-1/2 pr-2">0</span>
        </div>
        <div className="relative flex flex-col">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between">
            <span className="border-t border-glass" />
            <span className="border-t border-glass" />
            <span className="border-t border-glass-deep" />
          </div>
          <div className="relative flex flex-1 items-end gap-[3px] pb-0">
            {months.map((m) => (
              <div key={m.month} className="group relative flex h-full flex-1 items-end">
                <div
                  title={`${monthLabel(m.month, true)}: ${n(m.purchases)} ${plural(m.purchases, 'home', 'homes')} bought by ${n(m.companies)} ${plural(m.companies, 'company', 'companies')}${m.filling ? ' (still filling in)' : ''}`}
                  className={`w-full rounded-t-[3px] transition-opacity group-hover:opacity-80 ${m.filling ? 'bg-glass-deep' : 'bg-bay'}`}
                  style={{ height: `${max ? (m.purchases / max) * 100 : 0}%`, minHeight: m.purchases ? 3 : 0 }}
                />
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="flex h-6 items-end gap-[3px] text-[0.7rem] text-ink-soft">
            {months.map((m, i) => (
              <span key={m.month} className="flex-1 overflow-visible whitespace-nowrap">
                {(months.length - 1 - i) % every === 0 ? monthLabel(m.month) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-sm bg-bay" />
          Homes bought by companies
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-sm bg-glass-deep" />
          Still filling in: deeds reach the county roll about {lagMonths} months late
        </span>
      </figcaption>
    </figure>
  );
}

/** The county's busiest ZIP codes for company purchases, the agent's own marked. */
export function ZipTable({ zips }: { zips: readonly DashboardZip[] }) {
  const max = Math.max(1, ...zips.map((z) => z.purchases));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[0.95rem] tabular-nums">
        <thead className="text-xs text-ink-soft">
          <tr className="border-b border-glass-deep">
            <th className="py-2 pr-3 font-medium">ZIP</th>
            <th className="py-2 pr-3 text-right font-medium">Homes bought</th>
            <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Companies</th>
            <th className="py-2 text-right font-medium">Median price</th>
          </tr>
        </thead>
        <tbody>
          {zips.map((z) => (
            <tr key={z.zip} className={`border-b border-glass last:border-0 ${z.yours ? 'bg-[#fdf4f6]' : ''}`}>
              <td className="py-2 pr-3">
                <span className="flex items-center gap-2">
                  {z.zip}
                  {z.yours && <span className="rounded-full bg-[#fde4ea] px-2 py-0.5 text-[0.7rem] font-bold text-[#8a1d3a]">Yours</span>}
                </span>
              </td>
              <td className="py-2 pr-3">
                <span className="flex items-center justify-end gap-2">
                  <span aria-hidden="true" className="hidden h-1.5 rounded-full bg-bay sm:block" style={{ width: `${Math.max(2, (z.purchases / max) * 56)}px` }} />
                  {n(z.purchases)}
                </span>
              </td>
              <td className="hidden py-2 pr-3 text-right sm:table-cell">{n(z.companies)}</td>
              <td className="py-2 text-right">{z.medianPrice ? formatMoneyShort(z.medianPrice) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The agent's market: buying in their ZIP codes, and where the county's companies buy. */
export function MarketSection({ d, lagMonths, rollLabel }: { d: AgentDashboard; lagMonths: number; rollLabel: string | null }) {
  const y = d.market.lastYear;
  return (
    <section aria-labelledby="market" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="market" className="display text-xl font-semibold">
          Your market
        </h2>
        {rollLabel && <p className="text-sm text-ink-soft">From the county roll of {rollLabel}</p>}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4 rounded-panel border border-glass-deep bg-white p-5 sm:p-6">
          <div>
            <h3 className="font-semibold">Companies buying in {d.zips.length === 1 ? `ZIP ${d.zips[0]}` : 'your ZIP codes'}</h3>
            <p className="mt-1 text-sm text-ink-soft">Homes bought by companies in qualified sales, by month of sale.</p>
          </div>
          <dl className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-glass/60 p-3">
              <dt className="text-xs text-ink-soft">Last 12 months</dt>
              <dd className="display text-2xl font-bold tabular-nums">{n(y.purchases)}</dd>
            </div>
            <div className="rounded-xl bg-glass/60 p-3">
              <dt className="text-xs text-ink-soft">Companies</dt>
              <dd className="display text-2xl font-bold tabular-nums">{n(y.companies)}</dd>
            </div>
            <div className="rounded-xl bg-glass/60 p-3">
              <dt className="text-xs text-ink-soft">Median price</dt>
              <dd className="display text-2xl font-bold tabular-nums">{y.medianPrice ? formatMoneyShort(y.medianPrice) : '—'}</dd>
            </div>
          </dl>
          {d.market.months.length > 0 ? (
            <MarketBars months={d.market.months} lagMonths={lagMonths} />
          ) : (
            <p className="text-sm text-ink-soft">Purchases appear here once the county roll has been read.</p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3 rounded-panel border border-glass-deep bg-white p-5 sm:p-6">
          <div>
            <h3 className="font-semibold">Where companies buy</h3>
            <p className="mt-1 text-sm text-ink-soft">The county’s busiest ZIP codes in the same 12 months, with yours. Median price leaves out multi-home deeds.</p>
          </div>
          {d.market.zips.length > 0 ? <ZipTable zips={d.market.zips} /> : <p className="text-sm text-ink-soft">No purchases on record yet.</p>}
          <Link href="/buyers?active=1" className="mt-auto min-h-11 content-center text-sm font-semibold text-bay-deep underline-offset-4 hover:underline">
            See the active buyers →
          </Link>
        </div>
      </div>
    </section>
  );
}
