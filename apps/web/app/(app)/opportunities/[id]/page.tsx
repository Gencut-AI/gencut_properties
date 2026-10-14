import { isQualifiedSale, ownerKindOf } from '@gencut/core';
import { getOpportunity, isServiceError } from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { formatDay, formatMoney } from '../../../../lib/discovery-copy.ts';
import { db } from '../../../../lib/db.ts';
import { requireSession } from '../../../../lib/session.ts';
import { Score } from '../../_discovery/score.tsx';
import { TriageButtons } from '../../_discovery/triage-buttons.tsx';

export const metadata: Metadata = { title: 'Opportunity' };

const OWNER_LABEL = { individual: 'individual', company: 'company', trust: 'trust', estate: 'estate' } as const;
const STATUS_LABEL = { new: 'New', saved: 'Saved', dismissed: 'Dismissed', in_campaign: 'In a campaign' } as const;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-3 border-b border-glass py-2.5 last:border-0">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="text-[0.95rem]">{children}</dd>
    </div>
  );
}

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, workspace } = await requireSession();
  const { id } = await params;
  const o = await getOpportunity(db(), ctx, workspace.workspaceId, id).catch((e: unknown) => {
    if (isServiceError(e) && e.code === 'not_found') notFound();
    throw e;
  });
  const p = o.parcel;
  const mailing = [p.owner.address1, p.owner.address2, [p.owner.city, p.owner.state, p.owner.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const legacy = p as typeof p & { sale?: (typeof p.sales)[number] | null };
  const sales = [...(p.sales ?? (legacy.sale ? [legacy.sale] : [])), ...(p.prior?.sales ?? [])]
    .filter((s, i, all) => all.findIndex((t) => t.year === s.year && t.month === s.month && t.price === s.price) === i)
    .sort((x, y) => y.year - x.year || (y.month ?? 0) - (x.month ?? 0));
  const monthName = (m: number) =>
    new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m - 1, 1)));
  const saleText = sales.length
    ? sales
        .map(
          (x) =>
            `${x.month ? `${monthName(x.month)} ` : ''}${x.year}${x.price ? ` for ${formatMoney(x.price)}` : ''}${
              isQualifiedSale(x.qualificationCode) ? '' : " (not an arm's-length sale)"
            }`,
        )
        .join('; ')
    : `None recorded on the ${p.prior ? 'last two rolls' : 'current roll'}`;
  const ownerKind = p.ownerKind ?? ownerKindOf(p.owner.name);

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8">
      <Link href="/opportunities" className="min-h-11 content-center text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
        ← Opportunities
      </Link>

      <header className="flex items-start gap-5">
        <Score value={o.score} size="lg" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-soft">
            Potential seller · {STATUS_LABEL[o.status]}
          </p>
          <h1 className="display mt-1 text-3xl font-bold sm:text-4xl">{o.address || `Parcel ${o.parcelId}`}</h1>
          <p className="mt-1 text-ink-soft">
            {[o.city, o.zip].filter(Boolean).join(' ')} · {o.propertyType}
          </p>
        </div>
      </header>

      <TriageButtons id={o.id} status={o.status} />

      <section aria-labelledby="why" className="rounded-panel bg-glass p-6">
        <h2 id="why" className="display text-xl font-semibold">
          Why GenCut picked this
        </h2>
        <ul className="mt-4 grid gap-3">
          {o.reasons.map((r) => (
            <li key={r.code} className="grid grid-cols-[3.5rem_1fr] items-baseline gap-3">
              <span className={`text-right font-semibold tabular-nums ${r.points < 0 ? 'text-ink-soft' : 'text-bay-deep'}`}>
                {r.points > 0 ? `+${r.points}` : r.points}
              </span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-ink-soft">
          Score {o.score} of 100 from scoring rule {o.scoringVersion}; {Math.round(o.confidence * 100)}% of the inputs it uses
          were present in the record. The score ranks signals in public records. It is not the chance that this owner will
          sell, and its weights have not yet been checked against real outcomes.
        </p>
      </section>

      <section aria-labelledby="record">
        <h2 id="record" className="display text-xl font-semibold">
          The public record
        </h2>
        <dl className="mt-3">
          <Fact label="Owner of record">
            {p.owner.name}
            <span className="text-ink-soft"> · {OWNER_LABEL[ownerKind]}</span>
          </Fact>
          <Fact label="Tax mailing address">{mailing || '—'}</Fact>
          <Fact label="Homestead exemption">{p.homestead ? 'Yes: the owner declared it their permanent home' : 'No'}</Fact>
          <Fact label="Market value (just value)">{formatMoney(p.justValue)}</Fact>
          <Fact label="Assessed value (non-school)">{formatMoney(p.assessedValue)}</Fact>
          {p.prior && (
            <Fact label={`${p.prior.year} final roll`}>
              Market {formatMoney(p.prior.justValue)}, assessed {formatMoney(p.prior.assessedValue)}
            </Fact>
          )}
          <Fact label="Sales on the roll">{saleText}</Fact>
          {p.yearBuilt && <Fact label="Year built">{p.yearBuilt}</Fact>}
          {p.livingArea && <Fact label="Living area">{p.livingArea.toLocaleString('en-US')} sq ft</Fact>}
          {p.units && p.units > 1 && <Fact label="Residential units">{p.units}</Fact>}
          <Fact label="Parcel">{p.parcelId}</Fact>
        </dl>
      </section>

      <section aria-labelledby="source" className="rounded-panel border border-glass-deep p-6 text-sm">
        <h2 id="source" className="font-semibold">
          Source
        </h2>
        <p className="mt-2 text-ink-soft">
          {o.source.name}
          {o.source.rollLabel ? `, ${o.source.rollLabel}` : ''}, file dated {formatDay(o.source.fileDate)}
          {p.assessmentYear ? ` (assessment year ${p.assessmentYear})` : ''}.
          {p.prior ? ` Last year's values and sales come from the department's ${p.prior.year} final roll.` : ''} Public record
          under Florida Statutes chapter 119.
        </p>
        <p className="mt-3 text-ink-soft">
          This record lets GenCut find and research the property. It does not authorize contacting the owner: any outreach
          needs your approval and a lawful basis for the channel, and stays within your contact permissions.
        </p>
      </section>
    </article>
  );
}
