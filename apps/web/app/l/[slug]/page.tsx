import type React from 'react';
import { leadSourceOf } from '@gencut/core';
import { getPublicLeadPage } from '@gencut/services';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { db } from '../../../lib/db.ts';
import { LeadForm } from './lead-form.tsx';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }>; searchParams: Promise<{ src?: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublicLeadPage(db(), slug);
  if (!page) return { title: 'Not found', robots: { index: false } };
  const where = page.zips[0] ? ` in ${page.zips[0]}` : ' in Miami';
  const title = `Buying or selling${where}? Ask ${page.agentName}`;
  const description = `${page.agentName}, ${page.brokerage}. Tell me what you’re planning and I’ll reply personally.`;
  return { title, description, openGraph: { title, description, type: 'website' }, twitter: { card: 'summary', title, description } };
}

/** An agent's public lead page: the link that goes in a social bio, post or ad (D-023). */
export default async function LeadPage({ params, searchParams }: Params) {
  const { slug } = await params;
  const { src } = await searchParams;
  const page = await getPublicLeadPage(db(), slug);
  if (!page) notFound();
  const h = await headers();
  const source = leadSourceOf(src, h.get('referer'));
  const firstName = page.agentName.split(' ')[0] ?? page.agentName;
  const initials = page.agentName
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const where = page.zips[0] ?? 'Miami';

  return (
    <main className="min-h-dvh bg-paper">
      <div className="bg-ink px-5 pb-28 pt-[max(2rem,env(safe-area-inset-top))] text-paper">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          <div className="rise flex items-center gap-3" style={{ '--i': 0 } as React.CSSProperties}>
            <span aria-hidden="true" className="grid size-14 place-items-center rounded-full bg-flamingo text-lg font-bold text-ink">
              {initials}
            </span>
            <span>
              <span className="block font-semibold">{page.agentName}</span>
              <span className="block text-sm text-glass-deep">{page.brokerage}</span>
            </span>
          </div>
          <h1 className="rise display text-4xl font-bold leading-tight sm:text-5xl" style={{ '--i': 1 } as React.CSSProperties}>
            Thinking about buying or selling in {where}?
          </h1>
          <p className="rise text-lg text-glass-deep" style={{ '--i': 2 } as React.CSSProperties}>
            Tell me what you’re planning. I’ll reply personally, with what’s happening on your street and what your options are.
          </p>
        </div>
      </div>
      <div className="mx-auto -mt-20 max-w-xl px-5 pb-12">
        <section aria-label={`Contact ${firstName}`} className="rise relative rounded-[1.75rem] border border-glass-deep bg-white p-6 shadow-[0_20px_60px_-30px_rgba(16,36,43,0.45)] sm:p-8" style={{ '--i': 3 } as React.CSSProperties}>
          <LeadForm slug={page.slug} source={source} firstName={firstName} zip={page.zips.length === 1 ? (page.zips[0] ?? '') : ''} consentText={page.consentText} />
        </section>
        <footer className="mt-6 flex flex-col gap-1 text-center text-xs text-ink-soft">
          <span>
            {page.agentName} · {page.brokerage}
            {page.licenseNumber ? ` · License ${page.licenseNumber}` : ''}
          </span>
          <span>Your details go only to {firstName}. They are never sold.</span>
        </footer>
      </div>
    </main>
  );
}
