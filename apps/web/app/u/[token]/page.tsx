import type { Metadata } from 'next';
import { unsubscribeAction } from './actions.ts';

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * The unsubscribe link in every outreach email. Opening the page changes
 * nothing (mail scanners open links); the button records the opt-out. No
 * sign-in, no questions.
 */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      {done === '1' ? (
        <section role="status">
          <h1 className="display text-3xl font-bold">You are unsubscribed</h1>
          <p className="mt-3 text-ink-soft">You will not receive more emails from this sender through GenCut.</p>
        </section>
      ) : done === '0' ? (
        <section role="alert">
          <h1 className="display text-3xl font-bold">This link did not work</h1>
          <p className="mt-3 text-ink-soft">
            The link may be incomplete. Reply to the email with “unsubscribe” and the sender will remove you.
          </p>
        </section>
      ) : (
        <section>
          <h1 className="display text-3xl font-bold">Unsubscribe</h1>
          <p className="mt-3 text-ink-soft">Stop receiving emails from this sender.</p>
          <form action={unsubscribeAction} className="mt-6">
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="h-12 w-full rounded-full bg-bay px-6 font-medium text-paper hover:bg-bay-deep">
              Unsubscribe
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
