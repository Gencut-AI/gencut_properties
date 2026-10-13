/** Markets GenCut serves, with the Florida DOR county number of each (see FL_COUNTIES in core). */
export const MARKETS = [
  { key: 'miami-dade', label: 'Miami-Dade County', countyCode: '23' },
  { key: 'broward', label: 'Broward County', countyCode: '16' },
  { key: 'palm-beach', label: 'Palm Beach County', countyCode: '60' },
] as const;
export type MarketKey = (typeof MARKETS)[number]['key'];

export function marketCountyCode(market: MarketKey): string {
  const m = MARKETS.find((x) => x.key === market);
  if (!m) throw new Error(`unknown market ${market}`);
  return m.countyCode;
}
