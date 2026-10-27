import type { DiscoveryView } from '@gencut/services';
import Link from 'next/link';
import { discoveryHeadline } from '../../../lib/discovery-copy.ts';
import { AutoRefresh } from './auto-refresh.tsx';

export function DiscoveryStatusPanel({ view, countyName, headingLevel = 2 }: { view: DiscoveryView; countyName: string; headingLevel?: 1 | 2 }) {
  const h = discoveryHeadline(view, countyName);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <section aria-live="polite" className="rounded-panel bg-glass p-6">
      {h.working && <AutoRefresh />}
      <div className="flex items-center gap-3">
        {h.working && <span aria-hidden="true" className="rec-dot size-2.5 rounded-full bg-flamingo" />}
        <Heading className={`display font-semibold ${headingLevel === 1 ? 'text-3xl sm:text-4xl' : 'text-2xl'}`}>{h.title}</Heading>
      </div>
      <p className="mt-2 max-w-[65ch] text-ink-soft">{h.body}</p>
      {h.action && (
        <Link href={h.action.href} className="mt-4 inline-flex h-11 items-center rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep">
          {h.action.label}
        </Link>
      )}
    </section>
  );
}
