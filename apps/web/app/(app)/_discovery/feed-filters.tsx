import type { FeedFilters, FeedView } from '@gencut/services';
import Link from 'next/link';

const TYPES = [
  ['single_family', 'Single family'],
  ['condo', 'Condo'],
  ['multifamily', 'Multifamily'],
  ['vacant_land', 'Vacant land'],
] as const;
const OWNERS = [
  ['individual', 'Individual'],
  ['company', 'Company'],
  ['trust', 'Trust'],
  ['estate', 'Estate'],
] as const;
const VALUES = [250_000, 500_000, 750_000, 1_000_000, 2_000_000, 5_000_000] as const;
const SIGNALS = [
  ['absentee', 'Absentee owner'],
  ['out_of_state', 'Owner out of state'],
  ['long_held', 'Held 2+ years'],
  ['estate', 'Estate'],
] as const;

const short = (v: number) => (v >= 1_000_000 ? `$${v / 1_000_000}M` : `$${v / 1_000}K`);
const select = 'h-11 w-full rounded-lg border border-glass-deep bg-white px-3 text-[0.95rem]';

/** A plain GET form: works before JavaScript loads, and the URL is shareable. */
export function FeedFiltersForm({ view, filters, active }: { view: FeedView; filters: FeedFilters; active: boolean }) {
  const base = view === 'active' ? '/opportunities' : `/opportunities?view=${view}`;
  return (
    <details open={active} className="group rounded-panel border border-glass-deep p-4 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium">
        <span>Filter{active ? ' (on)' : ''}</span>
        <span aria-hidden="true" className="text-ink-soft transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <form method="get" action="/opportunities" className="mt-4 grid gap-4 sm:grid-cols-4">
        {view !== 'active' && <input type="hidden" name="view" value={view} />}
        <label className="grid gap-1 text-sm">
          Property type
          <select name="type" defaultValue={filters.propertyUse ?? ''} className={select}>
            <option value="">Any</option>
            {TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Owner of record
          <select name="owner" defaultValue={filters.ownerKind ?? ''} className={select}>
            <option value="">Any</option>
            {OWNERS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Value from
          <select name="min" defaultValue={filters.minValue ?? ''} className={select}>
            <option value="">Any</option>
            {VALUES.map((v) => (
              <option key={v} value={v}>
                {short(v)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Value to
          <select name="max" defaultValue={filters.maxValue ?? ''} className={select}>
            <option value="">Any</option>
            {VALUES.map((v) => (
              <option key={v} value={v}>
                {short(v)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="sm:col-span-4">
          <legend className="text-sm">Must show</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {SIGNALS.map(([k, l]) => (
              <label
                key={k}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-glass-deep bg-white px-4 text-sm has-[:checked]:border-bay has-[:checked]:bg-glass"
              >
                <input type="checkbox" name="signal" value={k} defaultChecked={filters.signals?.includes(k) ?? false} className="size-4 accent-[#0f6e73]" />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex items-center gap-4 sm:col-span-4">
          <button type="submit" className="h-11 rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep">
            Apply
          </button>
          {active && (
            <Link href={base} className="min-h-11 content-center text-sm font-medium text-bay-deep underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </form>
    </details>
  );
}
