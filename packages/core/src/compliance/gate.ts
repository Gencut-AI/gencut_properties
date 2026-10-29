import type { Channel } from '../channels.ts';
import type { OutreachState } from '../outreach/action-state.ts';
import { isPermitted, type WorkspacePermissions } from '../permissions/permissions.ts';

/**
 * The compliance gate: the single function that decides whether an approved
 * outreach action may execute right now. The executor calls it immediately
 * before sending; nothing else may send.
 *
 * Design rules
 * - Fail closed: missing information (no time zone, unknown do-not-call status)
 *   blocks the action instead of assuming it is fine.
 * - Every check is reported, passed or not, so the audit log shows exactly why
 *   an action ran or was blocked.
 * - Rules are engineering requirements derived from primary sources listed in
 *   docs/compliance.md. They are not legal advice and are reviewed by counsel
 *   before any live sending is enabled.
 */
export const GATE_POLICY_VERSION = '2026-10-29';

/** Why GenCut believes it may contact this person at all. */
export const CONTACT_BASES = ['none', 'prior_relationship', 'express_request', 'responded_to_ad'] as const;
export type ContactBasis = (typeof CONTACT_BASES)[number];

export const CONSENT_SCOPES = [
  'email_marketing',
  'marketing_texts',
  'automated_marketing_calls',
  'whatsapp_marketing',
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export interface ConsentRecord {
  readonly channel: Channel;
  /** Phone in E.164 form, or an email address, exactly as consented. */
  readonly address: string;
  readonly scopes: readonly ConsentScope[];
  /** Signed (electronic signature or affirmative act), per Fla. Stat. 501.059(1)(h). */
  readonly writtenSignature: boolean;
  /** The "not a condition of purchase" disclosure was shown at signing. */
  readonly disclosureShown: boolean;
  readonly obtainedAt: Date;
  readonly revokedAt?: Date;
}

export interface GateInput {
  readonly action: {
    readonly channel: Channel;
    readonly state: OutreachState;
    /** Groups attempts "on the same subject" for call-frequency limits. */
    readonly subjectKey: string;
  };
  readonly recipient: {
    readonly email?: string;
    /** E.164, e.g. +13055550100 */
    readonly phone?: string;
    readonly postalAddress?: string;
    /** IANA zone, e.g. America/New_York */
    readonly timeZone?: string;
    readonly basis: ContactBasis;
    /** undefined = not screened yet, which blocks call and text channels. */
    readonly onFloridaDoNotCall?: boolean;
    readonly onNationalDoNotCall?: boolean;
  };
  readonly sender: {
    /** Licensed brokerage name as registered with Florida DBPR. */
    readonly brokerageName: string;
    readonly postalAddress?: string;
  };
  readonly content: {
    /** Full outgoing text: email body, letter, call script or message. */
    readonly text: string;
    readonly hasUnsubscribeLink?: boolean;
    readonly identifiesAsAdvertisement?: boolean;
    readonly whatsappTemplateId?: string;
  };
  readonly permissions: WorkspacePermissions;
  readonly platform: {
    readonly availableChannels: ReadonlySet<Channel>;
    readonly liveEmailSending: boolean;
    /**
     * The recipient is one of this deploy's test inboxes. While live sending is
     * off, email may still go to these (the team's own addresses), so the whole
     * flow can be exercised before counsel review.
     */
    readonly emailTestRecipient?: boolean;
  };
  /** Recipient is on this workspace's suppression list for this channel or all channels. */
  readonly suppressed: boolean;
  readonly consents: readonly ConsentRecord[];
  readonly recentAttempts: readonly {
    readonly at: Date;
    readonly channel: Channel;
    readonly subjectKey: string;
  }[];
  readonly now: Date;
}

export const GATE_CHECK_CODES = [
  'action_approved',
  'contact_permission',
  'channel_available',
  'not_suppressed',
  'brokerage_name_present',
  'recipient_address_present',
  'email_sender_postal_address',
  'email_unsubscribe_link',
  'email_ad_disclosure',
  'email_live_sending_enabled',
  'do_not_call_screened',
  'florida_do_not_call',
  'national_do_not_call',
  'calling_hours',
  'call_frequency',
  'written_consent',
  'whatsapp_opt_in',
  'whatsapp_template',
] as const;
export type GateCheckCode = (typeof GATE_CHECK_CODES)[number];

export interface GateCheck {
  readonly code: GateCheckCode;
  readonly passed: boolean;
  readonly detail: string;
}

export interface GateDecision {
  readonly allowed: boolean;
  readonly checks: readonly GateCheck[];
  readonly policyVersion: string;
}

/** Fla. Stat. 501.616(6)(a): no calls before 8 a.m. or after 8 p.m. recipient local time. */
export const CALLING_WINDOW = { startHour: 8, endHour: 20 } as const;
/** Fla. Stat. 501.616(6)(b): at most three calls per 24 hours on the same subject. */
export const MAX_CALLS_PER_24H_SAME_SUBJECT = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateGate(input: GateInput): GateDecision {
  const checks: GateCheck[] = [];
  const add = (code: GateCheckCode, passed: boolean, detail: string) => checks.push({ code, passed, detail });
  const { action, recipient, sender, content } = input;
  const channel = action.channel;

  add(
    'action_approved',
    action.state === 'APPROVED',
    action.state === 'APPROVED' ? 'Approved by a user.' : `Action is ${action.state}, not APPROVED.`,
  );
  const permitted = isPermitted(input.permissions, { kind: 'contact', channel });
  add(
    'contact_permission',
    permitted,
    permitted ? `Workspace may contact by ${channel}.` : `Workspace has not enabled contact by ${channel}.`,
  );
  const available = input.platform.availableChannels.has(channel);
  add(
    'channel_available',
    available,
    available ? `${channel} is available.` : `${channel} is not available in this release.`,
  );
  add(
    'not_suppressed',
    !input.suppressed,
    input.suppressed ? 'Recipient opted out or is suppressed.' : 'Recipient is not suppressed.',
  );
  const hasBrokerage =
    sender.brokerageName.trim().length > 0 && normalize(content.text).includes(normalize(sender.brokerageName));
  add(
    'brokerage_name_present',
    hasBrokerage,
    hasBrokerage
      ? 'Licensed brokerage name appears in the content.'
      : 'Content must include the licensed brokerage name (Fla. Admin. Code 61J2-10.025).',
  );

  switch (channel) {
    case 'email':
      emailChecks(input, add);
      break;
    case 'mail':
      add(
        'recipient_address_present',
        Boolean(recipient.postalAddress?.trim()),
        recipient.postalAddress ? 'Mailing address present.' : 'No mailing address for recipient.',
      );
      break;
    case 'call':
      phoneChecks(input, add);
      callFrequencyCheck(input, add);
      break;
    case 'sms':
      phoneChecks(input, add);
      writtenConsentCheck(input, 'marketing_texts', add);
      break;
    case 'whatsapp':
      add(
        'recipient_address_present',
        Boolean(recipient.phone),
        recipient.phone ? 'WhatsApp number present.' : 'No WhatsApp number for recipient.',
      );
      whatsappChecks(input, add);
      break;
  }

  return { allowed: checks.every((c) => c.passed), checks, policyVersion: GATE_POLICY_VERSION };
}

type Add = (code: GateCheckCode, passed: boolean, detail: string) => void;

function emailChecks(input: GateInput, add: Add): void {
  const { recipient, sender, content } = input;
  add(
    'recipient_address_present',
    Boolean(recipient.email?.trim()),
    recipient.email ? 'Email address present.' : 'No email address for recipient.',
  );
  const postal = sender.postalAddress?.trim();
  const postalIncluded = Boolean(postal) && normalize(content.text).includes(normalize(postal ?? ''));
  add(
    'email_sender_postal_address',
    postalIncluded,
    postalIncluded ? 'Sender postal address included.' : 'Commercial email must include a valid postal address (CAN-SPAM).',
  );
  add(
    'email_unsubscribe_link',
    content.hasUnsubscribeLink === true,
    content.hasUnsubscribeLink ? 'Unsubscribe link included.' : 'Commercial email needs a working opt-out link (CAN-SPAM).',
  );
  const consented = hasActiveConsent(input, 'email', recipient.email, 'email_marketing', false);
  const disclosed = content.identifiesAsAdvertisement === true || consented;
  add(
    'email_ad_disclosure',
    disclosed,
    disclosed
      ? consented
        ? 'Recipient opted in to marketing email.'
        : 'Message identifies itself as an advertisement.'
      : 'Message must identify itself as an advertisement (CAN-SPAM) unless the recipient opted in.',
  );
  const { liveEmailSending, emailTestRecipient } = input.platform;
  add(
    'email_live_sending_enabled',
    liveEmailSending || emailTestRecipient === true,
    liveEmailSending
      ? 'Live email sending is enabled.'
      : emailTestRecipient
        ? 'Live sending is off; the recipient is a test inbox.'
        : 'Live email sending is switched off, and the recipient is not a test inbox.',
  );
}

function phoneChecks(input: GateInput, add: Add): void {
  const { recipient } = input;
  add(
    'recipient_address_present',
    Boolean(recipient.phone),
    recipient.phone ? 'Phone number present.' : 'No phone number for recipient.',
  );
  const screened = recipient.onFloridaDoNotCall !== undefined && recipient.onNationalDoNotCall !== undefined;
  add(
    'do_not_call_screened',
    screened,
    screened ? 'Screened against Florida and national do-not-call lists.' : 'Do-not-call status unknown; screen first.',
  );
  if (screened) {
    // Fla. Stat. 501.059(1)(k) and (4): calls the person asked for, calls within a
    // prior business relationship, and a licensee's call responding to the
    // seller's own sign or ad are outside the Florida list prohibition.
    const floridaExempt = recipient.basis !== 'none';
    const floridaOk = recipient.onFloridaDoNotCall === false || floridaExempt;
    add(
      'florida_do_not_call',
      floridaOk,
      floridaOk
        ? recipient.onFloridaDoNotCall
          ? `On the Florida list; exempt (${recipient.basis}).`
          : 'Not on the Florida list.'
        : 'Number is on the Florida no-sales-solicitation list.',
    );
    // Conservative until counsel review: only an express request from the
    // person overrides the national registry.
    const nationalOk = recipient.onNationalDoNotCall === false || recipient.basis === 'express_request';
    add(
      'national_do_not_call',
      nationalOk,
      nationalOk
        ? recipient.onNationalDoNotCall
          ? 'On the national registry; the person expressly requested contact.'
          : 'Not on the national registry.'
        : 'Number is on the national do-not-call registry.',
    );
  }
  const hour = recipient.timeZone ? localHour(input.now, recipient.timeZone) : undefined;
  const inWindow = hour !== undefined && hour >= CALLING_WINDOW.startHour && hour < CALLING_WINDOW.endHour;
  add(
    'calling_hours',
    inWindow,
    hour === undefined
      ? 'Recipient time zone unknown.'
      : inWindow
        ? `Local hour ${hour} is within 8 a.m.–8 p.m.`
        : `Local hour ${hour} is outside 8 a.m.–8 p.m. (Fla. Stat. 501.616).`,
  );
}

function callFrequencyCheck(input: GateInput, add: Add): void {
  const since = input.now.getTime() - DAY_MS;
  const count = input.recentAttempts.filter(
    (a) => a.channel === 'call' && a.subjectKey === input.action.subjectKey && a.at.getTime() > since,
  ).length;
  const ok = count < MAX_CALLS_PER_24H_SAME_SUBJECT;
  add(
    'call_frequency',
    ok,
    `${count} call(s) on this subject in the last 24 hours; limit is ${MAX_CALLS_PER_24H_SAME_SUBJECT}.`,
  );
}

function writtenConsentCheck(input: GateInput, scope: ConsentScope, add: Add): void {
  const ok = hasActiveConsent(input, input.action.channel, input.recipient.phone, scope, true);
  add(
    'written_consent',
    ok,
    ok
      ? 'Prior express written consent on file for this number.'
      : 'Prior express written consent for this number is required (Fla. Stat. 501.059(8)).',
  );
}

function whatsappChecks(input: GateInput, add: Add): void {
  const optedIn = hasActiveConsent(input, 'whatsapp', input.recipient.phone, 'whatsapp_marketing', false);
  add(
    'whatsapp_opt_in',
    optedIn,
    optedIn ? 'Recipient opted in to WhatsApp messages.' : 'WhatsApp requires the recipient to opt in first.',
  );
  const template = Boolean(input.content.whatsappTemplateId);
  add(
    'whatsapp_template',
    template,
    template ? 'Uses an approved template.' : 'Business-initiated WhatsApp messages need an approved template.',
  );
}

function hasActiveConsent(
  input: GateInput,
  channel: Channel,
  address: string | undefined,
  scope: ConsentScope,
  requireWritten: boolean,
): boolean {
  if (!address) return false;
  const target = normalizeAddress(address);
  return input.consents.some(
    (c) =>
      c.channel === channel &&
      normalizeAddress(c.address) === target &&
      c.scopes.includes(scope) &&
      c.obtainedAt.getTime() <= input.now.getTime() &&
      (c.revokedAt === undefined || c.revokedAt.getTime() > input.now.getTime()) &&
      (!requireWritten || (c.writtenSignature && c.disclosureShown)),
  );
}

/** Hour of day (0–23) at `instant` in the given IANA time zone. */
export function localHour(instant: Date, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(
      instant,
    );
    const hour = parts.find((p) => p.type === 'hour')?.value;
    return hour === undefined ? undefined : Number(hour);
  } catch {
    return undefined; // unknown time zone fails closed
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}
