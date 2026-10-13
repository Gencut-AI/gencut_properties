import type { OpportunitySummary } from '@gencut/services';
import Link from 'next/link';
import { formatMoneyShort } from '../../../lib/discovery-copy.ts';
import { Score } from './score.tsx';
import { TriageButtons } from './triage-buttons.tsx';

const SHORT_REASON: Record<string, string> = {
  absentee_owner: 'Absentee owner',
  out_of_state_owner: 'Owner out of state',
  long_held_strong: 'Held for many years',
  long_held: 'Long held',
  estate_owner: 'Estate',
  value_in_band: 'In your price range',
  value_out_of_band: 'Outside your price range',
  recent_purchase: 'Recently sold',
};

export function OpportunityCard({ o }: { o: OpportunitySummary }) {
  const chips = o.reasons.filter((r) => r.code !== 'in_focus' && SHORT_REASON[r.code]);
  return (
    <li className="rounded-panel border border-glass-deep bg-paper p-5 transition-colors hover:border-ink-soft/40">
      <div className="flex gap-4">
        <Score value={o.score} />
        <div className="min-w-0 flex-1">
          <Link href={`/opportunities/${o.id}`} className="block focus-visible:outline-offset-4">
            <h3 className="display truncate text-lg font-semibold">{o.address || `Parcel ${o.parcelId}`}</h3>
          </Link>
          <p className="mt-0.5 text-sm text-ink-soft">
            {[o.city, o.zip].filter(Boolean).join(' ')} · {o.propertyType} · {formatMoneyShort(o.justValue)}
          </p>
          <p className="mt-1 truncate text-sm">
            {o.ownerName}
            {o.ownerLocation && <span className="text-ink-soft"> · mail to {o.ownerLocation}</span>}
          </p>
          {chips.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Signals">
              {chips.map((r) => (
                <li
                  key={r.code}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${r.points < 0 ? 'bg-paper text-ink-soft ring-1 ring-glass-deep' : 'bg-glass text-bay-deep'}`}
                >
                  {SHORT_REASON[r.code]}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-glass pt-3">
        <Link href={`/opportunities/${o.id}`} className="min-h-11 content-center text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
          Why this one
        </Link>
        <TriageButtons id={o.id} status={o.status} compact />
      </div>
    </li>
  );
}
