import { monthLabel } from '@gencut/core';
import { getBuyer, isServiceError, listOutcomes } from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { formatDay, formatMoney } from '../../../../lib/discovery-copy.ts';
import { db } from '../../../../lib/db.ts';
import { requireSession } from '../../../../lib/session.ts';
import { OutcomeForm } from '../../_campaign/outcome-form.tsx';
import { Score } from '../../_discovery/score.tsx';
import { TriageButtons } from '../../_discovery/triage-buttons.tsx';

export const metadata: Metadata = { title: 'Buyer' };

const STATUS_LABEL = { new: 'New', saved: 'Saved', dismissed: 'Dismissed', in_campaign: 'In a campaign' } as const;
const OUTCOME_LABEL: Record<string, string> = {
  contacted: 'Letter sent / contacted',
  no_response: 'No response',
  responded: 'Buyer responded',
  not_interested: 'Not interested',
  qualified_conversation: 'Qualified conversation',
  appointment: 'Meeting set',
  offer: 'Offer made',
  closed: 'Purchase closed',
  wrong_address: 'Wrong address',
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-3 border-b border-glass py-2.5 last:border-0">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="text-[0.95rem]">{children}</dd>
    </div>
  );
}

export default async function BuyerPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, workspace } = await requireSession();
  const { id } = await params;
  const b = await getBuyer(db(), ctx, workspace.workspaceId, id).catch((e: unknown) => {
    if (isServiceError(e) && e.code === 'not_found') notFound();
    throw e;
  });
  const outcomes = await listOutcomes(db(), ctx, workspace.workspaceId, b.id);
  const p = b.profile;
  const today = new Date().toISOString().slice(0, 10);
  const mailing = [p.mailing.address1, p.mailing.address2, [p.mailing.city, p.mailing.state, p.mailing.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const sources = [...new Set(b.purchases.map((x) => `${x.sourceFile}, file dated ${formatDay(x.fileDate)}`))];
  const spellings = [...new Set(b.purchases.map((x) => x.ownerNameOnRoll))];

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8">
      <Link href="/buyers" className="min-h-11 content-center text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
        ← Buyers
      </Link>

      <header className="flex items-start gap-5">
        <Score value={b.score} size="lg" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-soft">Investor buyer · {STATUS_LABEL[b.status]}</p>
          <h1 className="display mt-1 break-words text-3xl font-bold sm:text-4xl">{p.name}</h1>
          <p className="mt-1 text-ink-soft">
            {p.purchases} verified purchases · {monthLabel(p.first.year, p.first.month)} to {monthLabel(p.latest.year, p.latest.month)}
          </p>
        </div>
      </header>

      <TriageButtons id={b.id} status={b.status} />

      <section aria-labelledby="purchases">
        <h2 id="purchases" className="display text-xl font-semibold">
          Verified purchases
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Qualified (arm&rsquo;s-length) sales to this company recorded on the county tax roll. Check any of them by folio number in the
          Miami-Dade Property Appraiser&rsquo;s property search.
        </p>
        {b.missingPurchases > 0 && (
          <p className="mt-3 rounded-xl bg-glass p-4 text-sm" role="status">
            {b.missingPurchases} of the purchases this profile was built from are no longer on the current roll. The profile is rebuilt on the next
            run.
          </p>
        )}
        <ul className="mt-4 grid gap-3">
          {b.purchases.map((x) => (
            <li key={x.id} className="rounded-xl border border-glass-deep p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-medium">
                  {x.address || `Parcel ${x.parcelId}`}
                  <span className="font-normal text-ink-soft"> · {[x.city, x.zip].filter(Boolean).join(' ')}</span>
                </p>
                <p className="font-semibold tabular-nums">{formatMoney(x.price)}</p>
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                {monthLabel(x.saleYear, x.saleMonth)} · {x.homeType}
                {x.units && x.units > 1 ? ` · ${x.units} units` : ''}
                {x.livingArea ? ` · ${x.livingArea.toLocaleString('en-US')} sq ft` : ''}
                {x.yearBuilt ? ` · built ${x.yearBuilt}` : ''}
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Folio {x.parcelId} · qualification code {x.qualificationCode}
                {spellings.length > 1 ? ` · on the roll as “${x.ownerNameOnRoll}”` : ''}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pattern">
        <h2 id="pattern" className="display text-xl font-semibold">
          Pattern
        </h2>
        <p className="mt-1 text-sm text-ink-soft">Computed from the purchases above, nothing else.</p>
        <dl className="mt-3">
          <Fact label="ZIP codes bought in">{p.zips.map((z) => `${z.zip} (${z.count})`).join(', ')}</Fact>
          <Fact label="Home types">{p.homeTypes.map((t) => `${t.label} (${t.count})`).join(', ')}</Fact>
          <Fact label="Price paid">
            {formatMoney(p.price.min)} to {formatMoney(p.price.max)}, median {formatMoney(p.price.median)}
          </Fact>
          <Fact label="Tax mailing address">{mailing || '—'}</Fact>
          {spellings.length > 1 && <Fact label="Names on the roll">{spellings.join('; ')}</Fact>}
        </dl>
      </section>

      <section aria-labelledby="unknown" className="rounded-panel border border-glass-deep p-6">
        <h2 id="unknown" className="display text-xl font-semibold">
          What the records don&rsquo;t show
        </h2>
        <ul className="mt-3 grid list-disc gap-2 pl-5 text-[0.95rem]">
          <li>Whether this company is buying now. These are past purchases, not a sign of current intent.</li>
          <li>Other companies controlled by the same investor. Each company name is counted on its own.</li>
          <li>Purchases in other counties, or before {p.first.year}.</li>
          <li>Who to contact. The tax mailing address is where the county sends tax bills, not a confirmed contact.</li>
        </ul>
      </section>

      <section aria-labelledby="why" className="rounded-panel bg-glass p-6">
        <h2 id="why" className="display text-xl font-semibold">
          Why GenCut ranked this buyer
        </h2>
        <ul className="mt-4 grid gap-3">
          {b.reasons.map((r) => (
            <li key={r.code} className="grid grid-cols-[3.5rem_1fr] items-baseline gap-3">
              <span className="text-right font-semibold tabular-nums text-bay-deep">+{r.points}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-ink-soft">
          Score {b.score} of 100 from scoring rule {b.scoringVersion}. It ranks verified buying and how well it fits your profile. It is
          not the chance that this company will buy again, and its weights have not yet been checked against real outcomes.
        </p>
      </section>

      <section aria-labelledby="outcomes" className="rounded-panel border border-glass-deep p-6">
        <h2 id="outcomes" className="display text-xl font-semibold">
          What happened
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Record contact, conversations and deals. Buyer outcomes are reported apart from seller outcomes, to check each ranking on its own.
        </p>
        {outcomes.length > 0 && (
          <ul className="mt-4 grid gap-2 text-[0.95rem]">
            {outcomes.map((x) => (
              <li key={x.id} className="flex flex-wrap gap-x-3">
                <span className="font-medium">{OUTCOME_LABEL[x.outcome] ?? x.outcome}</span>
                <span className="text-ink-soft">{formatDay(x.occurredOn)}</span>
                {x.note && <span className="text-ink-soft">· {x.note}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <OutcomeForm opportunityId={b.id} today={today} kind="buyer" />
        </div>
      </section>

      <section aria-labelledby="source" className="rounded-panel border border-glass-deep p-6 text-sm">
        <h2 id="source" className="font-semibold">
          Source
        </h2>
        <p className="mt-2 text-ink-soft">
          Florida Department of Revenue name-address-legal (NAL) roll: {sources.join('; ') || `file dated ${formatDay(b.rollFileDate)}`}. Public
          record under Florida Statutes chapter 119.
        </p>
        <p className="mt-3 text-ink-soft">
          These records let GenCut find and research a buyer. They do not authorize contacting the company: any outreach needs your
          approval and a lawful basis for the channel.
        </p>
      </section>
    </article>
  );
}
