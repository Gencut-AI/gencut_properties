import Link from 'next/link';
import { redirect } from 'next/navigation';
import { probeDatabase } from '../lib/db-probe.ts';
import { getHealth } from '../lib/health.ts';
import { healthEnv } from '../lib/runtime-env.ts';
import { AUTH_CALLBACK_PARAMS } from '../lib/site-url.ts';
import { currentUser } from '../lib/session.ts';

export const dynamic = 'force-dynamic';

const steps = [
  { title: 'Find', body: 'Homeowners likely to sell and companies that keep buying in your area, from public records, with the reasons spelled out.' },
  { title: 'Produce', body: 'A complete campaign for each one: strategy, letter, email, a social post with a neighborhood picture, and follow-ups.' },
  { title: 'Approve', body: 'Nothing goes out until you say so. Every message is checked against Florida and federal rules first.' },
] as const;

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // If Supabase falls back to the Site URL, finish the sign-in instead of
  // showing the landing page.
  const params = await searchParams;
  if (typeof params.code === 'string' || typeof params.token_hash === 'string' || typeof params.error_code === 'string') {
    const forward = new URLSearchParams({ next: '/home' });
    for (const key of AUTH_CALLBACK_PARAMS) {
      const v = params[key];
      if (typeof v === 'string') forward.set(key, v);
    }
    redirect(`/auth/confirm?${forward.toString()}`);
  }
  if (await currentUser()) redirect('/home');
  const health = await getHealth(healthEnv(), probeDatabase);

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-5 pb-10 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-10">
      <header className="flex items-center justify-between py-4">
        <span className="display text-xl font-semibold">GenCut</span>
        <Link href="/sign-in" className="flex min-h-11 items-center rounded-lg px-3 font-medium text-bay-deep hover:bg-glass">
          Sign in
        </Link>
      </header>

      <section className="mt-10 sm:mt-20">
        <h1 className="display max-w-[14ch] text-[clamp(2.6rem,9vw,5.75rem)] font-bold">
          Your marketing department, on call.
        </h1>
        <p className="mt-6 max-w-[56ch] text-lg text-ink-soft">
          GenCut finds the Miami homeowners likely to sell and the investors buying near you, prepares the campaign to reach
          them, and waits for your yes.
        </p>
        <Link
          href="/sign-in"
          className="mt-8 inline-flex h-14 items-center rounded-xl bg-bay px-8 text-lg font-semibold text-paper hover:bg-bay-deep"
        >
          Get started
        </Link>
      </section>

      <ol className="mt-14 grid gap-px overflow-hidden rounded-panel bg-glass-deep sm:grid-cols-3">
        {steps.map((s) => (
          <li key={s.title} className="bg-glass p-6">
            <h2 className="display text-2xl font-semibold text-bay-deep">{s.title}</h2>
            <p className="mt-2 text-[0.95rem] text-ink-soft">{s.body}</p>
          </li>
        ))}
      </ol>

      <footer className="mt-auto pt-14 text-sm text-ink-soft">
        <p>
          <Link href="/privacy" className="underline underline-offset-4 hover:text-ink">
            Privacy
          </Link>
          <span className="ml-3 text-xs">
            Version {health.version}
            {health.commit ? ` (${health.commit})` : ''}
          </span>
        </p>
      </footer>
    </main>
  );
}
