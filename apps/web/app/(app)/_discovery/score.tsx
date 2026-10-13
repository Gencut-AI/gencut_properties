/** The score as a number with a ring, readable without colour. */
export function Score({ value, size = 'md' }: { value: number; size?: 'md' | 'lg' }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const px = size === 'lg' ? 'size-20 text-2xl' : 'size-14 text-lg';
  return (
    <div className={`relative grid shrink-0 place-items-center ${px}`} role="img" aria-label={`Score ${value} out of 100`}>
      <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="22" cy="22" r={r} fill="none" strokeWidth="4" className="stroke-glass-deep" />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          className="stroke-bay"
          strokeDasharray={`${(value / 100) * c} ${c}`}
        />
      </svg>
      <span className="display font-bold tabular-nums">{value}</span>
    </div>
  );
}
