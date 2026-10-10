import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/session.ts';
import { SignInForm } from './sign-in-form.tsx';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/home');
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-10 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="py-4">
        <Link href="/" className="display text-xl font-semibold">
          GenCut
        </Link>
      </header>
      <section className="mt-10">
        <h1 className="display text-4xl font-bold">Sign in</h1>
        <p className="mt-3 text-ink-soft">We'll email you a link. No password to remember.</p>
        {error === 'link' && (
          <p className="mt-4 rounded-xl bg-[#fde7ec] p-4 text-sm text-[#7d1830]" role="alert">
            That sign-in link didn't work. It may have expired, been used already, or been opened in a different browser from the one you requested it in. Request a new one below and open it on this device.
          </p>
        )}
        <div className="mt-8">
          <SignInForm />
        </div>
      </section>
    </main>
  );
}
