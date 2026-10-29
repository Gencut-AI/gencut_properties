/**
 * Outreach email: prepare a campaign letter as an email, let the agent approve
 * that exact message, then send it through the compliance gate.
 *
 * Three separate decisions are recorded, in order:
 * 1. The workspace turns on contact by email (`contact` permission, channel email).
 * 2. The agent approves one exact message to one recipient (READY → APPROVED).
 * 3. The executor sends it only if the gate passes at that moment
 *    (APPROVED → EXECUTING → COMPLETED, or FAILED with the reasons).
 *
 * Until counsel reviews live outreach, deploys run in `test_only` mode: real
 * messages, but only to the team's test inboxes (docs/decisions.md D-021).
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  checkOutreachTransition,
  checkSubject,
  composeOutreachEmail,
  defaultSubject,
  EMAIL_COMPOSER_VERSION,
  evaluateGate,
  isTestInbox,
  MVP_AVAILABLE_CHANNELS,
  normalizeEmail,
  parseEmailSendingMode,
  parseTestInboxes,
  sendingAllows,
  type CampaignDraft,
  type EmailLetter,
  type EmailSendingMode,
  type GateCheck,
  type OutreachState,
} from '@gencut/core';
import { getPermissions } from './accounts.ts';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';
import { requireMembership } from './membership.ts';

// ------------------------------------------------------------------ configuration

export interface EmailConfig {
  readonly apiKey: string;
  /** Bare sending address on a verified domain, e.g. outreach@mail.gencut.ai. */
  readonly fromAddress: string;
  readonly mode: EmailSendingMode;
  readonly testInboxes: readonly string[];
  /** Signs unsubscribe links. */
  readonly unsubscribeSecret: string;
  /** Public origin for unsubscribe links, e.g. https://gencutv1.netlify.app */
  readonly siteUrl: string;
}

/** Email settings from the environment; null when sending is not set up on this deploy. */
export function emailConfigFromEnv(env: Record<string, string | undefined> = process.env): EmailConfig | null {
  const v = (k: string) => env[k]?.trim() || '';
  const fromAddress = normalizeEmail(v('GENCUT_EMAIL_FROM'));
  const siteUrl = v('GENCUT_SITE_URL').replace(/\/+$/, '');
  const apiKey = v('RESEND_API_KEY');
  const unsubscribeSecret = v('GENCUT_UNSUBSCRIBE_SECRET');
  if (!apiKey || !fromAddress || unsubscribeSecret.length < 16 || !/^https?:\/\//.test(siteUrl)) return null;
  return {
    apiKey,
    fromAddress,
    mode: parseEmailSendingMode(env.GENCUT_EMAIL_MODE),
    testInboxes: parseTestInboxes(env.GENCUT_EMAIL_TEST_INBOXES),
    unsubscribeSecret,
    siteUrl,
  };
}

// ------------------------------------------------------------------ transport

export interface OutboundEmail {
  readonly from: string;
  readonly replyTo: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The outreach action id: a retried send is never delivered twice. */
  readonly idempotencyKey: string;
}

export interface EmailTransport {
  send(message: OutboundEmail): Promise<{ id: string | null }>;
}

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendTransport implements EmailTransport {
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  constructor(apiKey: string, fetchFn: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  async send(m: OutboundEmail): Promise<{ id: string | null }> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': m.idempotencyKey,
      },
      body: JSON.stringify({
        from: m.from,
        to: [m.to],
        reply_to: m.replyTo,
        subject: m.subject,
        text: m.text,
        html: m.html,
        headers: m.headers,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
    if (!res.ok) {
      const why = (body?.message ?? `HTTP ${res.status}`).replaceAll(this.apiKey, '[redacted]').slice(0, 300);
      throw new Error(`The email service refused the message (${res.status}${body?.name ? `, ${body.name}` : ''}): ${why}`);
    }
    return { id: body?.id ?? null };
  }
}

/** Keeps messages in memory, for tests. Set `failWith` to simulate a provider error. */
export class RecordedEmailTransport implements EmailTransport {
  readonly sent: OutboundEmail[] = [];
  failWith: string | null = null;
  async send(m: OutboundEmail): Promise<{ id: string | null }> {
    if (this.failWith) throw new Error(this.failWith);
    this.sent.push(m);
    return { id: `recorded-${randomUUID()}` };
  }
}

// ------------------------------------------------------------------ unsubscribe links

const sign = (secret: string, actionId: string) =>
  createHmac('sha256', secret).update(`gencut-unsubscribe:${actionId}`).digest('base64url').slice(0, 32);

export function unsubscribeToken(secret: string, actionId: string): string {
  return `${actionId}.${sign(secret, actionId)}`;
}

export function unsubscribeUrl(config: Pick<EmailConfig, 'siteUrl' | 'unsubscribeSecret'>, actionId: string): string {
  return `${config.siteUrl}/u/${unsubscribeToken(config.unsubscribeSecret, actionId)}`;
}

/** The action id a token was issued for, or null if it was not issued with this secret. */
export function verifyUnsubscribeToken(secret: string, token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/.exec(token.trim());
  if (!m?.[1] || !m[2]) return null;
  const expected = Buffer.from(sign(secret, m[1]));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? m[1] : null;
}

/**
 * Record an opt-out from an unsubscribe link. No sign-in: the signed token is
 * the authority. Idempotent; returns whether the token was valid.
 */
export async function unsubscribeByToken(sql: Sql, secret: string, token: string): Promise<{ ok: boolean; sender: string | null }> {
  const actionId = verifyUnsubscribeToken(secret, token);
  if (!actionId) return { ok: false, sender: null };
  return sql.begin(async (tx) => {
    const [a] = await tx<{ workspace_id: string; content: EmailContent }[]>`
      SELECT workspace_id, content FROM outreach_actions WHERE id = ${actionId} AND channel = 'email'
    `;
    if (!a?.content?.to) return { ok: false, sender: null };
    const [added] = await tx<{ id: string }[]>`
      INSERT INTO suppressions (workspace_id, channel, address, reason)
      VALUES (${a.workspace_id}, 'email', ${a.content.to}, 'unsubscribe_link')
      ON CONFLICT DO NOTHING RETURNING id
    `;
    if (added) {
      await recordAudit(tx, {
        workspaceId: a.workspace_id, actorType: 'system', actorId: null, via: 'api', entityType: 'suppression', entityId: added.id,
        action: 'created', detail: { channel: 'email', reason: 'unsubscribe_link', outreachActionId: actionId },
      });
    }
    return { ok: true, sender: a.content.fromName ?? null };
  });
}

// ------------------------------------------------------------------ prepare, approve, send

/** What is stored on an email outreach action. Frozen once approved. */
interface EmailContent {
  readonly kind: 'email';
  readonly composer: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly fromName: string;
  /** The campaign letter this message was built from, to detect later edits. */
  readonly letter: EmailLetter;
}

interface ActionRow {
  id: string;
  campaign_id: string;
  state: OutreachState;
  subject_key: string;
  content: EmailContent;
  approved_at: Date | null;
  executed_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EmailOutreachView {
  /** Sending is set up on this deploy. */
  readonly configured: boolean;
  readonly mode: EmailSendingMode;
  /** The workspace has turned on contact by email. */
  readonly permitted: boolean;
  /** Profile fields every email needs that are still empty. */
  readonly missing: readonly string[];
  readonly defaultSubject: string;
  readonly action: {
    readonly id: string;
    readonly state: OutreachState;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly fromName: string;
    /** The letter was edited after this email was prepared; prepare it again. */
    readonly stale: boolean;
    readonly approvedAt: Date | null;
    readonly sentAt: Date | null;
    readonly failureReason: string | null;
    readonly updatedAt: Date;
  } | null;
  /** Addresses this campaign has already emailed. */
  readonly sentTo: readonly string[];
}

const sameLetter = (a: EmailLetter | undefined, b: EmailLetter | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

interface SenderProfile {
  licensee_name: string | null;
  brokerage_name: string | null;
  license_number: string | null;
  office_address: string | null;
}

function missingFields(p: SenderProfile | undefined): string[] {
  const missing: string[] = [];
  if (!p?.licensee_name?.trim()) missing.push('your name');
  if (!p?.brokerage_name?.trim()) missing.push('your brokerage');
  if (!p?.office_address?.trim()) missing.push('your office address');
  return missing;
}

async function senderProfile(db: Db, workspaceId: string): Promise<SenderProfile | undefined> {
  const [p] = await db<SenderProfile[]>`
    SELECT licensee_name, brokerage_name, license_number, office_address FROM business_profiles WHERE workspace_id = ${workspaceId}
  `;
  return p;
}

async function campaignForEmail(db: Db, workspaceId: string, campaignId: string): Promise<{ status: string; draft: CampaignDraft; opportunity_id: string | null }> {
  if (!/^[0-9a-f-]{36}$/.test(campaignId)) throw new ServiceError('not_found', 'That campaign does not exist.');
  const [c] = await db<{ status: string; draft: CampaignDraft | null; opportunity_id: string | null }[]>`
    SELECT status, draft, opportunity_id FROM campaigns WHERE workspace_id = ${workspaceId} AND id = ${campaignId}
  `;
  if (!c) throw new ServiceError('not_found', 'That campaign does not exist.');
  if (!c.draft || !['review', 'approved', 'active'].includes(c.status)) {
    throw new ServiceError('invalid', 'This campaign has no finished letter to send yet.');
  }
  return { status: c.status, draft: c.draft, opportunity_id: c.opportunity_id };
}

async function isSuppressed(db: Db, workspaceId: string, email: string): Promise<boolean> {
  const [r] = await db<{ s: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM suppressions WHERE workspace_id = ${workspaceId}
                   AND (channel = 'email' OR channel IS NULL) AND lower(address) = ${email.toLowerCase()}) AS s
  `;
  return r?.s === true;
}

export async function getEmailOutreach(
  db: Db,
  ctx: RequestContext,
  workspaceId: string,
  campaignId: string,
  config: EmailConfig | null,
): Promise<EmailOutreachView> {
  await requireMembership(db, ctx.userId, workspaceId);
  const [c] = await db<{ draft: CampaignDraft | null }[]>`SELECT draft FROM campaigns WHERE workspace_id = ${workspaceId} AND id = ${campaignId}`;
  if (!c) throw new ServiceError('not_found', 'That campaign does not exist.');
  const [perms, profile, rows] = await Promise.all([
    getPermissions(db, ctx, workspaceId),
    senderProfile(db, workspaceId),
    db<ActionRow[]>`
      SELECT id, campaign_id, state, subject_key, content, approved_at, executed_at, failure_reason, created_at, updated_at
      FROM outreach_actions WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId} AND channel = 'email'
      ORDER BY created_at DESC
    `,
  ]);
  const latest = rows[0];
  return {
    configured: config !== null,
    mode: config?.mode ?? 'off',
    permitted: perms.contact.email,
    missing: missingFields(profile),
    defaultSubject: defaultSubject({ name: profile?.licensee_name ?? 'your agent', brokerage: profile?.brokerage_name ?? '' }),
    action: latest
      ? {
          id: latest.id,
          state: latest.state,
          to: latest.content.to,
          subject: latest.content.subject,
          text: latest.content.text,
          fromName: latest.content.fromName,
          stale: !['EXECUTING', 'COMPLETED'].includes(latest.state) && !sameLetter(latest.content.letter, c.draft?.letter),
          approvedAt: latest.approved_at,
          sentAt: latest.state === 'COMPLETED' ? latest.executed_at : null,
          failureReason: latest.failure_reason,
          updatedAt: latest.updated_at,
        }
      : null,
    sentTo: rows.filter((r) => r.state === 'COMPLETED').map((r) => r.content.to),
  };
}

/** Turn on contact by email for the workspace. Owners only; recorded in the audit log. */
export async function enableEmailOutreach(sql: Sql, ctx: RequestContext, workspaceId: string): Promise<void> {
  const role = await requireMembership(sql, ctx.userId, workspaceId);
  if (role !== 'owner') throw new ServiceError('forbidden', 'Only the account owner can turn on email outreach.');
  await sql.begin(async (tx) => {
    const [added] = await tx<{ id: string }[]>`
      INSERT INTO workspace_permissions (workspace_id, kind, channel, granted_by)
      VALUES (${workspaceId}, 'contact', 'email', ${ctx.userId})
      ON CONFLICT DO NOTHING RETURNING id
    `;
    if (added) {
      await recordAudit(tx, {
        workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'permission', entityId: added.id,
        action: 'granted', detail: { kind: 'contact', channel: 'email' },
      });
    }
  });
}

/**
 * Build the email for a campaign's letter and leave it READY for approval.
 * Replaces an earlier unsent email for the same campaign.
 */
export async function prepareEmailOutreach(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  campaignId: string,
  input: { to: string; subject: string },
  config: EmailConfig | null,
): Promise<{ actionId: string }> {
  await requireMembership(sql, ctx.userId, workspaceId);
  if (!config) throw new ServiceError('invalid', 'Email sending is not set up on this site yet.');
  const campaign = await campaignForEmail(sql, workspaceId, campaignId);

  const to = normalizeEmail(input.to);
  if (!to) throw new ServiceError('invalid', 'Check the email address.', { to: 'Enter a valid email address.' });
  const subjectProblems = checkSubject(input.subject);
  if (subjectProblems.length) throw new ServiceError('invalid', subjectProblems[0] ?? 'Check the subject.', { subject: subjectProblems.join(' ') });
  if (!sendingAllows(config.mode, config.testInboxes, to)) {
    const msg =
      config.mode === 'test_only'
        ? 'GenCut is in test mode: email can only go to the team’s approved test inboxes until live sending is switched on.'
        : 'Email sending is switched off on this site.';
    throw new ServiceError('invalid', msg, { to: msg });
  }
  if (await isSuppressed(sql, workspaceId, to)) {
    throw new ServiceError('invalid', 'This address has unsubscribed from your emails.', { to: 'This address has unsubscribed from your emails.' });
  }
  const profile = await senderProfile(sql, workspaceId);
  const missing = missingFields(profile);
  if (missing.length || !profile) throw new ServiceError('invalid', `Add ${missing.join(', ')} in Profile first: every email must include them.`);

  return sql.begin(async (tx) => {
    const rows = await tx<ActionRow[]>`
      SELECT id, campaign_id, state, subject_key, content, approved_at, executed_at, failure_reason, created_at, updated_at
      FROM outreach_actions WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId} AND channel = 'email'
      ORDER BY created_at DESC FOR UPDATE
    `;
    if (rows.some((r) => r.state === 'APPROVED' || r.state === 'EXECUTING')) {
      throw new ServiceError('invalid', 'An email from this campaign is being sent right now.');
    }
    if (rows.some((r) => r.state === 'COMPLETED' && r.content.to === to)) {
      throw new ServiceError('invalid', 'This campaign has already emailed that address.', { to: 'Already emailed from this campaign.' });
    }
    const open = rows.find((r) => r.state === 'DRAFT' || r.state === 'READY' || r.state === 'FAILED');
    const id = open?.id ?? randomUUID();
    const sender = {
      name: profile.licensee_name ?? '',
      brokerage: profile.brokerage_name ?? '',
      licenseNumber: profile.license_number,
      postalAddress: profile.office_address ?? '',
    };
    const composed = composeOutreachEmail({ letter: campaign.draft.letter, subject: input.subject, sender, unsubscribeUrl: unsubscribeUrl(config, id) });
    const content: EmailContent = {
      kind: 'email', composer: EMAIL_COMPOSER_VERSION, to, subject: composed.subject, text: composed.text, html: composed.html,
      fromName: composed.fromName, letter: campaign.draft.letter,
    };

    let from: OutreachState | null = null;
    if (!open) {
      const [opp] = await tx<{ subject_key: string }[]>`SELECT subject_key FROM opportunities WHERE id = ${campaign.opportunity_id}`;
      await tx`
        INSERT INTO outreach_actions (id, workspace_id, campaign_id, channel, subject_key, content)
        VALUES (${id}, ${workspaceId}, ${campaignId}, 'email', ${opp?.subject_key ?? campaignId}, ${tx.json(content as never)})
      `;
    } else {
      from = open.state;
      // Back to DRAFT with the new content (FAILED and READY may both return to DRAFT), then mark it ready.
      await tx`UPDATE outreach_actions SET state = 'DRAFT', content = ${tx.json(content as never)}, failure_reason = NULL WHERE id = ${id}`;
    }
    await tx`UPDATE outreach_actions SET state = 'READY' WHERE id = ${id}`;
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'outreach_action', entityId: id,
      action: 'prepared', fromState: from, toState: 'READY',
      detail: { channel: 'email', campaignId, recipientDomain: to.split('@')[1], composer: EMAIL_COMPOSER_VERSION, mode: config.mode },
    });
    return { actionId: id };
  });
}

export interface SendResult {
  readonly state: 'COMPLETED' | 'FAILED';
  readonly failureReason: string | null;
  readonly checks: readonly GateCheck[];
}

/**
 * The agent approves this exact email, and GenCut sends it if the compliance
 * gate passes. Approval and execution are separate, audited transitions.
 */
export async function approveAndSendEmail(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  actionId: string,
  config: EmailConfig | null,
  transport: EmailTransport,
  now: () => Date = () => new Date(),
): Promise<SendResult> {
  await requireMembership(sql, ctx.userId, workspaceId);
  if (!config) throw new ServiceError('invalid', 'Email sending is not set up on this site yet.');
  if (!/^[0-9a-f-]{36}$/.test(actionId)) throw new ServiceError('not_found', 'That email does not exist.');

  await sql.begin(async (tx) => {
    const [a] = await tx<ActionRow[]>`
      SELECT id, campaign_id, state, subject_key, content, approved_at, executed_at, failure_reason, created_at, updated_at
      FROM outreach_actions WHERE id = ${actionId} AND workspace_id = ${workspaceId} AND channel = 'email' FOR UPDATE
    `;
    if (!a) throw new ServiceError('not_found', 'That email does not exist.');
    const t = checkOutreachTransition({ from: a.state, to: 'APPROVED', actor: 'user', approvedBy: ctx.userId });
    if (!t.ok) throw new ServiceError('invalid', a.state === 'COMPLETED' ? 'This email was already sent.' : 'This email is not ready to approve.');
    const [c] = await tx<{ draft: CampaignDraft | null }[]>`SELECT draft FROM campaigns WHERE id = ${a.campaign_id}`;
    if (!sameLetter(a.content.letter, c?.draft?.letter)) {
      throw new ServiceError('invalid', 'The letter changed after this email was prepared. Prepare it again so you approve what will be sent.');
    }
    await tx`UPDATE outreach_actions SET state = 'APPROVED', approved_by = ${ctx.userId}, approved_at = now() WHERE id = ${actionId}`;
    await recordAudit(tx, {
      workspaceId, actorType: 'user', actorId: ctx.userId, via: ctx.via, entityType: 'outreach_action', entityId: actionId,
      action: 'approved', fromState: 'READY', toState: 'APPROVED', detail: { channel: 'email' },
    });
  });

  return executeEmail(sql, workspaceId, actionId, config, transport, now, ctx.email);
}

/** Send an APPROVED email if the gate passes. Only this function moves an email past APPROVED. */
async function executeEmail(
  sql: Sql,
  workspaceId: string,
  actionId: string,
  config: EmailConfig,
  transport: EmailTransport,
  now: () => Date,
  replyTo: string,
): Promise<SendResult> {
  const executor = { workspaceId, actorType: 'executor', actorId: null, via: 'api', entityType: 'outreach_action', entityId: actionId } as const;

  const gate = await sql.begin(async (tx) => {
    const [a] = await tx<ActionRow[]>`
      SELECT id, campaign_id, state, subject_key, content, approved_at, executed_at, failure_reason, created_at, updated_at
      FROM outreach_actions WHERE id = ${actionId} AND workspace_id = ${workspaceId} FOR UPDATE
    `;
    if (!a || a.state !== 'APPROVED') throw new ServiceError('invalid', 'This email is not approved.');
    const [perms] = await tx<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM workspace_permissions WHERE workspace_id = ${workspaceId}
                     AND kind = 'contact' AND channel = 'email' AND revoked_at IS NULL) AS ok
    `;
    const profile = await senderProfile(tx, workspaceId);
    const suppressed = await isSuppressed(tx, workspaceId, a.content.to);
    const contact = Object.fromEntries((['email', 'mail', 'call', 'sms', 'whatsapp'] as const).map((ch) => [ch, ch === 'email' && perms?.ok === true]));
    const decision = evaluateGate({
      action: { channel: 'email', state: a.state, subjectKey: a.subject_key },
      recipient: { email: a.content.to, basis: 'none' },
      sender: { brokerageName: profile?.brokerage_name ?? '', ...(profile?.office_address ? { postalAddress: profile.office_address } : {}) },
      content: {
        text: a.content.text,
        hasUnsubscribeLink: a.content.text.includes(unsubscribeUrl(config, actionId)),
        identifiesAsAdvertisement: /this email is an advertisement/i.test(a.content.text),
      },
      permissions: { discover: true, generate: true, contact: contact as Record<'email' | 'mail' | 'call' | 'sms' | 'whatsapp', boolean> },
      platform: {
        availableChannels: MVP_AVAILABLE_CHANNELS,
        liveEmailSending: config.mode === 'live',
        emailTestRecipient: config.mode === 'test_only' && isTestInbox(a.content.to, config.testInboxes),
      },
      suppressed,
      consents: [],
      recentAttempts: [],
      now: now(),
    });
    const failed = decision.checks.filter((c) => !c.passed);
    if (!decision.allowed) {
      const reason = failed.map((c) => c.detail).join(' ');
      await tx`UPDATE outreach_actions SET state = 'FAILED', failure_reason = ${reason} WHERE id = ${actionId}`;
      await recordAudit(tx, {
        ...executor, action: 'blocked', fromState: 'APPROVED', toState: 'FAILED',
        detail: { policyVersion: decision.policyVersion, failed: failed.map((c) => c.code) },
      });
    } else {
      await tx`UPDATE outreach_actions SET state = 'EXECUTING' WHERE id = ${actionId}`;
      await recordAudit(tx, {
        ...executor, action: 'gate_passed', fromState: 'APPROVED', toState: 'EXECUTING',
        detail: { policyVersion: decision.policyVersion, checks: decision.checks.map((c) => c.code), mode: config.mode },
      });
    }
    return { decision, content: a.content, reason: decision.allowed ? null : failed.map((c) => c.detail).join(' ') };
  });

  if (!gate.decision.allowed) return { state: 'FAILED', failureReason: gate.reason, checks: gate.decision.checks };

  const c = gate.content;
  const unsubscribe = unsubscribeUrl(config, actionId);
  try {
    const { id } = await transport.send({
      from: `${c.fromName} <${config.fromAddress}>`,
      replyTo,
      to: c.to,
      subject: c.subject,
      text: c.text,
      html: c.html,
      headers: {
        // RFC 8058 one-click unsubscribe, which mailbox providers show as an "Unsubscribe" button.
        'List-Unsubscribe': `<${config.siteUrl}/api/unsubscribe?t=${encodeURIComponent(unsubscribeToken(config.unsubscribeSecret, actionId))}>, <${unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      idempotencyKey: actionId,
    });
    await sql.begin(async (tx) => {
      await tx`UPDATE outreach_actions SET state = 'COMPLETED', executed_at = now() WHERE id = ${actionId} AND state = 'EXECUTING'`;
      await recordAudit(tx, { ...executor, action: 'sent', fromState: 'EXECUTING', toState: 'COMPLETED', detail: { channel: 'email', providerMessageId: id } });
    });
    return { state: 'COMPLETED', failureReason: null, checks: gate.decision.checks };
  } catch (e) {
    const reason = (e instanceof Error ? e.message : 'The email service did not accept the message.').slice(0, 500);
    await sql.begin(async (tx) => {
      await tx`UPDATE outreach_actions SET state = 'FAILED', failure_reason = ${reason} WHERE id = ${actionId} AND state = 'EXECUTING'`;
      await recordAudit(tx, { ...executor, action: 'send_failed', fromState: 'EXECUTING', toState: 'FAILED', detail: { channel: 'email' } });
    });
    return { state: 'FAILED', failureReason: reason, checks: gate.decision.checks };
  }
}
