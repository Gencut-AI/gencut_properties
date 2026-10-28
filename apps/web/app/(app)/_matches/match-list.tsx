import type { MatchReason } from '@gencut/core';
import Link from 'next/link';

export interface MatchRow {
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly subtitle: string;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

/** Seller–buyer matches, agent-only: why each fits, and what a match does not mean. */
export function MatchList({ heading, empty, rows }: { heading: string; empty: string; rows: readonly MatchRow[] }) {
  return (
    <section aria-labelledby="matches" className="rounded-panel border border-glass-deep p-6">
      <h2 id="matches" className="display text-xl font-semibold">
        {heading}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        A fit with past purchases on the county roll, for you to review. It is not a sign anyone is buying now, and it is not permission to
        contact either side. Only you see matches.
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 text-[0.95rem] text-ink-soft">{empty}</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-glass-deep p-4">
              <div className="flex items-baseline justify-between gap-3">
                <Link href={r.href} className="min-w-0 truncate font-medium text-bay-deep underline-offset-4 hover:underline">
                  {r.title}
                </Link>
                <span className="shrink-0 text-sm tabular-nums text-ink-soft">fit {r.score}</span>
              </div>
              <p className="mt-0.5 text-sm text-ink-soft">{r.subtitle}</p>
              <ul className="mt-2 grid gap-1 text-sm">
                {r.reasons.map((x) => (
                  <li key={x.code}>· {x.text}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
