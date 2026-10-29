/**
 * Instagram comments as leads (D-024), through Meta's official Instagram API
 * with Instagram Login (graph.instagram.com).
 *
 * Pilot setup: one Instagram professional account, connected by an access
 * token generated in the Meta App Dashboard, belongs to one workspace
 * (INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_WORKSPACE_ID). GenCut checks the
 * account's recent posts for comments that contain a keyword and keeps only
 * those. Real-time comment webhooks and other agents connecting their own
 * accounts need Meta's Advanced Access (App Review); until then the check
 * runs when the agent opens the Leads tab or asks for it.
 *
 * Replies: the agent approves each one. One private reply per comment,
 * within 7 days, carrying the agent's lead-page link (Meta's rule).
 */

import { canPrivateReply, instagramReplyText, matchKeyword, parseKeywords } from '@gencut/core';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import { requireMembershipFor } from './membership.ts';

export const INSTAGRAM_API_VERSION = 'v26.0';
const BASE = `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;
/** How many recent posts are checked, and how often at most when the Leads tab opens. */
export const INSTAGRAM_POSTS_CHECKED = 10;
export const INSTAGRAM_AUTO_CHECK_SECONDS = 120;

export interface InstagramConfig {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly keywords: readonly string[];
}

export function instagramConfigFromEnv(env: Record<string, string | undefined> = process.env): InstagramConfig | null {
  const accessToken = env.INSTAGRAM_ACCESS_TOKEN?.trim() ?? '';
  const workspaceId = env.INSTAGRAM_WORKSPACE_ID?.trim() ?? '';
  if (!accessToken || !/^[0-9a-f-]{36}$/.test(workspaceId)) return null;
  return { accessToken, workspaceId, keywords: parseKeywords(env.INSTAGRAM_KEYWORDS) };
}

// ------------------------------------------------------------------ API client

export interface IgAccount {
  readonly userId: string;
  readonly username: string;
}
export interface IgMedia {
  readonly id: string;
  readonly permalink: string | null;
}
export interface IgComment {
  readonly id: string;
  readonly text: string;
  readonly username: string;
  readonly fromId: string | null;
  readonly timestamp: Date;
}

export interface InstagramClient {
  account(): Promise<IgAccount>;
  recentMedia(userId: string, limit: number): Promise<IgMedia[]>;
  comments(mediaId: string): Promise<IgComment[]>;
  privateReply(userId: string, commentId: string, text: string): Promise<string | null>;
}

export class GraphInstagramClient implements InstagramClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  constructor(token: string, fetchFn: typeof fetch = fetch) {
    this.token = token;
    this.fetchFn = fetchFn;
  }

  private async call<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
    const res = await this.fetchFn(`${BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${this.token}`, ...(init ? { 'content-type': 'application/json' } : {}) },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number } }) | null;
    if (!res.ok || !body || body.error) {
      const why = (body?.error?.message ?? `HTTP ${res.status}`).replaceAll(this.token, '[redacted]').slice(0, 300);
      throw new Error(`Instagram refused the request (${res.status}${body?.error?.code ? `, code ${body.error.code}` : ''}): ${why}`);
    }
    return body;
  }

  async account(): Promise<IgAccount> {
    const b = await this.call<{ user_id?: string; id?: string; username?: string }>('/me?fields=user_id,username');
    const userId = b.user_id ?? b.id;
    if (!userId || !b.username) throw new Error('Instagram did not return the account.');
    return { userId, username: b.username };
  }

  async recentMedia(userId: string, limit: number): Promise<IgMedia[]> {
    const b = await this.call<{ data?: { id: string; permalink?: string }[] }>(`/${encodeURIComponent(userId)}/media?fields=id,permalink&limit=${limit}`);
    return (b.data ?? []).map((m) => ({ id: m.id, permalink: m.permalink ?? null }));
  }

  async comments(mediaId: string): Promise<IgComment[]> {
    const b = await this.call<{ data?: { id: string; text?: string; username?: string; timestamp?: string; from?: { id?: string; username?: string } }[] }>(
      `/${encodeURIComponent(mediaId)}/comments?fields=id,text,username,timestamp,from&limit=50`,
    );
    return (b.data ?? []).flatMap((c) => {
      const username = c.from?.username ?? c.username;
      const at = c.timestamp ? new Date(c.timestamp) : null;
      return username && at && !Number.isNaN(at.getTime()) ? [{ id: c.id, text: c.text ?? '', username, fromId: c.from?.id ?? null, timestamp: at }] : [];
    });
  }

  async privateReply(userId: string, commentId: string, text: string): Promise<string | null> {
    const b = await this.call<{ message_id?: string }>(`/${encodeURIComponent(userId)}/messages`, {
      method: 'POST',
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
    return b.message_id ?? null;
  }
}

// ------------------------------------------------------------------ checking for comments

export interface SyncResult {
  readonly checked: boolean;
  readonly found: number;
  readonly error: string | null;
}

/**
 * Check the connected account's recent posts for keyword comments and store
 * new ones. Comments without a keyword, and the account's own comments, are
 * not stored. Records the time and any error on the account row.
 */
export async function syncInstagramComments(sql: Sql, config: InstagramConfig, client: InstagramClient): Promise<SyncResult> {
  const ws = config.workspaceId;
  let account: IgAccount;
  try {
    account = await client.account();
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not reach Instagram.';
    await sql`
      INSERT INTO instagram_accounts (workspace_id, ig_user_id, username, last_synced_at, last_error)
      VALUES (${ws}, '', '', now(), ${error})
      ON CONFLICT (workspace_id) DO UPDATE SET last_synced_at = now(), last_error = ${error}, updated_at = now()
    `;
    return { checked: false, found: 0, error };
  }
  let found = 0;
  let error: string | null = null;
  try {
    const media = await client.recentMedia(account.userId, INSTAGRAM_POSTS_CHECKED);
    for (const m of media) {
      for (const c of await client.comments(m.id)) {
        if (c.fromId === account.userId || c.username.toLowerCase() === account.username.toLowerCase()) continue;
        const keyword = matchKeyword(c.text, config.keywords);
        if (!keyword) continue;
        const [added] = await sql<{ comment_id: string }[]>`
          INSERT INTO instagram_comments (comment_id, workspace_id, media_id, permalink, from_id, username, text, keyword, commented_at)
          VALUES (${c.id}, ${ws}, ${m.id}, ${m.permalink}, ${c.fromId}, ${c.username}, ${c.text.slice(0, 2200)}, ${keyword}, ${c.timestamp})
          ON CONFLICT (comment_id) DO NOTHING RETURNING comment_id
        `;
        if (added) {
          found += 1;
          await recordAudit(sql, {
            workspaceId: ws, actorType: 'system', actorId: null, via: 'api', entityType: 'instagram_comment', entityId: c.id,
            action: 'created', detail: { keyword, mediaId: m.id },
          });
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not read the comments.';
  }
  await sql`
    INSERT INTO instagram_accounts (workspace_id, ig_user_id, username, last_synced_at, last_error)
    VALUES (${ws}, ${account.userId}, ${account.username}, now(), ${error})
    ON CONFLICT (workspace_id) DO UPDATE SET ig_user_id = ${account.userId}, username = ${account.username},
      last_synced_at = now(), last_error = ${error}, updated_at = now()
  `;
  return { checked: error === null, found, error };
}

/** Whether the automatic check is due for this workspace (none in the last two minutes). */
export async function instagramCheckDue(db: Db, workspaceId: string): Promise<boolean> {
  const [a] = await db<{ due: boolean }[]>`
    SELECT (last_synced_at IS NULL OR last_synced_at < now() - ${`${INSTAGRAM_AUTO_CHECK_SECONDS} seconds`}::interval) AS due
    FROM instagram_accounts WHERE workspace_id = ${workspaceId}
  `;
  return a ? a.due : true;
}

// ------------------------------------------------------------------ the Leads tab

export interface InstagramView {
  readonly connected: boolean;
  readonly username: string | null;
  readonly lastCheckedAt: Date | null;
  readonly lastError: string | null;
  readonly keywords: readonly string[];
  readonly comments: readonly {
    readonly id: string;
    readonly username: string;
    readonly text: string;
    readonly keyword: string;
    readonly permalink: string | null;
    readonly commentedAt: Date;
    readonly replyState: 'none' | 'sent' | 'failed';
    readonly replyError: string | null;
    readonly canReply: boolean;
  }[];
}

export async function getInstagramView(db: Db, ctx: RequestContext, workspaceId: string, config: InstagramConfig | null, now = new Date()): Promise<InstagramView> {
  await requireMembershipFor(db, ctx, workspaceId);
  const mine = config?.workspaceId === workspaceId;
  const [a] = mine
    ? await db<{ username: string; last_synced_at: Date | null; last_error: string | null }[]>`
        SELECT username, last_synced_at, last_error FROM instagram_accounts WHERE workspace_id = ${workspaceId}`
    : [];
  const rows = await db<{ comment_id: string; username: string; text: string; keyword: string; permalink: string | null; commented_at: Date; reply_state: 'none' | 'sent' | 'failed'; reply_error: string | null }[]>`
    SELECT comment_id, username, text, keyword, permalink, commented_at, reply_state, reply_error FROM instagram_comments
    WHERE workspace_id = ${workspaceId} AND status = 'new' ORDER BY commented_at DESC LIMIT 20
  `;
  return {
    connected: mine,
    username: a?.username || null,
    lastCheckedAt: a?.last_synced_at ?? null,
    lastError: a?.last_error ?? null,
    keywords: config?.keywords ?? [],
    comments: rows.map((r) => ({
      id: r.comment_id, username: r.username, text: r.text, keyword: r.keyword, permalink: r.permalink, commentedAt: r.commented_at,
      replyState: r.reply_state, replyError: r.reply_error, canReply: r.reply_state !== 'sent' && canPrivateReply(r.commented_at, now),
    })),
  };
}

/** The agent's request to check now. Only for the connected workspace. */
export async function checkInstagramNow(sql: Sql, ctx: RequestContext, workspaceId: string, config: InstagramConfig | null, client: InstagramClient): Promise<SyncResult> {
  await requireMembershipFor(sql, ctx, workspaceId);
  if (!config || config.workspaceId !== workspaceId) throw new ServiceError('invalid', 'Instagram is not connected to this account.');
  return syncInstagramComments(sql, config, client);
}

/**
 * Send the agent's lead-page link to the commenter as a private reply. The
 * agent's click is the approval; one reply per comment, within 7 days.
 */
export async function sendInstagramLink(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  commentId: string,
  link: string,
  config: InstagramConfig | null,
  client: InstagramClient,
  now = new Date(),
): Promise<{ sent: boolean; error: string | null }> {
  await requireMembershipFor(sql, ctx, workspaceId);
  if (!config || config.workspaceId !== workspaceId) throw new ServiceError('invalid', 'Instagram is not connected to this account.');
  const [c] = await sql<{ username: string; commented_at: Date; reply_state: string }[]>`
    SELECT username, commented_at, reply_state FROM instagram_comments WHERE comment_id = ${commentId} AND workspace_id = ${workspaceId}
  `;
  if (!c) throw new ServiceError('not_found', 'That comment is not here any more.');
  if (c.reply_state === 'sent') throw new ServiceError('invalid', 'You already sent this person the link.');
  if (!canPrivateReply(c.commented_at, now)) throw new ServiceError('invalid', 'Instagram allows a private reply only within 7 days of the comment.');
  const [acct] = await sql<{ ig_user_id: string }[]>`SELECT ig_user_id FROM instagram_accounts WHERE workspace_id = ${workspaceId}`;
  if (!acct?.ig_user_id) throw new ServiceError('invalid', 'Check Instagram first, so GenCut knows the account.');
  const [p] = await sql<{ licensee_name: string | null }[]>`SELECT licensee_name FROM business_profiles WHERE workspace_id = ${workspaceId}`;
  const first = (p?.licensee_name ?? '').split(' ')[0] || 'your agent';
  const text = instagramReplyText(c.username, first, link);
  try {
    const messageId = await client.privateReply(acct.ig_user_id, commentId, text);
    await sql.begin(async (tx) => {
      await tx`UPDATE instagram_comments SET reply_state = 'sent', replied_at = now(), replied_by = ${ctx.userId}, reply_error = NULL WHERE comment_id = ${commentId}`;
      await recordAudit(tx, {
        workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'instagram_comment', entityId: commentId,
        action: 'private_reply_sent', toState: 'sent', detail: { messageId },
      });
    });
    return { sent: true, error: null };
  } catch (e) {
    const error = (e instanceof Error ? e.message : 'Instagram did not accept the reply.').slice(0, 500);
    await sql.begin(async (tx) => {
      await tx`UPDATE instagram_comments SET reply_state = 'failed', reply_error = ${error} WHERE comment_id = ${commentId}`;
      await recordAudit(tx, {
        workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'instagram_comment', entityId: commentId,
        action: 'private_reply_failed', toState: 'failed',
      });
    });
    return { sent: false, error };
  }
}

export async function dismissInstagramComment(sql: Sql, ctx: RequestContext, workspaceId: string, commentId: string): Promise<void> {
  await requireMembershipFor(sql, ctx, workspaceId);
  await sql.begin(async (tx) => {
    const [r] = await tx<{ comment_id: string }[]>`
      UPDATE instagram_comments SET status = 'dismissed' WHERE comment_id = ${commentId} AND workspace_id = ${workspaceId} AND status = 'new' RETURNING comment_id
    `;
    if (r) {
      await recordAudit(tx, {
        workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'instagram_comment', entityId: commentId,
        action: 'state_change', fromState: 'new', toState: 'dismissed',
      });
    }
  });
}
