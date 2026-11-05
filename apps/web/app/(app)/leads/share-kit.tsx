'use client';

import type { ShareKit, ShareNetwork, ShareTarget } from '@gencut/core';
import { useEffect, useState } from 'react';

const MARK: Readonly<Record<ShareNetwork, string>> = {
  instagram: 'IG',
  facebook: 'f',
  whatsapp: 'WA',
  tiktok: 'TT',
  linkedin: 'in',
  x: 'X',
  sms: '✉',
};

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Post the lead page anywhere (D-025). Each network button copies that
 * network's caption and opens its own share screen; GenCut never posts. On a
 * phone, "Share" opens the phone's share menu with the caption and link.
 */
export function ShareKitPanel({ kit }: { kit: ShareKit }) {
  const [canShare, setCanShare] = useState(false);
  const [picked, setPicked] = useState<ShareTarget | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'), []);

  const flash = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? null : n)), 4000);
  };

  const onNetwork = async (t: ShareTarget) => {
    setPicked(t);
    const copied = await copy(t.caption);
    if (t.openUrl) {
      if (t.network === 'sms') window.location.href = t.openUrl;
      else window.open(t.openUrl, '_blank', 'noopener,noreferrer');
    }
    flash(copied ? `${t.label}: caption copied.` : `${t.label}: copy the caption below.`);
  };

  const shown = picked ?? null;
  const caption = shown?.caption ?? kit.caption;

  return (
    <div id="share" className="flex scroll-mt-24 flex-col gap-4 rounded-xl bg-glass p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold">Share your lead page</p>
        <div className="flex flex-wrap gap-2">
          {canShare && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.share({ text: kit.caption });
                } catch {
                  // Closing the share menu is not an error worth showing.
                }
              }}
              className="min-h-11 rounded-full bg-bay px-5 text-sm font-semibold text-paper hover:bg-bay-deep"
            >
              Share…
            </button>
          )}
          <button
            type="button"
            onClick={async () => flash((await copy(caption)) ? 'Caption copied.' : 'Select the caption below and copy it.')}
            className="min-h-11 rounded-full border border-glass-deep bg-white px-4 text-sm font-semibold transition-colors hover:border-bay"
          >
            Copy caption
          </button>
        </div>
      </div>

      <ul aria-label="Post to" className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {kit.targets.map((t) => {
          const on = shown?.network === t.network;
          return (
            <li key={t.network}>
              <button
                type="button"
                onClick={() => onNetwork(t)}
                aria-pressed={on}
                className={`flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-xl border px-1 text-xs font-semibold transition-all active:scale-95 ${
                  on ? 'border-bay bg-white shadow-sm' : 'border-transparent bg-white/60 hover:border-glass-deep hover:bg-white'
                }`}
              >
                <span aria-hidden="true" className="grid size-7 place-items-center rounded-full bg-ink text-[0.7rem] font-bold text-paper">
                  {MARK[t.network]}
                </span>
                {t.label}
              </button>
            </li>
          );
        })}
      </ul>

      <p aria-live="polite" className="min-h-5 text-sm font-medium text-bay-deep">
        {note}
      </p>

      <figure className="flex flex-col gap-2">
        <figcaption className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          {shown ? `${shown.label} caption` : 'Caption'}
        </figcaption>
        <p className="whitespace-pre-line rounded-xl border border-glass-deep bg-white p-3 text-sm leading-relaxed">{caption}</p>
      </figure>

      {shown?.howTo && (
        <div className="flex flex-col gap-2 rounded-xl bg-white/70 p-3 text-sm">
          <p>{shown.howTo}</p>
          <button
            type="button"
            onClick={async () => flash((await copy(shown.link)) ? `${shown.label} link copied.` : shown.link)}
            className="min-h-11 self-start rounded-full border border-glass-deep bg-white px-4 text-sm font-semibold hover:border-bay"
          >
            Copy {shown.label} link
          </button>
        </div>
      )}
      <p className="text-xs text-ink-soft">
        GenCut never posts for you: each button copies the caption and opens that network, and you press Post. Each network has its own link, so every
        lead shows where it came from. Your brokerage and license are in every caption.
      </p>
    </div>
  );
}
