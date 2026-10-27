/**
 * The WhatsApp assistant: an agent talks to GenCut from their own phone.
 *
 *   webhook (web)        → verifyWebhookSignature, parseWebhook, storeInbound
 *   background job       → processInbound: claim, understand, act, reply
 *   Profile page (web)   → createLinkCode, getWhatsAppLink, unlinkWhatsApp
 *
 * Every action goes through the same services the web app calls, with a
 * RequestContext built from the linked user (via 'whatsapp'), so membership
 * and permission checks are identical. Nothing here messages prospects, sends
 * outreach or approves anything (D-007, D-017).
 */
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ASSISTANT_INTENT_PROMPT_VERSION,
  type Command,
  type ListedItem,
  type Reply,
  badCodeReply,
  buyerDetailReply,
  buyersReply,
  campaignsReply,
  commandFromIntent,
  draftStartedReply,
  extractJson,
  fitReply,
  helpReply,
  intentPrompt,
  letterReply,
  linkedReply,
  maskWaId,
  monthLabel,
  noListReply,
  normalizeWaId,
  notLinkedReply,
  parseCommand,
  sellerDetailReply,
  sellersReply,
  summaryReply,
  tooManyCodesReply,
  unknownReply,
  unlinkedReply,
} from '@gencut/core';
import { ensureWorkspace, getBusinessProfile } from './accounts.ts';
import { recordAudit } from './audit.ts';
import { countBuyers, getBuyer, listBuyers } from './buyers.ts';
import { generateCampaignDraft, getCampaign, listCampaigns, startCampaignDraft } from './campaigns.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { isServiceError } from './errors.ts';
import { type ModelRouter, recordModelRun } from './models.ts';
import { countOpportunities, getOpportunity, listOpportunities, setOpportunityStatus } from './opportunities.ts';

// ------------------------------------------------------------------ configuration

/** Graph API version used for sending (Meta's docs used v26.0 when this was written, 27 Oct 2026). */
export const GRAPH_API_VERSION = 'v26.0';

export interface WhatsAppConfig {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  /** The business number agents message, shown on the Profile page (digits). */
  readonly displayNumber: string | null;
}

/** The deploy's WhatsApp settings, or null when any required one is missing (the assistant is then off). */
export function whatsappConfigFromEnv(env: Record<string, string | undefined> = process.env): WhatsAppConfig | null {
  const v = (k: string) => env[k]?.trim() || '';
  const c = {
    accessToken: v('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: v('WHATSAPP_PHONE_NUMBER_ID'),
    appSecret: v('WHATSAPP_APP_SECRET'),
    verifyToken: v('WHATSAPP_VERIFY_TOKEN'),
  };
  if (!c.accessToken || !c.phoneNumberId || !c.appSecret || !c.verifyToken) return null;
  return { ...c, displayNumber: normalizeWaId(v('WHATSAPP_DISPLAY_NUMBER')) };
}

// ------------------------------------------------------------------ webhook

/** Meta signs each POST with HMAC-SHA256 of the raw body, keyed by the app secret: `sha256=<hex>`. */
export function verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? '');
  if (!m?.[1] || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The GET handshake: echo the challenge when the mode and token match. */
export function verifySubscription(params: URLSearchParams, verifyToken: string): string | null {
  const token = params.get('hub.verify_token') ?? '';
  const ok =
    params.get('hub.mode') === 'subscribe' &&
    token.length === verifyToken.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken));
  return ok ? (params.get('hub.challenge') ?? '') : null;
}

export interface InboundMessage {
  readonly wamid: string;
  readonly waId: string;
  readonly kind: 'text' | 'button' | 'other';
  /** Text typed, or the command a tapped button carries. */
  readonly text: string;
  readonly phoneNumberId: string;
}

/** Messages in a webhook POST. Status updates and anything unrecognized are left out. */
export function parseWebhook(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const p = payload as { object?: unknown; entry?: unknown };
  if (p?.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry as { changes?: unknown }[]) {
    for (const change of Array.isArray(entry?.changes) ? (entry.changes as { field?: unknown; value?: unknown }[]) : []) {
      if (change?.field !== 'messages') continue;
      const value = change.value as { metadata?: { phone_number_id?: unknown }; messages?: unknown };
      const phoneNumberId = typeof value?.metadata?.phone_number_id === 'string' ? value.metadata.phone_number_id : '';
      for (const m of Array.isArray(value?.messages) ? (value.messages as Record<string, unknown>[]) : []) {
        const waId = typeof m.from === 'string' ? normalizeWaId(m.from) : null;
        if (!waId || typeof m.id !== 'string') continue;
        const interactive = m.interactive as { type?: unknown; button_reply?: { id?: unknown } } | undefined;
        if (m.type === 'text' && typeof (m.text as { body?: unknown })?.body === 'string') {
          out.push({ wamid: m.id, waId, kind: 'text', text: (m.text as { body: string }).body.slice(0, 2000), phoneNumberId });
        } else if (m.type === 'interactive' && interactive?.type === 'button_reply' && typeof interactive.button_reply?.id === 'string') {
          out.push({ wamid: m.id, waId, kind: 'button', text: interactive.button_reply.id.slice(0, 256), phoneNumberId });
        } else {
          out.push({ wamid: m.id, waId, kind: 'other', text: '', phoneNumberId });
        }
      }
    }
  }
  return out;
}

/** Store inbound messages once each (Meta retries); returns how many were new. */
export async function storeInbound(sql: Sql, messages: readonly InboundMessage[]): Promise<number> {
  let added = 0;
  for (const m of messages) {
    const rows = await sql`
      INSERT INTO whatsapp_messages (wamid, direction, wa_id, kind, body, status)
      VALUES (${m.wamid}, 'in', ${m.waId}, ${m.kind}, ${m.text}, 'received')
      ON CONFLICT (wamid) DO NOTHING RETURNING id
    `;
    if (rows.length) {
      added++;
      await sql`
        INSERT INTO whatsapp_sessions (wa_id, last_inbound_at) VALUES (${m.waId}, now())
        ON CONFLICT (wa_id) DO UPDATE SET last_inbound_at = now(), updated_at = now()
      `;
    }
  }
  return added;
}

// ------------------------------------------------------------------ sending

export interface ChatSender {
  /** Send one reply; returns the provider's message id. Throws on failure. */
  send(to: string, reply: Reply): Promise<string | null>;
}

/** WhatsApp body limit for interactive messages; longer replies go as plain text. */
const INTERACTIVE_BODY_MAX = 1024;

/** Request body for one reply: reply buttons when it has them and fits, else text. */
export function whatsappMessageBody(to: string, reply: Reply): Record<string, unknown> {
  const text = fitReply(reply.text);
  if (reply.buttons?.length && text.length <= INTERACTIVE_BODY_MAX) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: { buttons: reply.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.command.slice(0, 256), title: b.title.slice(0, 20) } })) },
      },
    };
  }
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: false } };
}

export class WhatsAppCloudSender implements ChatSender {
  private readonly config: WhatsAppConfig;
  private readonly fetchFn: typeof fetch;
  constructor(config: WhatsAppConfig, fetchFn: typeof fetch = fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  async send(to: string, reply: Reply): Promise<string | null> {
    const res = await this.fetchFn(`https://graph.facebook.com/${GRAPH_API_VERSION}/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(whatsappMessageBody(to, reply)),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { messages?: { id?: string }[]; error?: { message?: string; code?: number } } | null;
    if (!res.ok) {
      // Meta's message, never the token.
      const why = body?.error?.message?.replaceAll(this.config.accessToken, '[redacted]') ?? `HTTP ${res.status}`;
      throw new Error(`WhatsApp send failed (${res.status}${body?.error?.code ? `, code ${body.error.code}` : ''}): ${why}`);
    }
    return body?.messages?.[0]?.id ?? null;
  }
}

/** Keeps replies in memory, for tests. */
export class RecordedSender implements ChatSender {
  readonly sent: { to: string; reply: Reply }[] = [];
  async send(to: string, reply: Reply): Promise<string | null> {
    this.sent.push({ to, reply });
    return `wamid.recorded.${randomUUID()}`;
  }
}

// ------------------------------------------------------------------ linking

const LINK_CODE_TTL = '15 minutes';
const MAX_FAILED_LINKS = 5;
const hashCode = (code: string) => createHash('sha256').update(`gencut-whatsapp-link:${code}`).digest('hex');

/** A new 6-digit code for the signed-in user to send from WhatsApp. Earlier unused codes stop working. */
export async function createLinkCode(sql: Sql, ctx: RequestContext): Promise<{ code: string; expiresInMinutes: number }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await sql.begin(async (tx) => {
    await tx`UPDATE whatsapp_link_codes SET used_at = now() WHERE user_id = ${ctx.userId} AND used_at IS NULL`;
    await tx`
      INSERT INTO whatsapp_link_codes (user_id, code_hash, expires_at)
      VALUES (${ctx.userId}, ${hashCode(code)}, now() + ${LINK_CODE_TTL}::interval)
    `;
  });
  return { code, expiresInMinutes: 15 };
}

export interface WhatsAppLinkView {
  readonly linked: boolean;
  readonly number: string | null;
  readonly linkedAt: Date | null;
}

export async function getWhatsAppLink(db: Db, ctx: RequestContext): Promise<WhatsAppLinkView> {
  const [row] = await db<{ wa_id: string; linked_at: Date }[]>`
    SELECT wa_id, linked_at FROM whatsapp_links WHERE user_id = ${ctx.userId} AND revoked_at IS NULL
  `;
  return row ? { linked: true, number: maskWaId(row.wa_id), linkedAt: row.linked_at } : { linked: false, number: null, linkedAt: null };
}

async function revokeLink(tx: Db, userId: string, via: 'web' | 'whatsapp', reason: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    UPDATE whatsapp_links SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL RETURNING id
  `;
  const [m] = await tx<{ workspace_id: string }[]>`SELECT workspace_id FROM memberships WHERE user_id = ${userId} ORDER BY created_at LIMIT 1`;
  for (const r of rows) {
    if (m) await recordAudit(tx, { workspaceId: m.workspace_id, actorType: 'user', actorId: userId, via, entityType: 'whatsapp_link', entityId: r.id, action: 'revoked', detail: { reason } });
  }
  return rows.length > 0;
}

/** Unlink the signed-in user's number (from the web app). */
export async function unlinkWhatsApp(sql: Sql, ctx: RequestContext): Promise<boolean> {
  return (await sql.begin((tx) => revokeLink(tx, ctx.userId, ctx.via === 'whatsapp' ? 'whatsapp' : 'web', 'unlinked_by_user'))) as boolean;
}

/** Link `waId` to whoever created `code`, if the code is valid. Failed attempts per number are limited. */
async function linkByCode(sql: Sql, waId: string, code: string): Promise<{ ok: true; userId: string } | { ok: false; reason: 'bad_code' | 'too_many' }> {
  return (await sql.begin(async (tx) => {
    const [s] = await tx<{ failed_links: number; recent: boolean }[]>`
      SELECT failed_links, coalesce(failed_links_since > now() - interval '1 hour', false) AS recent
      FROM whatsapp_sessions WHERE wa_id = ${waId} FOR UPDATE
    `;
    if (s?.recent && s.failed_links >= MAX_FAILED_LINKS) return { ok: false, reason: 'too_many' } as const;
    const [c] = await tx<{ id: string; user_id: string }[]>`
      UPDATE whatsapp_link_codes SET used_at = now()
      WHERE id = (SELECT id FROM whatsapp_link_codes WHERE code_hash = ${hashCode(code)} AND used_at IS NULL AND expires_at > now()
                  ORDER BY created_at DESC LIMIT 1 FOR UPDATE)
      RETURNING id, user_id
    `;
    if (!c) {
      await tx`
        INSERT INTO whatsapp_sessions (wa_id, failed_links, failed_links_since) VALUES (${waId}, 1, now())
        ON CONFLICT (wa_id) DO UPDATE SET
          failed_links = CASE WHEN whatsapp_sessions.failed_links_since > now() - interval '1 hour' THEN whatsapp_sessions.failed_links + 1 ELSE 1 END,
          failed_links_since = CASE WHEN whatsapp_sessions.failed_links_since > now() - interval '1 hour' THEN whatsapp_sessions.failed_links_since ELSE now() END,
          updated_at = now()
      `;
      return { ok: false, reason: 'bad_code' } as const;
    }
    // One active link per number and per user: replace whatever was there.
    const [other] = await tx<{ user_id: string }[]>`SELECT user_id FROM whatsapp_links WHERE wa_id = ${waId} AND revoked_at IS NULL`;
    if (other) await revokeLink(tx, other.user_id, 'whatsapp', 'number_linked_to_another_account');
    await revokeLink(tx, c.user_id, 'whatsapp', 'replaced_by_new_number');
    const [link] = await tx<{ id: string }[]>`INSERT INTO whatsapp_links (user_id, wa_id) VALUES (${c.user_id}, ${waId}) RETURNING id`;
    await tx`UPDATE whatsapp_sessions SET failed_links = 0, failed_links_since = NULL, listed = '[]', updated_at = now() WHERE wa_id = ${waId}`;
    const [m] = await tx<{ workspace_id: string }[]>`SELECT workspace_id FROM memberships WHERE user_id = ${c.user_id} ORDER BY created_at LIMIT 1`;
    if (m && link) {
      await recordAudit(tx, { workspaceId: m.workspace_id, actorType: 'user', actorId: c.user_id, via: 'whatsapp', entityType: 'whatsapp_link', entityId: link.id, action: 'linked', detail: { number: maskWaId(waId) } });
    }
    return { ok: true, userId: c.user_id } as const;
  })) as { ok: true; userId: string } | { ok: false; reason: 'bad_code' | 'too_many' };
}

// ------------------------------------------------------------------ the assistant

export interface AssistantDeps {
  readonly sender: ChatSender;
  /** Model router for free-text understanding and letter drafting; null turns both off. */
  readonly router: ModelRouter | null;
  /** The web app's address, for links in replies. */
  readonly siteUrl: string;
}

const STALE_PROCESSING = '10 minutes';
const LIST_SIZE = 5;
const CAMPAIGN_STATUS: Record<string, string> = {
  generating: 'being written',
  review: 'draft ready for review',
  generation_failed: 'could not be written',
  approved: 'approved',
  active: 'active',
  completed: 'completed',
  archived: 'archived',
};

interface Claimed {
  id: string;
  wa_id: string;
  kind: 'text' | 'button' | 'other';
  body: string;
}

/**
 * Answer every waiting inbound message, oldest first. Safe to run more than
 * once at a time: each message is claimed before it is handled, and a claim
 * abandoned for ten minutes is taken again.
 */
export async function processInbound(sql: Sql, deps: AssistantDeps, limit = 20): Promise<{ handled: number; failed: number }> {
  let handled = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const [m] = await sql<Claimed[]>`
      UPDATE whatsapp_messages SET status = 'processing', processing_started_at = now()
      WHERE id = (
        SELECT id FROM whatsapp_messages
        WHERE direction = 'in' AND (status = 'received' OR (status = 'processing' AND processing_started_at < now() - ${STALE_PROCESSING}::interval))
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, wa_id, kind, body
    `;
    if (!m) break;
    try {
      await handleMessage(sql, m, deps);
      await sql`UPDATE whatsapp_messages SET status = 'done' WHERE id = ${m.id}`;
      handled++;
    } catch (e) {
      failed++;
      const error = e instanceof Error ? e.message.slice(0, 500) : String(e);
      await sql`UPDATE whatsapp_messages SET status = 'failed', error = ${error} WHERE id = ${m.id}`;
    }
  }
  return { handled, failed };
}

async function reply(sql: Sql, deps: AssistantDeps, waId: string, userId: string | null, r: Reply): Promise<void> {
  let wamid: string | null;
  try {
    wamid = await deps.sender.send(waId, r);
  } catch (e) {
    await sql`
      INSERT INTO whatsapp_messages (direction, wa_id, user_id, kind, body, status, error)
      VALUES ('out', ${waId}, ${userId}, 'text', ${fitReply(r.text)}, 'failed', ${e instanceof Error ? e.message.slice(0, 500) : 'send failed'})
    `;
    throw e;
  }
  // Sent: record it as sent. A record that cannot be written must not make a sent reply look failed.
  await sql`
    INSERT INTO whatsapp_messages (wamid, direction, wa_id, user_id, kind, body, status, sent_at)
    VALUES (${wamid}, 'out', ${waId}, ${userId}, ${r.buttons?.length ? 'button' : 'text'}, ${fitReply(r.text)}, 'sent', now())
    ON CONFLICT (wamid) DO NOTHING
  `;
  if (r.listed) {
    await sql`
      INSERT INTO whatsapp_sessions (wa_id, listed) VALUES (${waId}, ${sql.json(r.listed as never)})
      ON CONFLICT (wa_id) DO UPDATE SET listed = EXCLUDED.listed, updated_at = now()
    `;
  }
}

async function handleMessage(sql: Sql, m: Claimed, deps: AssistantDeps): Promise<void> {
  const site = deps.siteUrl;
  let command = m.kind === 'other' ? ({ kind: 'unknown' } as Command) : parseCommand(m.body);

  if (command.kind === 'link') {
    const r = await linkByCode(sql, m.wa_id, command.code);
    if (!r.ok) return reply(sql, deps, m.wa_id, null, r.reason === 'too_many' ? tooManyCodesReply : badCodeReply);
    const ctx = await contextFor(sql, r.userId);
    const profile = ctx ? await getBusinessProfile(sql, ctx, (await ensureWorkspace(sql, ctx)).workspaceId) : null;
    return reply(sql, deps, m.wa_id, r.userId, linkedReply(profile?.licenseeName ?? ''));
  }

  const [link] = await sql<{ user_id: string }[]>`SELECT user_id FROM whatsapp_links WHERE wa_id = ${m.wa_id} AND revoked_at IS NULL`;
  const ctx = link ? await contextFor(sql, link.user_id) : null;
  if (!link || !ctx) return reply(sql, deps, m.wa_id, null, notLinkedReply(site));
  await sql`UPDATE whatsapp_messages SET user_id = ${ctx.userId} WHERE id = ${m.id}`;

  if (command.kind === 'unlink') {
    await sql.begin((tx) => revokeLink(tx, ctx.userId, 'whatsapp', 'unlinked_by_user'));
    return reply(sql, deps, m.wa_id, ctx.userId, unlinkedReply);
  }

  const { workspaceId } = await ensureWorkspace(sql, ctx);
  const [session] = await sql<{ listed: ListedItem[] }[]>`SELECT listed FROM whatsapp_sessions WHERE wa_id = ${m.wa_id}`;
  const listed = session?.listed ?? [];

  if (command.kind === 'unknown' && m.kind === 'text' && deps.router) {
    command = await understand(sql, deps.router, workspaceId, m.body, listed);
  }

  try {
    const r = await act(sql, ctx, workspaceId, command, listed, deps, m.wa_id);
    if (r) await reply(sql, deps, m.wa_id, ctx.userId, r);
  } catch (e) {
    // A refusal from a service (no permission, dismissed record…) is told to the agent as is.
    if (isServiceError(e)) return reply(sql, deps, m.wa_id, ctx.userId, { text: e.message });
    await reply(sql, deps, m.wa_id, ctx.userId, { text: `Something went wrong on GenCut's side. Try again, or use the app: ${site}` });
    throw e;
  }
}

async function contextFor(db: Db, userId: string): Promise<RequestContext | null> {
  const [u] = await db<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}`;
  return u ? { userId, email: u.email, via: 'whatsapp' } : null;
}

/** Free text the parser did not understand, mapped by the fast model to a command the parser accepts. */
async function understand(sql: Sql, router: ModelRouter, workspaceId: string, text: string, listed: readonly ListedItem[]): Promise<Command> {
  const prompt = intentPrompt(text, listed);
  const run = { workspaceId, purpose: 'assistant_intent', role: 'fast' as const, promptVersion: ASSISTANT_INTENT_PROMPT_VERSION, factKeys: [] };
  const route = router.route('fast');
  try {
    const response = await router.complete({ role: 'fast', system: prompt.system, user: prompt.user, maxOutputTokens: 100 });
    await recordModelRun(sql, run, { ok: true, response });
    try {
      return commandFromIntent(extractJson(response.text), listed);
    } catch {
      return { kind: 'unknown' };
    }
  } catch (e) {
    await recordModelRun(sql, run, { ok: false, provider: route.provider, model: route.model, error: e instanceof Error ? e.message : String(e) });
    return { kind: 'unknown' };
  }
}

async function act(
  sql: Sql,
  ctx: RequestContext,
  ws: string,
  command: Command,
  listed: readonly ListedItem[],
  deps: AssistantDeps,
  waId: string,
): Promise<Reply | null> {
  const site = deps.siteUrl;
  const item = 'n' in command ? listed.find((i) => i.n === command.n) : undefined;
  switch (command.kind) {
    case 'help':
      return helpReply(site);
    case 'summary': {
      const [profile, sellers, buyers, campaigns] = await Promise.all([
        getBusinessProfile(sql, ctx, ws),
        countOpportunities(sql, ctx, ws),
        countBuyers(sql, ctx, ws),
        listCampaigns(sql, ctx, ws),
      ]);
      return summaryReply(
        {
          name: profile?.licenseeName ?? '',
          sellers: sellers.active,
          buyers: buyers.active,
          drafting: campaigns.filter((c) => c.status === 'generating').length,
          inReview: campaigns.filter((c) => c.status === 'review').length,
        },
        site,
      );
    }
    case 'list': {
      if (command.target === 'sellers') {
        const items = await listOpportunities(sql, ctx, ws, { limit: LIST_SIZE });
        return sellersReply(
          items.map((o) => ({ id: o.id, score: o.score, address: o.address, zip: o.zip, propertyType: o.propertyType, topReason: o.reasons[0]?.text ?? null })),
          site,
        );
      }
      if (command.target === 'buyers') {
        const items = await listBuyers(sql, ctx, ws, { limit: LIST_SIZE });
        return buyersReply(
          items.map((b) => ({
            id: b.id,
            score: b.score,
            name: b.profile.name,
            purchases: b.profile.purchases,
            zips: b.profile.zips.map((z) => z.zip),
            latest: monthLabel(b.profile.latest.year, b.profile.latest.month),
          })),
          site,
        );
      }
      const items = (await listCampaigns(sql, ctx, ws)).slice(0, LIST_SIZE);
      return campaignsReply(items.map((c) => ({ id: c.id, title: c.title, status: CAMPAIGN_STATUS[c.status] ?? c.status })), site);
    }
    case 'show': {
      if (!item) return noListReply;
      if (item.kind === 'seller') {
        const o = await getOpportunity(sql, ctx, ws, item.id);
        return sellerDetailReply(
          { id: o.id, address: o.address, city: o.city, zip: o.zip, propertyType: o.propertyType, score: o.score, marketValue: o.justValue, reasons: o.reasons.map((r) => r.text) },
          item.n,
          site,
        );
      }
      if (item.kind === 'buyer') {
        const b = await getBuyer(sql, ctx, ws, item.id);
        const p = b.profile;
        const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
        return buyerDetailReply(
          {
            id: b.id,
            name: p.name,
            purchases: p.purchases,
            parcels: p.parcels ?? p.purchases,
            window: `${monthLabel(p.first.year, p.first.month)} to ${monthLabel(p.latest.year, p.latest.month)}`,
            zips: p.zips.map((z) => z.zip),
            homeTypes: p.homeTypes.map((t) => t.label.toLowerCase()),
            priceRange: p.price ? `${usd(p.price.min)} to ${usd(p.price.max)}` : null,
            score: b.score,
          },
          item.n,
          site,
        );
      }
      return letterFor(sql, ctx, ws, item.id, site);
    }
    case 'triage': {
      if (!item) return noListReply;
      if (item.kind === 'campaign') return { text: 'Campaigns are archived in the app.' };
      await setOpportunityStatus(sql, ctx, ws, item.id, command.status);
      return { text: `${command.status === 'saved' ? 'Saved' : 'Dismissed'}: ${item.label}.` };
    }
    case 'draft': {
      if (!item) return noListReply;
      if (item.kind === 'campaign') return letterFor(sql, ctx, ws, item.id, site);
      const existing = await listCampaigns(sql, ctx, ws, { opportunityId: item.id });
      if (existing[0]) return letterFor(sql, ctx, ws, existing[0].id, site);
      if (!deps.router) return { text: `Letter drafting is not switched on for this site yet.` };
      const { campaignId } = await startCampaignDraft(sql, ctx, ws, item.id);
      await reply(sql, deps, waId, ctx.userId, draftStartedReply(item.label));
      // Already in a background job: write the draft here and send it when it is ready.
      await generateCampaignDraft(sql, campaignId, deps.router);
      return letterFor(sql, ctx, ws, campaignId, site);
    }
    case 'link':
    case 'unlink':
      return null; // handled before an account is resolved
    case 'unknown':
      return unknownReply(site);
  }
}

async function letterFor(sql: Sql, ctx: RequestContext, ws: string, campaignId: string, site: string): Promise<Reply> {
  const c = await getCampaign(sql, ctx, ws, campaignId);
  return letterReply(
    {
      id: c.id,
      title: c.title,
      status: CAMPAIGN_STATUS[c.status] ?? c.status,
      greeting: c.draft?.letter.greeting ?? null,
      paragraphs: c.draft?.letter.paragraphs ?? [],
      error: c.status === 'generation_failed' ? (c.error ?? 'the draft did not pass the checks') : null,
    },
    site,
  );
}

