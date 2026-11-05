import { type BuyerProfile, monthLabel } from '@gencut/core';

/**
 * "Active buyer": several purchases close together, the latest recently
 * (buyer-v3). Readable without colour; the title says what it is based on.
 */
export function ActiveBadge({ streak }: { streak: BuyerProfile['streak'] }) {
  const span = streak
    ? `${streak.purchases} purchases from ${monthLabel(streak.from.year, streak.from.month)} to ${monthLabel(streak.to.year, streak.to.month)}`
    : 'Several recent purchases';
  return (
    <span
      title={`${span}. Recent buying on the records, not a confirmed plan to buy.`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#fde4ea] px-2.5 py-0.5 text-xs font-bold text-[#8a1d3a]"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-flamingo" />
      Active buyer
    </span>
  );
}
