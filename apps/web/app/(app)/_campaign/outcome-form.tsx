'use client';

import { useActionState } from 'react';
import { type FormState, recordOutcomeAction } from './actions.ts';

const OUTCOMES = [
  ['contacted', 'Letter sent / contacted'],
  ['no_response', 'No response'],
  ['responded', 'Owner responded'],
  ['not_interested', 'Not interested'],
  ['appointment', 'Appointment set'],
  ['listing', 'Listing signed'],
  ['wrong_address', 'Wrong address'],
] as const;

const field = 'h-11 w-full rounded-lg border border-glass-deep bg-white px-3 text-[0.95rem]';

/** Record what happened. Kept with the score that ranked this opportunity, to check the scoring later. */
export function OutcomeForm({ opportunityId, today }: { opportunityId: string; today: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(recordOutcomeAction, { status: 'idle' });
  const err = state.status === 'error' ? state.fields : {};
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto]">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          What happened
          <select name="outcome" required defaultValue="" className={field} aria-invalid={Boolean(err.outcome)}>
            <option value="" disabled>
              Choose…
            </option>
            {OUTCOMES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          When
          <input type="date" name="occurredOn" required max={today} defaultValue={today} className={field} aria-invalid={Boolean(err.occurredOn)} />
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          Note (optional)
          <input name="note" maxLength={500} className={field} />
        </label>
      </div>
      <div className="flex items-end">
        <button type="submit" disabled={pending} className="h-11 w-full rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep disabled:opacity-60 sm:w-auto">
          {pending ? 'Saving…' : 'Record'}
        </button>
      </div>
      {state.status === 'error' && (
        <p role="alert" className="text-sm text-[#7d1a33] sm:col-span-2">
          {Object.values(state.fields)[0] ?? state.message}
        </p>
      )}
      {state.status === 'saved' && (
        <p role="status" className="text-sm text-bay-deep sm:col-span-2">
          Recorded.
        </p>
      )}
    </form>
  );
}
