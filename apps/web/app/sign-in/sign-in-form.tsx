'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { type CodeState, type SignInState, sendSignInLink, verifyEmailCode } from './actions.ts';

const inputClass = 'h-14 rounded-xl border border-glass-deep bg-white px-4 text-lg outline-none focus:border-bay';
const primaryButton =
  'h-14 rounded-xl bg-bay text-lg font-semibold text-paper transition-colors hover:bg-bay-deep disabled:opacity-60';

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(sendSignInLink, { status: 'idle' });

  if (state.status === 'sent') return <CheckInbox email={state.email} resend={action} resending={pending} />;

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <label htmlFor="email" className="text-sm font-medium">
        Work email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        defaultValue={state.status === 'error' ? state.email : ''}
        aria-invalid={state.status === 'error'}
        aria-describedby={state.status === 'error' ? 'email-error' : undefined}
        className={inputClass}
      />
      {state.status === 'error' && (
        <p id="email-error" className="text-sm text-[#b42345]">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? 'Sending…' : 'Email me a sign-in link'}
      </button>
      <p className="text-sm text-ink-soft">New to GenCut? The same link creates your account.</p>
    </form>
  );
}

/** After the email is sent: open the link on any device, or type the code here (D-036). */
function CheckInbox({ email, resend, resending }: { email: string; resend: (form: FormData) => void; resending: boolean }) {
  const [code, verify, verifying] = useActionState<CodeState, FormData>(verifyEmailCode, { status: 'idle' });
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-panel bg-glass p-6" role="status">
        <h2 className="display text-2xl font-semibold">Check your inbox</h2>
        <p className="mt-2 text-ink-soft">
          We sent an email to <strong className="text-ink">{email}</strong>. Open its link on any device, or type its code below. The link
          and the code work once, and a newer email replaces an older one.
        </p>
        <p className="mt-2 text-sm text-ink-soft">Nothing after a minute? Check your spam or promotions folder.</p>
      </div>

      <form action={verify} className="flex flex-col gap-3" noValidate>
        <input type="hidden" name="email" value={email} />
        <label htmlFor="code" className="text-sm font-medium">
          Code from the email
        </label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 -]*"
          maxLength={14}
          required
          aria-invalid={code.status === 'error'}
          aria-describedby={code.status === 'error' ? 'code-error' : undefined}
          className={`${inputClass} tracking-[0.3em]`}
        />
        {code.status === 'error' && (
          <p id="code-error" className="text-sm text-[#b42345]">
            {code.message}
          </p>
        )}
        <button type="submit" disabled={verifying} className={primaryButton}>
          {verifying ? 'Checking…' : 'Sign in with the code'}
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <form action={resend}>
          <input type="hidden" name="email" value={email} />
          <button type="submit" disabled={resending} className="font-medium text-bay-deep underline underline-offset-4 disabled:opacity-60">
            {resending ? 'Sending…' : 'Send a new email'}
          </button>
        </form>
        <Link href="/sign-in" className="font-medium text-bay-deep underline underline-offset-4">
          Use a different email
        </Link>
      </div>
    </div>
  );
}
