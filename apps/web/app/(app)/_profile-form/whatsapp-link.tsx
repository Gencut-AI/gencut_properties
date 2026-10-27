'use client';

import { useActionState } from 'react';
import { type LinkCodeState, createLinkCodeAction, unlinkWhatsAppAction } from './whatsapp-actions.ts';

const initial: LinkCodeState = { status: 'idle' };

/** Link the agent's own WhatsApp number to GenCut, or unlink it. */
export function WhatsAppLink({ linkedNumber, businessNumber }: { linkedNumber: string | null; businessNumber: string | null }) {
  const [state, action, pending] = useActionState(createLinkCodeAction, initial);
  const to = businessNumber ? `+${businessNumber}` : 'the GenCut WhatsApp number';
  // The code is typed, not put in the link: a one-time code does not belong in a URL.
  const chat = businessNumber ? `https://wa.me/${businessNumber}` : null;
  return (
    <section aria-labelledby="whatsapp" className="rounded-panel border border-glass-deep p-6">
      <h2 id="whatsapp" className="display text-xl font-semibold">
        WhatsApp
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Ask GenCut from your phone: what is new, your best sellers and buyers, details, and letter drafts. Nothing is ever sent to owners or
        buyers from WhatsApp.
      </p>
      {linkedNumber ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-[0.95rem]">
            Linked to <span className="font-medium">{linkedNumber}</span>. Send <span className="font-medium">help</span> to {to} to start.
          </p>
          <form action={unlinkWhatsAppAction}>
            <button type="submit" className="h-11 rounded-full border border-glass-deep px-5 text-sm font-medium hover:border-ink-soft">
              Unlink
            </button>
          </form>
        </div>
      ) : state.status === 'code' ? (
        <div className="mt-4 grid gap-2" aria-live="polite">
          <p className="text-[0.95rem]">
            From the WhatsApp number you want to use, send this message to {to}:
          </p>
          <p className="display text-3xl font-bold tracking-widest">LINK {state.code}</p>
          <p className="text-sm text-ink-soft">The code works once, for {state.minutes} minutes. Refresh this page after you send it.</p>
          {chat && (
            <a href={chat} className="h-11 self-start content-center rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep">
              Open the chat in WhatsApp
            </a>
          )}
        </div>
      ) : (
        <form action={action} className="mt-4">
          <button type="submit" disabled={pending} className="h-11 rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep disabled:opacity-60">
            {pending ? 'Creating a code…' : 'Link WhatsApp'}
          </button>
        </form>
      )}
    </section>
  );
}
