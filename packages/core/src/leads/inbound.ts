/**
 * Inbound leads from an agent's public lead page: the link the agent puts in
 * an Instagram bio, a Facebook post or an ad. People who fill it in asked to
 * be contacted, so each lead arrives with a consent record (D-023).
 *
 * Pure rules: which sources and interests exist, how a submission is checked,
 * and the exact consent wording shown next to the checkbox.
 */

/** Where the visitor came from, from the link's `?src=` (or the referring site). `link` = shared directly. */
export const LEAD_SOURCES = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube', 'whatsapp', 'link'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABEL: Readonly<Record<LeadSource, string>> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  x: 'X',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp',
  link: 'Shared link',
};

export const LEAD_INTERESTS = ['selling', 'buying', 'investing', 'home_value'] as const;
export type LeadInterest = (typeof LEAD_INTERESTS)[number];

export const LEAD_INTEREST_LABEL: Readonly<Record<LeadInterest, string>> = {
  selling: 'Selling a home',
  buying: 'Buying a home',
  investing: 'Investing',
  home_value: 'What my home is worth',
};

export const INBOUND_LEAD_STATUSES = ['new', 'contacted', 'dismissed'] as const;
export type InboundLeadStatus = (typeof INBOUND_LEAD_STATUSES)[number];

/**
 * The source of a visit: an explicit `?src=` wins; otherwise the referring
 * site's host, when it is one of the networks; otherwise a shared link.
 */
export function leadSourceOf(src: string | null | undefined, referrer: string | null | undefined): LeadSource {
  const s = src?.trim().toLowerCase();
  if (s && (LEAD_SOURCES as readonly string[]).includes(s)) return s as LeadSource;
  if (s === 'ig') return 'instagram';
  if (s === 'fb' || s === 'meta') return 'facebook';
  let host = '';
  try {
    host = referrer ? new URL(referrer).hostname.toLowerCase() : '';
  } catch {
    host = '';
  }
  const is = (...d: string[]) => d.some((x) => host === x || host.endsWith(`.${x}`));
  if (is('instagram.com')) return 'instagram';
  if (is('facebook.com', 'fb.com', 'fb.me', 'messenger.com')) return 'facebook';
  if (is('tiktok.com')) return 'tiktok';
  if (is('linkedin.com', 'lnkd.in')) return 'linkedin';
  if (is('x.com', 'twitter.com', 't.co')) return 'x';
  if (is('youtube.com', 'youtu.be')) return 'youtube';
  if (is('whatsapp.com', 'wa.me')) return 'whatsapp';
  return 'link';
}

/** The consent sentence next to the required checkbox, stored with every lead as shown. */
export function leadConsentText(agentName: string, brokerage: string): string {
  return `I agree that ${agentName} of ${brokerage} may contact me by email or phone about this request. This is not a condition of any purchase, and I can opt out at any time.`;
}

export interface InboundLeadInput {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly interest: string;
  readonly zip: string;
  readonly message: string;
  readonly consent: boolean;
}

export interface CheckedInboundLead {
  readonly name: string;
  readonly email: string;
  /** Digits with country code (US numbers get a leading 1), or null. */
  readonly phone: string | null;
  readonly interest: LeadInterest;
  readonly zip: string | null;
  readonly message: string | null;
}

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Check a submission. Returns the cleaned lead, or field-level messages for the form. */
export function checkInboundLead(i: InboundLeadInput): { ok: true; lead: CheckedInboundLead } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const name = i.name.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 120) fields.name = 'Enter your name.';
  const email = i.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) fields.email = 'Enter a valid email address.';
  const digits = i.phone.replace(/\D/g, '');
  let phone: string | null = null;
  if (digits) {
    if (digits.length === 10) phone = `1${digits}`;
    else if (digits.length >= 11 && digits.length <= 15) phone = digits;
    else fields.phone = 'Enter a phone number with area code, or leave it empty.';
  }
  const interest = (LEAD_INTERESTS as readonly string[]).includes(i.interest) ? (i.interest as LeadInterest) : null;
  if (!interest) fields.interest = 'Choose what you are interested in.';
  const zip = i.zip.trim();
  if (zip && !/^\d{5}$/.test(zip)) fields.zip = 'Enter a 5-digit ZIP code, or leave it empty.';
  const message = i.message.trim();
  if (message.length > 1000) fields.message = 'Keep the message under 1,000 characters.';
  if (!i.consent) fields.consent = 'Tick the box so the agent may reply to you.';
  if (Object.keys(fields).length || !interest) return { ok: false, fields };
  return { ok: true, lead: { name, email, phone, interest, zip: zip || null, message: message || null } };
}

/** A lead page address part: lower-case letters and digits from the agent's name plus a short random suffix. */
export function leadPageSlug(agentName: string, suffix: string): string {
  const base = agentName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return `${base || 'agent'}-${suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)}`;
}
