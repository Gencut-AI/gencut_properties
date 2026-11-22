import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/session.ts';
import { googleSignInEnabled } from '../../lib/sign-in.ts';
import { signInWithGoogle } from './actions.ts';
import { SignInForm } from './sign-in-form.tsx';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/home');
  const { error } = await searchParams;
  const google = googleSignInEnabled({ GENCUT_GOOGLE_SIGNIN: process.env.GENCUT_GOOGLE_SIGNIN });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-10 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="py-4">
        <Link href="/" className="display text-xl font-semibold">
          GenCut
        </Link>
      </header>
      <section className="mt-10">
        <h1 className="display text-4xl font-bold">Sign in</h1>
        <p className="mt-3 text-ink-soft">{google ? 'Use your Google account, or we\'ll email you a link.' : 'We\'ll email you a link.'} No password to remember.</p>
        {error === 'link' && (
          <p className="mt-4 rounded-xl bg-[#fde7ec] p-4 text-sm text-[#7d1830]" role="alert">
            That sign-in link didn't work. It may have expired or been used already. Request a new email below; you can open its link on any
            device or type its code here.
          </p>
        )}
        {error === 'google' && (
          <p className="mt-4 rounded-xl bg-[#fde7ec] p-4 text-sm text-[#7d1830]" role="alert">
            Google sign-in didn't finish. Try again, or use your email instead.
          </p>
        )}
        {google && (
          <form action={signInWithGoogle} className="mt-8">
            <input type="hidden" name="next" value="/home" />
            <button
              type="submit"
              className="flex h-14 w-full items-center justify-center gap-3 rounded-xl border border-glass-deep bg-white text-lg font-semibold transition-colors hover:border-bay"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
                <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
                <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
                <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
                <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
              </svg>
              Continue with Google
            </button>
            <p className="mt-6 flex items-center gap-3 text-sm text-ink-soft" aria-hidden="true">
              <span className="h-px flex-1 bg-glass-deep" />
              or
              <span className="h-px flex-1 bg-glass-deep" />
            </p>
          </form>
        )}
        <div className={google ? 'mt-6' : 'mt-8'}>
          <SignInForm />
        </div>
      </section>
    </main>
  );
}
