'use client';

import { useActionState } from 'react';
import { type LeadFormState, submitLeadAction } from './actions.ts';

const INTERESTS = [
  { value: 'selling', label: 'Selling' },
  { value: 'buying', label: 'Buying' },
  { value: 'investing', label: 'Investing' },
  { value: 'home_value', label: 'My home’s value' },
] as const;

const field =
  'h-12 w-full rounded-xl border border-glass-deep bg-white px-4 text-base outline-none transition-colors focus:border-bay aria-[invalid=true]:border-[#b42345]';

export function LeadForm(props: { slug: string; source: string; firstName: string; zip: string; consentText: string }) {
  const [state, action, pending] = useActionState<LeadFormState, FormData>(submitLeadAction, { status: 'idle' });
  const err = state.status === 'error' ? state.fields : {};

  if (state.status === 'sent') {
    return (
      <div role="status" className="rise flex flex-col items-center gap-3 py-10 text-center">
        <span aria-hidden="true" className="grid size-16 place-items-center rounded-full bg-bay text-paper">
          <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <h2 className="display text-2xl font-bold">Thank you{state.name ? `, ${state.name}` : ''}!</h2>
        <p className="max-w-sm text-ink-soft">{props.firstName} has your request and will get back to you personally.</p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="source" value={props.source} />
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">I’m interested in</legend>
        <div className="grid grid-cols-2 gap-2">
          {INTERESTS.map((i, n) => (
            <label key={i.value} className="cursor-pointer">
              <input type="radio" name="interest" value={i.value} defaultChecked={n === 0} className="peer sr-only" />
              <span className="flex min-h-12 items-center justify-center rounded-xl border border-glass-deep bg-white px-3 text-center text-sm font-semibold transition-all peer-checked:border-bay peer-checked:bg-bay peer-checked:text-paper peer-focus-visible:outline peer-focus-visible:outline-3 peer-focus-visible:outline-bay">
                {i.label}
              </span>
            </label>
          ))}
        </div>
        {err.interest && <span className="text-sm text-[#7d1a33]">{err.interest}</span>}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm font-semibold">
        Your name
        <input name="name" autoComplete="name" required className={field} aria-invalid={Boolean(err.name)} />
        {err.name && <span className="font-normal text-[#7d1a33]">{err.name}</span>}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Email
          <input name="email" type="email" autoComplete="email" inputMode="email" required className={field} aria-invalid={Boolean(err.email)} />
          {err.email && <span className="font-normal text-[#7d1a33]">{err.email}</span>}
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          <span>
            Phone <span className="font-normal text-ink-soft">(optional)</span>
          </span>
          <input name="phone" type="tel" autoComplete="tel" inputMode="tel" className={field} aria-invalid={Boolean(err.phone)} />
          {err.phone && <span className="font-normal text-[#7d1a33]">{err.phone}</span>}
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <label className="flex flex-col gap-1 text-sm font-semibold">
          ZIP code
          <input name="zip" inputMode="numeric" maxLength={5} defaultValue={props.zip} className={field} aria-invalid={Boolean(err.zip)} />
          {err.zip && <span className="font-normal text-[#7d1a33]">{err.zip}</span>}
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          <span>
            Anything {props.firstName} should know? <span className="font-normal text-ink-soft">(optional)</span>
          </span>
          <input name="message" maxLength={1000} className={field} />
        </label>
      </div>

      <label className="flex items-start gap-3 rounded-xl bg-glass p-4 text-sm leading-relaxed">
        <input type="checkbox" name="consent" value="yes" required className="mt-0.5 size-5 shrink-0 accent-[var(--color-bay)]" aria-invalid={Boolean(err.consent)} />
        <span>{props.consentText}</span>
      </label>
      {err.consent && <span className="-mt-3 text-sm text-[#7d1a33]">{err.consent}</span>}

      {state.status === 'error' && Object.keys(err).length === 0 && (
        <p role="alert" className="rounded-xl bg-[#fdebef] p-3 text-sm text-[#7d1a33]">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="h-14 rounded-full bg-ink text-base font-bold text-paper transition-transform hover:-translate-y-0.5 hover:bg-bay-deep disabled:opacity-60"
      >
        {pending ? 'Sending…' : `Send to ${props.firstName}`}
      </button>
    </form>
  );
}
