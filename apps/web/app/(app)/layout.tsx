import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireSession } from '../../lib/session.ts';

// Every signed-in screen depends on the request's session; never prerender.
export const dynamic = 'force-dynamic';

// Only screens that exist are linked. Pipeline joins the navigation in the
// milestone that builds it.
const NAV = [
  { href: '/home', label: 'Home', short: 'Home' },
  { href: '/leads', label: 'Leads', short: 'Leads' },
  { href: '/opportunities', label: 'Opportunities', short: 'Sellers' },
  { href: '/buyers', label: 'Buyers', short: 'Buyers' },
  { href: '/campaigns', label: 'Campaigns', short: 'Campaigns' },
  { href: '/profile', label: 'Profile', short: 'Profile' },
] as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { workspace } = await requireSession();

  return (
    <div className="min-h-dvh pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
      <header className="sticky top-0 z-10 border-b border-glass-deep bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-10">
          <Link href="/home" className="display text-xl font-semibold">
            GenCut
          </Link>
          <nav aria-label="Main" className="hidden gap-6 sm:flex">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-ink-soft hover:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-ink-soft">
            <span className="hidden max-w-[16ch] truncate sm:inline">{workspace.workspaceName}</span>
            <form action="/auth/sign-out" method="post">
              <button type="submit" className="min-h-11 rounded-lg px-2 hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8 sm:px-10">{children}</main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-6 border-t border-glass-deep bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="flex h-16 items-center justify-center text-[0.75rem] font-medium">
            {n.short}
          </Link>
        ))}
      </nav>
    </div>
  );
}
