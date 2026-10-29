/**
 * The Leads tab: one view of the prospecting run for a workspace. How many
 * homes the county roll holds, how many were considered and qualified, the
 * buyers kept, and where each lead stands in outreach. Reads only; every
 * number comes from records the discovery job and campaigns already wrote.
 */

import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { type MarketKey, marketCountyCode } from './markets.ts';
import { requireMembershipFor } from './membership.ts';

/** Where one lead stands after discovery. `emailed` means an approved email was accepted by the email service. */
export type LeadOutreach = 'campaign' | 'emailed';

export interface LeadsOverview {
  /** Homes on the county roll for the workspace's market, and the ZIP codes they span; null until the ZIP index is built. */
  readonly countyHomes: number | null;
  readonly countyZips: number | null;
  /** Leads with a campaign, and those an email went to, by opportunity id. */
  readonly outreach: Readonly<Record<string, LeadOutreach>>;
  readonly campaigns: number;
  readonly emailsSent: number;
}

export async function getLeadsOverview(db: Db, ctx: RequestContext, workspaceId: string): Promise<LeadsOverview> {
  await requireMembershipFor(db, ctx, workspaceId);
  const [profile] = await db<{ market: MarketKey }[]>`SELECT market FROM business_profiles WHERE workspace_id = ${workspaceId}`;
  const [county] = profile
    ? await db<{ homes: number | null; zips: number }[]>`
        SELECT sum(homes)::int AS homes, count(*)::int AS zips FROM county_zip_counts WHERE county_code = ${marketCountyCode(profile.market)}
      `
    : [];
  const rows = await db<{ opportunity_id: string; emailed: boolean }[]>`
    SELECT c.opportunity_id,
           bool_or(a.state = 'COMPLETED' AND a.channel = 'email') AS emailed
    FROM campaigns c
    LEFT JOIN outreach_actions a ON a.campaign_id = c.id
    WHERE c.workspace_id = ${workspaceId} AND c.opportunity_id IS NOT NULL
    GROUP BY c.opportunity_id
  `;
  const [totals] = await db<{ campaigns: number; emails: number }[]>`
    SELECT (SELECT count(*)::int FROM campaigns WHERE workspace_id = ${workspaceId}) AS campaigns,
           (SELECT count(*)::int FROM outreach_actions WHERE workspace_id = ${workspaceId} AND channel = 'email' AND state = 'COMPLETED') AS emails
  `;
  return {
    countyHomes: county?.zips ? county.homes : null,
    countyZips: county?.zips ? county.zips : null,
    outreach: Object.fromEntries(rows.map((r) => [r.opportunity_id, r.emailed ? 'emailed' : 'campaign'])),
    campaigns: totals?.campaigns ?? 0,
    emailsSent: totals?.emails ?? 0,
  };
}
