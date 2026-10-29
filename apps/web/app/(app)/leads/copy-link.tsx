'use client';

import { useState } from 'react';

/** The lead page address with a copy button, one link per network so each lead shows where it came from. */
export function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        } catch {
          window.prompt('Copy this link', url);
        }
      }}
      className="min-h-11 rounded-full border border-glass-deep bg-white px-4 text-sm font-semibold transition-colors hover:border-bay"
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}
