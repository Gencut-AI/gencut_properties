/**
 * An agent's public lead page and the leads it collects (D-023).
 *
 * The page is the link an agent puts in an Instagram bio, a Facebook post or
 * an ad. Visitors who fill it in ask to be contacted: each submission stores
 * a consent record with the exact wording shown, then the lead. No sign-in;
 * submissions are rate-limited by a one-way hash of the visitor's network
 * address and the day.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  checkInboundLead,
  type InboundLeadInput,
  type InboundLeadStatus,
  type LeadInterest,
  type LeadSource,
  leadConsentText,
  leadPageSlug,
} from '@gencut/core';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import { requireMembership, requireMembershipFor } from './membership.ts';

/** At most this many submissions per visitor per day, and per page per day. */
export const LEADS_PER_VISITOR_PER_DAY = 5;
export const LEADS_PER_PAGE_PER_DAY = 200;

export interface LeadPage {
  readonly slug: string;
  readonly active: boolean;
}

/** The workspace's lead page, or null if it has none yet. */
export async function getLeadPage(db: Db, ctx: RequestContext, workspaceId: string): Promise<LeadPage | null> {
  await requireMembershipFor(db, ctx, workspaceId);
  const [p] = await db<LeadPage[]>`SELECT slug, active FROM lead_pages WHERE workspace_id = ${workspaceId}`;
  return p ?? null;
}

/** Create the workspace's lead page (owner only). Returns the existing one if there is one. */
export async function createLeadPage(sql: Sql, ctx: RequestContext, workspaceId: string): Promise<LeadPage> {
  const role = await requireMembership(sql, ctx.userId, workspaceId);
  if (role !== 'owner') throw new ServiceError('forbidden', 'Only the account owner can create the lead page.');
  return sql.begin(async (tx) => {
    const [existing] = await tx<LeadPage[]>`SELECT slug, active FROM lead_pages WHERE workspace_id = ${workspaceId}`;
    if (existing) return existing;
    const [profile] = await tx<{ licensee_name: string | null; office_address: string | null }[]>`
      SELECT licensee_name, office_address FROM business_profiles WHERE workspace_id = ${workspaceId}
    `;
    if (!profile?.licensee_name) throw new ServiceError('invalid', 'Add your name in Profile first: the page shows it.');
    const slug = leadPageSlug(profile.licensee_name, randomBytes(3).toString('hex'));
    await tx`INSERT INTO lead_pages (workspace_id, slug) VALUES (${workspaceId}, ${slug})`;
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'workspace', entityId: workspaceId,
      action: 'lead_page_created', detail: { slug },
    });
    return { slug, active: true };
  });
}

export interface PublicLeadPage {
  readonly slug: string;
  readonly agentName: string;
  readonly brokerage: string;
  readonly licenseNumber: string | null;
  readonly zips: readonly string[];
  readonly consentText: string;
}

/** What the public page shows. Null for an unknown or switched-off page. */
export async function getPublicLeadPage(db: Db, slug: string): Promise<PublicLeadPage | null> {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(slug)) return null;
  const [p] = await db<{ licensee_name: string | null; brokerage_name: string | null; license_number: string | null; focus: { zips?: string[] } | null }[]>`
    SELECT b.licensee_name, b.brokerage_name, b.license_number, b.focus
    FROM lead_pages l JOIN business_profiles b ON b.workspace_id = l.workspace_id
    WHERE l.slug = ${slug} AND l.active
  `;
  if (!p?.licensee_name || !p.brokerage_name) return null;
  return {
    slug,
    agentName: p.licensee_name,
    brokerage: p.brokerage_name,
    licenseNumber: p.license_number,
    zips: p.focus?.zips ?? [],
    consentText: leadConsentText(p.licensee_name, p.brokerage_name),
  };
}

/** A one-way, per-day key for a visitor's network address: enough to rate-limit, not to identify. */
export function submitterKey(address: string, day: string): string {
  return createHash('sha256').update(`gencut-lead:${day}:${address}`).digest('hex');
}

export type SubmitResult = { ok: true } | { ok: false; fields: Record<string, string>; message?: string };

/**
 * Store a submission from the public page. Checks the fields, the limits and
 * the page; records the consent as shown, then the lead, in one transaction.
 */
export async function submitInboundLead(
  sql: Sql,
  slug: string,
  input: InboundLeadInput,
  meta: { source: LeadSource; submitter: string },
): Promise<SubmitResult> {
  const checked = checkInboundLead(input);
  if (!checked.ok) return { ok: false, fields: checked.fields };
  const lead = checked.lead;
  const page = await getPublicLeadPage(sql, slug);
  if (!page) return { ok: false, fields: {}, message: 'This page is not taking requests right now.' };

  return sql.begin(async (tx) => {
    const [ws] = await tx<{ workspace_id: string }[]>`SELECT workspace_id FROM lead_pages WHERE slug = ${slug} FOR UPDATE`;
    if (!ws) return { ok: false, fields: {}, message: 'This page is not taking requests right now.' };
    const [counts] = await tx<{ visitor: number; page: number }[]>`
      SELECT count(*) FILTER (WHERE submitter_hash = ${meta.submitter})::int AS visitor, count(*)::int AS page
      FROM inbound_leads WHERE workspace_id = ${ws.workspace_id} AND created_at > now() - interval '1 day'
    `;
    if ((counts?.visitor ?? 0) >= LEADS_PER_VISITOR_PER_DAY || (counts?.page ?? 0) >= LEADS_PER_PAGE_PER_DAY) {
      return { ok: false, fields: {}, message: 'We already have your request. The agent will be in touch.' };
    }
    const [consent] = await tx<{ id: string }[]>`
      INSERT INTO consents (workspace_id, channel, address, scopes, written_signature, disclosure_shown, disclosure_text, evidence, obtained_at)
      VALUES (${ws.workspace_id}, 'email', ${lead.email}, ${['email_marketing']}::text[], false, true, ${page.consentText},
              ${tx.json({ via: 'lead_page', slug, source: meta.source, phone: lead.phone } as never)}, now())
      RETURNING id
    `;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO inbound_leads (workspace_id, name, email, phone, interest, zip, message, source, consent_id, submitter_hash)
      VALUES (${ws.workspace_id}, ${lead.name}, ${lead.email}, ${lead.phone}, ${lead.interest}, ${lead.zip}, ${lead.message},
              ${meta.source}, ${consent!.id}, ${meta.submitter})
      RETURNING id
    `;
    await recordAudit(tx, {
      workspaceId: ws.workspace_id, actorType: 'system', actorId: null, via: 'api', entityType: 'inbound_lead', entityId: row!.id,
      action: 'created', toState: 'new', detail: { source: meta.source, interest: lead.interest, consentId: consent!.id },
    });
    return { ok: true };
  });
}

export interface InboundLead {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly interest: LeadInterest;
  readonly zip: string | null;
  readonly message: string | null;
  readonly source: LeadSource;
  readonly status: InboundLeadStatus;
  readonly createdAt: Date;
}

/** The workspace's inbound leads, newest first, and how many came from each source. */
export async function listInboundLeads(
  db: Db,
  ctx: RequestContext,
  workspaceId: string,
  limit = 20,
): Promise<{ leads: InboundLead[]; total: number; bySource: Partial<Record<LeadSource, number>> }> {
  await requireMembershipFor(db, ctx, workspaceId);
  const rows = await db<{ id: string; name: string; email: string; phone: string | null; interest: LeadInterest; zip: string | null; message: string | null; source: LeadSource; status: InboundLeadStatus; created_at: Date }[]>`
    SELECT id, name, email, phone, interest, zip, message, source, status, created_at FROM inbound_leads
    WHERE workspace_id = ${workspaceId} AND status <> 'dismissed' ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `;
  const counts = await db<{ source: LeadSource; n: number }[]>`
    SELECT source, count(*)::int AS n FROM inbound_leads WHERE workspace_id = ${workspaceId} GROUP BY source
  `;
  return {
    leads: rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, interest: r.interest, zip: r.zip, message: r.message,
      source: r.source, status: r.status, createdAt: r.created_at,
    })),
    total: counts.reduce((a, c) => a + c.n, 0),
    bySource: Object.fromEntries(counts.map((c) => [c.source, c.n])),
  };
}

/** Mark an inbound lead contacted or dismissed (or back to new). */
export async function setInboundLeadStatus(sql: Sql, ctx: RequestContext, workspaceId: string, id: string, status: InboundLeadStatus): Promise<void> {
  await requireMembershipFor(sql, ctx, workspaceId);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ServiceError('not_found', 'That lead does not exist.');
  await sql.begin(async (tx) => {
    const [before] = await tx<{ status: InboundLeadStatus }[]>`SELECT status FROM inbound_leads WHERE id = ${id} AND workspace_id = ${workspaceId} FOR UPDATE`;
    if (!before) throw new ServiceError('not_found', 'That lead does not exist.');
    if (before.status === status) return;
    await tx`UPDATE inbound_leads SET status = ${status} WHERE id = ${id}`;
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'inbound_lead', entityId: id,
      action: 'state_change', fromState: before.status, toState: status,
    });
  });
}
