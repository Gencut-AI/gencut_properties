import { getCampaign, isServiceError } from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../lib/db.ts';
import { requireSession } from '../../../../lib/session.ts';
import { retryCampaignAction } from '../../_campaign/actions.ts';
import { CAMPAIGN_STATUS_LABEL, CHANNEL_LABEL } from '../../_campaign/labels.ts';
import { LetterEditor } from '../../_campaign/letter-editor.tsx';
import { AutoRefresh } from '../../_discovery/auto-refresh.tsx';

export const metadata: Metadata = { title: 'Campaign' };

const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, workspace } = await requireSession();
  const { id } = await params;
  const c = await getCampaign(db(), ctx, workspace.workspaceId, id).catch((e: unknown) => {
    if (isServiceError(e) && e.code === 'not_found') notFound();
    throw e;
  });
  const d = c.draft;
  // A draft that has been "writing" for over two minutes most likely never started.
  const stuck = c.status === 'generating' && Date.now() - c.updatedAt.getTime() > 2 * 60_000;

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8">
      {c.opportunityId && (
        <Link href={`/opportunities/${c.opportunityId}`} className="min-h-11 content-center text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
          ← Opportunity
        </Link>
      )}
      <header>
        <p className="text-sm font-medium text-ink-soft">
          Direct-mail campaign · {CAMPAIGN_STATUS_LABEL[c.status]}
        </p>
        <h1 className="display mt-1 text-3xl font-bold sm:text-4xl">{c.title}</h1>
        <p className="mt-3 rounded-xl bg-glass px-4 py-3 text-sm">
          Nothing has been sent. Approving and mailing letters arrive in a later release, after compliance review.
        </p>
      </header>

      {c.status === 'generating' && (
        <section aria-live="polite" className="rounded-panel border border-glass-deep p-6">
          {!stuck && <AutoRefresh seconds={5} />}
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="rec-dot size-2.5 rounded-full bg-flamingo" />
            <h2 className="display text-xl font-semibold">{stuck ? 'This draft has not started' : 'Writing your campaign…'}</h2>
          </div>
          <p className="mt-2 text-ink-soft">
            {stuck
              ? 'The writing job did not report back. You can start it again; you will not be charged twice for a finished draft.'
              : 'Usually 15–40 seconds. GenCut writes the strategy, the letter and a follow-up plan, then checks every fact and phrase.'}
          </p>
          {stuck && (
            <form action={retryCampaignAction} className="mt-4">
              <input type="hidden" name="campaignId" value={c.id} />
              <input type="hidden" name="restart" value="1" />
              <button type="submit" className="h-11 rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep">
                Start writing again
              </button>
            </form>
          )}
        </section>
      )}

      {c.status === 'generation_failed' && (
        <section className="rounded-panel border border-[#e7b3c0] bg-[#fdf4f6] p-6">
          <h2 className="display text-xl font-semibold">
            {c.problems.length > 0 ? 'The draft did not pass GenCut’s checks' : 'The draft could not be written'}
          </h2>
          <p className="mt-2 text-ink-soft">{c.error}</p>
          {c.problems.length > 0 && (
            <ul className="mt-3 list-disc pl-5 text-sm">
              {c.problems.map((p) => (
                <li key={p.message}>{p.message}</li>
              ))}
            </ul>
          )}
          <form action={retryCampaignAction} className="mt-4">
            <input type="hidden" name="campaignId" value={c.id} />
            <button type="submit" className="h-11 rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep">
              Try again
            </button>
          </form>
        </section>
      )}

      {d && (
        <>
          <section aria-labelledby="strategy" className="rounded-panel bg-glass p-6">
            <h2 id="strategy" className="display text-xl font-semibold">
              Strategy
            </h2>
            <p className="mt-3">{d.strategy.summary}</p>
            <p className="mt-2 text-ink-soft">
              <span className="font-medium text-ink">Angle:</span> {d.strategy.angle}
            </p>
            {d.strategy.reasons.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-[0.95rem]">
                {d.strategy.reasons.map((r) => (
                  <li key={r.text}>{r.text}</li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="letter">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="letter" className="display text-xl font-semibold">
                Letter
              </h2>
              <span className="text-sm text-ink-soft">{c.letterState === 'DRAFT' ? 'Draft · not approved · not sent' : c.letterState}</span>
            </div>
            <div className="mt-4 rounded-panel border border-glass-deep bg-white p-6 font-[Georgia,serif] text-[1.02rem] leading-relaxed shadow-sm sm:p-10">
              <p>{d.letter.greeting}</p>
              {d.letter.paragraphs.map((p) => (
                <p key={p} className="mt-4">
                  {p}
                </p>
              ))}
              <p className="mt-6">{d.letter.closing}</p>
              <div className="mt-2">
                {d.letter.signature.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
            {c.status === 'review' && (
              <details className="mt-4 rounded-panel border border-glass-deep p-4">
                <summary className="min-h-11 cursor-pointer content-center font-medium">Edit the letter</summary>
                <div className="mt-4">
                  <LetterEditor
                    campaignId={c.id}
                    greeting={d.letter.greeting}
                    paragraphs={d.letter.paragraphs}
                    closing={d.letter.closing}
                    signature={d.letter.signature}
                  />
                </div>
              </details>
            )}
          </section>

          <section aria-labelledby="followup">
            <h2 id="followup" className="display text-xl font-semibold">
              Follow-up plan
            </h2>
            <ol className="mt-3 grid gap-2">
              {d.followUp.map((s) => (
                <li key={`${s.day}-${s.action}`} className="grid grid-cols-[5.5rem_1fr] gap-3 rounded-xl border border-glass-deep p-3">
                  <span className="text-sm font-medium text-bay-deep">
                    Day {s.day}
                    <span className="block font-normal text-ink-soft">{CHANNEL_LABEL[s.channel]}</span>
                  </span>
                  <span>{s.action}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-sm text-ink-soft">Call reminders are only for owners you have a lawful basis to call; GenCut will check before any call task is offered.</p>
          </section>
        </>
      )}

      {c.facts.length > 0 && (
        <section aria-labelledby="facts" className="rounded-panel border border-glass-deep p-6 text-sm">
          <h2 id="facts" className="font-semibold">
            Facts the writer was allowed to use
          </h2>
          <dl className="mt-3 grid gap-1.5">
            {c.facts.map((f) => (
              <div key={f.key} className="grid grid-cols-[minmax(9rem,35%)_1fr] gap-3">
                <dt className="text-ink-soft">{f.label}</dt>
                <dd>
                  {f.value}
                  <span className="text-ink-soft"> · {f.source === 'public_record' ? 'public record' : 'your profile'}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-ink-soft">
            Every figure in the draft must match one of these, and the draft is checked for fair-housing, hardship and pressure wording before you see it.
          </p>
        </section>
      )}

      {c.usage.calls > 0 && (
        <p className="text-xs text-ink-soft">
          Written by {c.usage.models.join(', ') || 'the configured model'} · {c.usage.calls} call{c.usage.calls === 1 ? '' : 's'}
          {c.usage.failedCalls ? ` (${c.usage.failedCalls} failed)` : ''} · {(c.usage.inputTokens + c.usage.outputTokens).toLocaleString('en-US')} tokens ·{' '}
          {usd(c.usage.costUsd)} · {(c.usage.latencyMs / 1000).toFixed(1)} s · prompt {c.promptVersion}
        </p>
      )}
    </article>
  );
}
