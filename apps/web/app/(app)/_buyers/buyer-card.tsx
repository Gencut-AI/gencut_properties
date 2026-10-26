import { monthLabel } from '@gencut/core';
import type { BuyerSummary } from '@gencut/services';
import Link from 'next/link';
import { formatMoneyShort } from '../../../lib/discovery-copy.ts';
import { Score } from '../_discovery/score.tsx';
import { TriageButtons } from '../_discovery/triage-buttons.tsx';

/** A buyer in the list: who, how much verified buying, where and what, and when last. */
export function BuyerCard({ b }: { b: BuyerSummary }) {
  const p = b.profile;
  const zips = p.zips.slice(0, 3).map((z) => z.zip).join(', ') + (p.zips.length > 3 ? ` +${p.zips.length - 3}` : '');
  const types = p.homeTypes.map((t) => t.label.toLowerCase()).join(', ');
  return (
    <li className="rounded-panel border border-glass-deep bg-paper p-5 transition-colors hover:border-ink-soft/40">
      <div className="flex gap-4">
        <Score value={b.score} />
        <div className="min-w-0 flex-1">
          <Link href={`/buyers/${b.id}`} className="block focus-visible:outline-offset-4">
            <h3 className="display truncate text-lg font-semibold">{p.name}</h3>
          </Link>
          <p className="mt-0.5 text-sm">
            <span className="font-medium">{p.purchases} verified purchases</span>
            <span className="text-ink-soft">
              {' '}
              · {monthLabel(p.first.year, p.first.month)} to {monthLabel(p.latest.year, p.latest.month)}
            </span>
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {zips} · {types} · {formatMoneyShort(p.price.min)}–{formatMoneyShort(p.price.max)}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-glass pt-3">
        <Link href={`/buyers/${b.id}`} className="min-h-11 content-center text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
          See the purchases
        </Link>
        <TriageButtons id={b.id} status={b.status} compact />
      </div>
    </li>
  );
}
