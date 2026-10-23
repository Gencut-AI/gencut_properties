'use client';

import { useActionState } from 'react';
import { type HeadshotFormState, uploadHeadshotAction } from './headshot-action.ts';

const initial: HeadshotFormState = { status: 'idle' };

/** Upload or replace the agent's headshot, shown on every campaign's social post. */
export function HeadshotForm({ headshotId, name }: { headshotId: string | null; name: string }) {
  const [state, action, pending] = useActionState(uploadHeadshotAction, initial);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <section aria-labelledby="headshot" className="rounded-panel bg-glass p-6">
      <h2 id="headshot" className="display text-xl font-semibold">
        Your photo
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        A real headshot, shown with your name and brokerage on every social post GenCut prepares. People you meet should recognise you from it.
      </p>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
        {headshotId ? (
          <img src={`/media/${headshotId}`} alt={`${name}'s headshot`} className="size-24 rounded-full object-cover" />
        ) : (
          <div aria-hidden="true" className="display flex size-24 items-center justify-center rounded-full bg-paper text-2xl font-semibold text-bay-deep">
            {initials || '?'}
          </div>
        )}
        <form action={action} className="flex flex-col gap-2">
          <label htmlFor="headshot-file" className="text-sm font-medium">
            {headshotId ? 'Replace photo' : 'Upload a photo'} <span className="font-normal text-ink-soft">(JPEG, PNG or WebP, under 3 MB)</span>
          </label>
          <input
            id="headshot-file"
            name="headshot"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            required
            className="min-h-11 text-sm file:mr-3 file:h-11 file:rounded-full file:border-0 file:bg-paper file:px-4 file:font-medium"
          />
          <button type="submit" disabled={pending} className="h-11 self-start rounded-full bg-bay px-6 text-sm font-medium text-paper hover:bg-bay-deep disabled:opacity-60">
            {pending ? 'Uploading…' : 'Save photo'}
          </button>
          <p aria-live="polite" className="text-sm">
            {state.status === 'saved' && 'Photo saved.'}
            {state.status === 'error' && <span className="text-[#9b1c3a]">{state.message}</span>}
          </p>
        </form>
      </div>
    </section>
  );
}
