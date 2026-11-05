/**
 * The agent's dashboard (the Home screen, D-029): one agent's own pipeline,
 * what to do next, and the company buying in their ZIP codes. Reads only, and
 * only this workspace's records plus the shared public-record purchases of its
 * county.
 */

import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { type MarketKey, marketCountyCode } from './markets.ts';
import { requireMembershipFor } from './membership.ts';

/** Deeds reach the county roll about this many months after the sale; the latest months are still filling in. */
export const MARKET_LAG_MONTHS = 3;
/** Months of purchases the dashboard charts, counted back from the newest sale on record. */
export const MARKET_MONTHS = 18;
/** The county ZIP codes listed by company purchases, besides the agent's own. */
export const MARKET_TOP_ZIPS = 8;

const ACTIVE = ['new', 'saved', 'in_campaign'];

export interface DashboardCounts {
  readonly sellerLeads: number;
  readonly buyers: number;
  /** Buyers marked active (buyer-v3): recent repeat buying on the records. */
  readonly activeBuyers: number;
  readonly campaigns: number;
  /** Letters drafted and waiting for the agent's review. */
  readonly campaignsInReview: number;
  readonly emailsSent: number;
  readonly socialLeads: number;
  readonly newSocialLeads: number;
  /** Instagram comments asking for the link, not yet answered or dismissed. */
  readonly instagramWaiting: number;
}

export type DashboardActionKind = 'review_letters' | 'social_leads' | 'instagram' | 'top_seller' | 'top_active_buyer' | 'link_whatsapp' | 'lead_page';

export interface DashboardAction {
  readonly kind: DashboardActionKind;
  readonly href: string;
  readonly count?: number;
  /** What the action is about: an address or a company name. */
  readonly subject?: string;
  readonly score?: number;
}

export interface DashboardMonth {
  /** YYYY-MM */
  readonly month: string;
  readonly purchases: number;
  readonly companies: number;
  /** Within `MARKET_LAG_MONTHS` of the roll: deeds for it are still arriving. */
  readonly filling: boolean;
}

export interface DashboardZip {
  readonly zip: string;
  readonly purchases: number;
  readonly companies: number;
  /** Median price of single-parcel purchases; null when there are none. */
  readonly medianPrice: number | null;
  /** One of the agent's ZIP codes. */
  readonly yours: boolean;
}

export interface AgentDashboard {
  readonly zips: readonly string[];
  /** File date of the newest roll the purchases come from (YYYY-MM-DD), or null before the first import. */
  readonly rollDate: string | null;
  readonly counts: DashboardCounts;
  readonly whatsappLinked: boolean;
  readonly hasLeadPage: boolean;
  /** At most four, most useful first. */
  readonly actions: readonly DashboardAction[];
  readonly market: {
    /** Company purchases in the agent's ZIP codes by month, oldest first, with empty months filled in. */
    readonly months: readonly DashboardMonth[];
    /** The latest twelve months of records in the agent's ZIP codes. */
    readonly lastYear: { readonly purchases: number; readonly companies: number; readonly medianPrice: number | null };
    /** The county's busiest ZIP codes for company purchases in the same twelve months, plus the agent's own. */
    readonly zips: readonly DashboardZip[];
  };
}

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

export async function getAgentDashboard(db: Db, ctx: RequestContext, workspaceId: string): Promise<AgentDashboard> {
  await requireMembershipFor(db, ctx, workspaceId);
  const [profile] = await db<{ market: MarketKey; zips: string[] | null }[]>`
    SELECT market, focus->'zips' AS zips FROM business_profiles WHERE workspace_id = ${workspaceId}
  `;
  const zips = (profile?.zips ?? []).filter((z) => /^\d{5}$/.test(z));
  const county = profile ? marketCountyCode(profile.market) : '';

  const [c] = await db<(DashboardCounts & { whatsapp_linked: boolean; has_lead_page: boolean })[]>`
    SELECT
      (SELECT count(*)::int FROM opportunities WHERE workspace_id = ${workspaceId} AND type = 'potential_seller' AND status = ANY(${ACTIVE}::text[])) AS "sellerLeads",
      (SELECT count(*)::int FROM opportunities WHERE workspace_id = ${workspaceId} AND type = 'investor_buyer' AND status = ANY(${ACTIVE}::text[])) AS "buyers",
      (SELECT count(*)::int FROM opportunities WHERE workspace_id = ${workspaceId} AND type = 'investor_buyer' AND status = ANY(${ACTIVE}::text[])
         AND reasons @> ${db.json([{ code: 'active' }] as never)}) AS "activeBuyers",
      (SELECT count(*)::int FROM campaigns WHERE workspace_id = ${workspaceId} AND status <> 'archived') AS "campaigns",
      (SELECT count(*)::int FROM campaigns WHERE workspace_id = ${workspaceId} AND status = 'review') AS "campaignsInReview",
      (SELECT count(*)::int FROM outreach_actions WHERE workspace_id = ${workspaceId} AND channel = 'email' AND state = 'COMPLETED') AS "emailsSent",
      (SELECT count(*)::int FROM inbound_leads WHERE workspace_id = ${workspaceId}) AS "socialLeads",
      (SELECT count(*)::int FROM inbound_leads WHERE workspace_id = ${workspaceId} AND status = 'new') AS "newSocialLeads",
      (SELECT count(*)::int FROM instagram_comments WHERE workspace_id = ${workspaceId} AND status = 'new' AND reply_state <> 'sent') AS "instagramWaiting",
      EXISTS (SELECT 1 FROM whatsapp_links WHERE user_id = ${ctx.userId} AND revoked_at IS NULL) AS whatsapp_linked,
      EXISTS (SELECT 1 FROM lead_pages WHERE workspace_id = ${workspaceId} AND active) AS has_lead_page
  `;
  const counts: DashboardCounts = {
    sellerLeads: c?.sellerLeads ?? 0,
    buyers: c?.buyers ?? 0,
    activeBuyers: c?.activeBuyers ?? 0,
    campaigns: c?.campaigns ?? 0,
    campaignsInReview: c?.campaignsInReview ?? 0,
    emailsSent: c?.emailsSent ?? 0,
    socialLeads: c?.socialLeads ?? 0,
    newSocialLeads: c?.newSocialLeads ?? 0,
    instagramWaiting: c?.instagramWaiting ?? 0,
  };

  // What to do next: things waiting for the agent first, then the best leads nobody has acted on.
  const [review] = counts.campaignsInReview === 1
    ? await db<{ id: string }[]>`SELECT id FROM campaigns WHERE workspace_id = ${workspaceId} AND status = 'review' LIMIT 1`
    : [];
  const [topSeller] = await db<{ id: string; score: number; address: string | null }[]>`
    SELECT o.id, o.score, s.payload->'situs'->>'address' AS address
    FROM opportunities o LEFT JOIN source_records s ON s.id = o.source_record_id
    WHERE o.workspace_id = ${workspaceId} AND o.type = 'potential_seller' AND o.status = 'new'
    ORDER BY o.score DESC, o.updated_at DESC LIMIT 1
  `;
  const [topBuyer] = await db<{ id: string; score: number; name: string | null }[]>`
    SELECT id, score, evidence->'profile'->>'name' AS name FROM opportunities
    WHERE workspace_id = ${workspaceId} AND type = 'investor_buyer' AND status = 'new' AND reasons @> ${db.json([{ code: 'active' }] as never)}
    ORDER BY score DESC, updated_at DESC LIMIT 1
  `;
  const actions: DashboardAction[] = [];
  if (counts.campaignsInReview > 0) actions.push({ kind: 'review_letters', count: counts.campaignsInReview, href: review ? `/campaigns/${review.id}` : '/campaigns' });
  if (counts.newSocialLeads > 0) actions.push({ kind: 'social_leads', count: counts.newSocialLeads, href: '/leads#social' });
  if (counts.instagramWaiting > 0) actions.push({ kind: 'instagram', count: counts.instagramWaiting, href: '/leads#instagram' });
  if (topSeller) actions.push({ kind: 'top_seller', href: `/opportunities/${topSeller.id}`, score: topSeller.score, ...(topSeller.address ? { subject: topSeller.address } : {}) });
  if (topBuyer) actions.push({ kind: 'top_active_buyer', href: `/buyers/${topBuyer.id}`, score: topBuyer.score, ...(topBuyer.name ? { subject: topBuyer.name } : {}) });
  if (!c?.has_lead_page) actions.push({ kind: 'lead_page', href: '/leads#social' });
  if (!c?.whatsapp_linked) actions.push({ kind: 'link_whatsapp', href: '/profile' });

  const market = await marketFor(db, county, zips);
  return {
    zips,
    rollDate: market.rollDate,
    counts,
    whatsappLinked: c?.whatsapp_linked === true,
    hasLeadPage: c?.has_lead_page === true,
    actions: actions.slice(0, 4),
    market: { months: market.months, lastYear: market.lastYear, zips: market.zips },
  };
}

async function marketFor(db: Db, county: string, zips: readonly string[]) {
  const empty = { rollDate: null, months: [], lastYear: { purchases: 0, companies: 0, medianPrice: null }, zips: [] };
  if (!county) return empty;
  const [span] = await db<{ roll_date: string | null; newest: string | null }[]>`
    SELECT (SELECT to_char(max(file_date), 'YYYY-MM-DD') FROM transaction_imports WHERE county_code = ${county} AND status = 'ready') AS roll_date,
           (SELECT to_char(max(make_date(sale_year, coalesce(sale_month, 1), 1)), 'YYYY-MM') FROM property_transactions WHERE county_code = ${county}) AS newest
  `;
  if (!span?.newest) return { ...empty, rollDate: span?.roll_date ?? null };
  const newest = monthIndex(span.newest);
  const from = monthOf(newest - MARKET_MONTHS + 1);
  const yearFrom = monthOf(newest - 11);

  const byMonth = zips.length
    ? await db<{ month: string; purchases: number; companies: number }[]>`
        SELECT to_char(make_date(sale_year, sale_month, 1), 'YYYY-MM') AS month, count(*)::int AS purchases, count(DISTINCT owner_key)::int AS companies
        FROM property_transactions
        WHERE county_code = ${county} AND situs_zip = ANY(${zips}::text[]) AND sale_month IS NOT NULL
          AND make_date(sale_year, sale_month, 1) >= ${`${from}-01`}::date
        GROUP BY 1
      `
    : [];
  const roll = span.roll_date ? monthIndex(span.roll_date.slice(0, 7)) : null;
  const months: DashboardMonth[] = [];
  for (let i = newest - MARKET_MONTHS + 1; i <= newest; i++) {
    const m = monthOf(i);
    const r = byMonth.find((x) => x.month === m);
    months.push({ month: m, purchases: r?.purchases ?? 0, companies: r?.companies ?? 0, filling: roll !== null && i > roll - MARKET_LAG_MONTHS - 1 });
  }

  const [year] = zips.length
    ? await db<{ purchases: number; companies: number; median: number | null }[]>`
        SELECT count(*)::int AS purchases, count(DISTINCT owner_key)::int AS companies,
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FILTER (WHERE qualification_code <> '05'))::int AS median
        FROM property_transactions
        WHERE county_code = ${county} AND situs_zip = ANY(${zips}::text[]) AND make_date(sale_year, coalesce(sale_month, 1), 1) >= ${`${yearFrom}-01`}::date
      `
    : [];
  const zipRows = await db<{ zip: string; purchases: number; companies: number; median: number | null }[]>`
    WITH last_year AS (
      SELECT situs_zip, owner_key, price, qualification_code FROM property_transactions
      WHERE county_code = ${county} AND make_date(sale_year, coalesce(sale_month, 1), 1) >= ${`${yearFrom}-01`}::date
    ), ranked AS (
      SELECT situs_zip AS zip, count(*)::int AS purchases, count(DISTINCT owner_key)::int AS companies,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FILTER (WHERE qualification_code <> '05'))::int AS median
      FROM last_year GROUP BY situs_zip
    )
    SELECT * FROM (SELECT * FROM ranked ORDER BY purchases DESC, zip LIMIT ${MARKET_TOP_ZIPS}) top
    UNION
    SELECT * FROM ranked WHERE zip = ANY(${zips}::text[])
  `;
  const listed = zipRows
    .map((r) => ({ zip: r.zip, purchases: r.purchases, companies: r.companies, medianPrice: r.median, yours: zips.includes(r.zip) }))
    .sort((a, b) => b.purchases - a.purchases || a.zip.localeCompare(b.zip));
  // The agent's ZIP codes are listed even when nobody bought there.
  for (const z of zips) if (!listed.some((r) => r.zip === z)) listed.push({ zip: z, purchases: 0, companies: 0, medianPrice: null, yours: true });

  return {
    rollDate: span.roll_date,
    months,
    lastYear: { purchases: year?.purchases ?? 0, companies: year?.companies ?? 0, medianPrice: year?.median ?? null },
    zips: listed,
  };
}
