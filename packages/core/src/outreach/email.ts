/**
 * Outreach email: turning an approved campaign letter into the exact message a
 * recipient receives. Pure; sending, approval and the compliance gate live in
 * the services package.
 *
 * Every message carries what CAN-SPAM requires of commercial email (FTC
 * compliance guide): a truthful sender, a subject that is not deceptive, a
 * notice that the message is an advertisement, the sender's valid postal
 * address and a working way to opt out. The gate re-checks the finished text
 * before anything is sent.
 */

/** Recorded on every outreach email, so a sent message can be traced to the composer that built it. */
export const EMAIL_COMPOSER_VERSION = 'email-v1';

/**
 * Who may receive email from this deploy.
 * - off: nothing is sent.
 * - test_only: only addresses on the deploy's test-inbox list (until counsel reviews live outreach).
 * - live: any recipient that passes the compliance gate.
 */
export const EMAIL_SENDING_MODES = ['off', 'test_only', 'live'] as const;
export type EmailSendingMode = (typeof EMAIL_SENDING_MODES)[number];

export function parseEmailSendingMode(raw: string | undefined): EmailSendingMode {
  const v = raw?.trim().toLowerCase();
  return (EMAIL_SENDING_MODES as readonly string[]).includes(v ?? '') ? (v as EmailSendingMode) : 'off';
}

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A recipient address in the form GenCut stores and compares: trimmed and lower-cased; null when not a plausible address. */
export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

/**
 * The test-inbox list from configuration: comma- or space-separated addresses,
 * or whole domains written as "@example.com".
 */
export function parseTestInboxes(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => (s.startsWith('@') ? normalizeEmail(`x${s}`) !== null : normalizeEmail(s) !== null));
}

export function isTestInbox(email: string, inboxes: readonly string[]): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  return inboxes.some((i) => (i.startsWith('@') ? e.endsWith(i) : e === i));
}

/** Whether this deploy may send to this recipient at all (the gate checks everything else). */
export function sendingAllows(mode: EmailSendingMode, inboxes: readonly string[], email: string): boolean {
  if (mode === 'live') return normalizeEmail(email) !== null;
  if (mode === 'test_only') return isTestInbox(email, inboxes);
  return false;
}

export interface EmailSender {
  /** The agent's name as licensed. */
  readonly name: string;
  readonly brokerage: string;
  readonly licenseNumber: string | null;
  /** The postal address CAN-SPAM requires in every commercial email. */
  readonly postalAddress: string;
}

export interface EmailLetter {
  readonly greeting: string;
  readonly paragraphs: readonly string[];
  readonly closing: string;
  readonly signature: readonly string[];
}

export interface ComposedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Display name for the From header, e.g. "Ana Ruiz (Bayside Realty)". */
  readonly fromName: string;
}

export const SUBJECT_MAX = 120;

/** A neutral default subject: who is writing, never anything about the recipient or their property. */
export function defaultSubject(sender: Pick<EmailSender, 'name' | 'brokerage'>): string {
  return `A note from ${sender.name}, ${sender.brokerage}`.slice(0, SUBJECT_MAX);
}

/** Problems with an agent-written subject; empty when it may be used. */
export function checkSubject(subject: string): string[] {
  const s = subject.trim();
  const problems: string[] = [];
  if (s.length < 3) problems.push('Add a subject line.');
  if (s.length > SUBJECT_MAX) problems.push(`Keep the subject under ${SUBJECT_MAX} characters.`);
  if (/[\r\n]/.test(subject)) problems.push('The subject must be one line.');
  // A reply or forward prefix suggests an earlier conversation that never happened (deceptive under CAN-SPAM).
  if (/^\s*(re|fw|fwd)\s*:/i.test(s)) problems.push('Do not start the subject with “Re:” or “Fwd:” — there was no earlier message.');
  if (/\b(urgent|act now|last chance|limited time|guarantee[ds]?)\b/i.test(s)) problems.push('Avoid pressure words in the subject.');
  return problems;
}

/** The footer every outreach email ends with. The gate checks that its parts are present. */
export function emailFooterLines(sender: EmailSender): string[] {
  const license = sender.licenseNumber ? ` · License ${sender.licenseNumber}` : '';
  return [
    `This email is an advertisement from ${sender.name}, ${sender.brokerage}${license}.`,
    sender.postalAddress,
    'Reply to this email to reach me directly.',
  ];
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A display name safe for a From header: no quotes, angle brackets or line breaks. */
export function fromDisplayName(sender: Pick<EmailSender, 'name' | 'brokerage'>): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/["<>\\]/g, '').replace(/\s+/g, ' ').trim();
  return `${clean(sender.name)} (${clean(sender.brokerage)})`.slice(0, 100);
}

/**
 * Build the message. `unsubscribeUrl` must be a working link that records the
 * opt-out without asking the recipient to sign in or pay.
 */
export function composeOutreachEmail(input: {
  readonly letter: EmailLetter;
  readonly subject: string;
  readonly sender: EmailSender;
  readonly unsubscribeUrl: string;
}): ComposedEmail {
  const { letter, sender, unsubscribeUrl } = input;
  const footer = emailFooterLines(sender);
  const unsubscribeLine = `Unsubscribe: ${unsubscribeUrl}`;

  const text = [
    letter.greeting,
    '',
    ...letter.paragraphs.flatMap((p) => [p, '']),
    letter.closing,
    ...letter.signature,
    '',
    '—',
    ...footer,
    unsubscribeLine,
    '',
  ].join('\n');

  const p = (s: string, style = '') => `<p style="margin:0 0 16px;${style}">${escapeHtml(s)}</p>`;
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;">',
    '<div style="max-width:600px;margin:0 auto;font-family:Georgia,\'Times New Roman\',serif;font-size:16px;line-height:1.6;color:#1b2430;">',
    p(letter.greeting),
    ...letter.paragraphs.map((x) => p(x)),
    `<p style="margin:24px 0 0;">${escapeHtml(letter.closing)}</p>`,
    `<p style="margin:4px 0 0;">${letter.signature.map(escapeHtml).join('<br>')}</p>`,
    '<hr style="border:none;border-top:1px solid #d9dee5;margin:32px 0 16px;">',
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#5b6573;">`,
    ...footer.map((l) => p(l, 'margin-bottom:6px;')),
    `<p style="margin:0;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#5b6573;">Unsubscribe</a> — you will not hear from ${escapeHtml(sender.name)} by email again.</p>`,
    '</div></div></body></html>',
  ].join('');

  return { subject: input.subject.trim(), text, html, fromName: fromDisplayName(sender) };
}
