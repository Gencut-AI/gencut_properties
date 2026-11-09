'use client';

import type { MailTo } from '@gencut/services';
import { useState } from 'react';

/** Where to post a buyer letter (D-030): the company, the person it is addressed to, and the address, ready to copy onto an envelope. */
export function MailToCard({ m }: { m: MailTo }) {
  const [copied, setCopied] = useState(false);
  const block = [m.company, ...(m.attention ? [`Attn: ${m.attention}`] : []), ...m.lines].join('\n');
  return (
    <section aria-labelledby="mail-to" className="flex flex-col gap-3 rounded-panel border border-glass-deep bg-white p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
      <div className="min-w-0">
        <h2 id="mail-to" className="text-sm font-semibold uppercase tracking-wide text-ink-soft">
          Mail to
        </h2>
        <address className="mt-2 whitespace-pre-line font-[Georgia,serif] text-[1.02rem] not-italic leading-relaxed [overflow-wrap:anywhere]">{block}</address>
        <p className="mt-2 text-xs text-ink-soft">
          {m.source === 'register' ? 'The company’s mailing address in the Florida company register.' : 'The mailing address on the county tax roll.'}
          {m.attention ? ' The person is a manager or officer on the company’s register record.' : ''}
        </p>
      </div>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(block);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
          } catch {
            setCopied(false);
          }
        }}
        className="min-h-11 shrink-0 self-start rounded-full border border-glass-deep px-4 text-sm font-semibold transition-colors hover:border-bay"
      >
        {copied ? 'Copied' : 'Copy address'}
      </button>
    </section>
  );
}
