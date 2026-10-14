'use client';

import { useActionState } from 'react';
import { type FormState, saveLetterAction } from './actions.ts';

const area =
  'w-full rounded-xl border border-glass-deep bg-white px-4 py-3 text-[0.95rem] leading-relaxed outline-none focus:border-bay aria-[invalid=true]:border-[#b42345]';

/** Edit the letter. Saving runs the same checks as a generated draft. */
export function LetterEditor(props: {
  campaignId: string;
  greeting: string;
  paragraphs: readonly string[];
  closing: string;
  signature: readonly string[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveLetterAction, { status: 'idle' });
  const error = state.status === 'error' ? state.fields.letter ?? state.message : null;
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="campaignId" value={props.campaignId} />
      <label className="grid gap-1 text-sm font-medium">
        Greeting
        <input name="greeting" defaultValue={props.greeting} className={`${area} h-12 py-0`} />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Letter <span className="font-normal text-ink-soft">Leave a blank line between paragraphs.</span>
        <textarea name="body" rows={10} defaultValue={props.paragraphs.join('\n\n')} className={area} aria-invalid={Boolean(error)} aria-describedby={error ? 'letter-error' : undefined} />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">
          Closing
          <input name="closing" defaultValue={props.closing} className={`${area} h-12 py-0`} />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Signature <span className="font-normal text-ink-soft">One line each; keep your brokerage name.</span>
          <textarea name="signature" rows={3} defaultValue={props.signature.join('\n')} className={area} />
        </label>
      </div>
      {error && (
        <p id="letter-error" role="alert" className="rounded-xl bg-[#fdebef] p-3 text-sm text-[#7d1a33]">
          {error}
        </p>
      )}
      {state.status === 'saved' && (
        <p role="status" className="text-sm text-bay-deep">
          Saved. The letter passed GenCut's checks and is still a draft.
        </p>
      )}
      <div>
        <button type="submit" disabled={pending} className="h-11 rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep disabled:opacity-60">
          {pending ? 'Checking…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
