import { listCampaigns } from '@gencut/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { db } from '../../../lib/db.ts';
import { requireSession } from '../../../lib/session.ts';
import { CAMPAIGN_STATUS_LABEL } from '../_campaign/labels.ts';

export const metadata: Metadata = { title: 'Campaigns' };

export default async function CampaignsPage() {
  const { ctx, workspace } = await requireSession();
  const campaigns = await listCampaigns(db(), ctx, workspace.workspaceId);
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="display text-4xl font-bold">Campaigns</h1>
        <p className="mt-2 max-w-[60ch] text-ink-soft">Drafts GenCut prepared from your opportunities. Nothing here has been sent.</p>
      </header>
      {campaigns.length ? (
        <ul className="grid gap-3">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link href={`/campaigns/${c.id}`} className="flex min-h-16 items-center justify-between gap-4 rounded-panel border border-glass-deep p-5 hover:border-ink-soft/40">
                <span className="font-medium">{c.title}</span>
                <span className="shrink-0 rounded-full bg-glass px-3 py-1 text-xs font-medium text-bay-deep">{CAMPAIGN_STATUS_LABEL[c.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-panel border border-dashed border-glass-deep p-8 text-center text-ink-soft">
          No campaigns yet. Open an opportunity and choose <span className="font-medium text-ink">Create a campaign draft</span>.
        </p>
      )}
    </div>
  );
}
