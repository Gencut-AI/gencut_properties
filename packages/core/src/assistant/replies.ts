/**
 * What the assistant says. Short plain text for a phone: WhatsApp renders
 * *bold*, line breaks and links. Every reply that refers to a record carries a
 * link into the web app, where the full view, edits and approvals live.
 *
 * Replies state records and counts only. A buyer's past purchases are never
 * described as current intent; nothing says a message was sent.
 */
import type { ListedItem } from './commands.ts';

/** WhatsApp's limit for a text body is 4,096 characters; replies stay well under it. */
export const MAX_REPLY_CHARS = 3500;

export interface Reply {
  readonly text: string;
  /** Up to three quick-reply buttons: a label (≤ 20 characters) and the command text it sends. */
  readonly buttons?: readonly { readonly title: string; readonly command: string }[];
  /** The numbered list this reply showed, kept so "2" means item 2 next time. */
  readonly listed?: readonly ListedItem[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const fitReply = (text: string): string => clip(text, MAX_REPLY_CHARS);
const money = (v: number | null | undefined) => (v == null ? '' : `$${Math.round(v).toLocaleString('en-US')}`);

export function helpReply(siteUrl: string): Reply {
  return {
    text: [
      '*GenCut on WhatsApp*',
      'Send:',
      '• *new*: what is new today',
      '• *sellers*: your best seller opportunities',
      '• *buyers*: your best investor buyers',
      '• *campaigns*: your letters and their status',
      '• a number, like *2*: details of item 2 in the last list',
      '• *draft 2*: write a letter for item 2 (nothing is sent)',
      '• *save 2* / *dismiss 2*',
      '• *stop*: unlink this number',
      '',
      `Everything else is in the app: ${siteUrl}`,
    ].join('\n'),
    buttons: [
      { title: 'Sellers', command: 'sellers' },
      { title: 'Buyers', command: 'buyers' },
      { title: 'Campaigns', command: 'campaigns' },
    ],
  };
}

export interface SummaryFacts {
  readonly name: string;
  readonly sellers: number;
  readonly buyers: number;
  readonly drafting: number;
  readonly inReview: number;
}

export function summaryReply(f: SummaryFacts, siteUrl: string): Reply {
  return {
    text: [
      `Hi ${f.name.split(/\s+/)[0] || 'there'}. In GenCut now:`,
      `• ${f.sellers} seller opportunities`,
      `• ${f.buyers} investor buyers`,
      `• ${f.inReview} letter draft${f.inReview === 1 ? '' : 's'} waiting for your review${f.drafting ? `, ${f.drafting} being written` : ''}`,
      '',
      `Open the app: ${siteUrl}`,
    ].join('\n'),
    buttons: [
      { title: 'Best sellers', command: 'sellers' },
      { title: 'Best buyers', command: 'buyers' },
      { title: 'Campaigns', command: 'campaigns' },
    ],
  };
}

export interface SellerLine {
  readonly id: string;
  readonly score: number;
  readonly address: string;
  readonly zip: string;
  readonly propertyType: string;
  readonly topReason: string | null;
}

export function sellersReply(items: readonly SellerLine[], siteUrl: string): Reply {
  if (items.length === 0) return { text: `No seller opportunities yet. They appear once your ZIP codes are read: ${siteUrl}/opportunities` };
  const listed: ListedItem[] = items.map((o, i) => ({ n: i + 1, kind: 'seller', id: o.id, label: o.address || o.zip }));
  return {
    text: [
      '*Best seller opportunities*',
      ...items.map((o, i) => `${i + 1}. ${o.address || 'Parcel'}, ${o.zip} · ${o.propertyType} · score ${o.score}${o.topReason ? `\n   ${clip(o.topReason, 110)}` : ''}`),
      '',
      'Reply with a number for details, or *draft 1* for a letter.',
    ].join('\n'),
    listed,
  };
}

export interface BuyerLine {
  readonly id: string;
  readonly score: number;
  readonly name: string;
  readonly purchases: number;
  readonly zips: readonly string[];
  readonly latest: string;
}

export function buyersReply(items: readonly BuyerLine[], siteUrl: string): Reply {
  if (items.length === 0) return { text: `No investor buyers yet. They appear once the county roll is read: ${siteUrl}/buyers` };
  const listed: ListedItem[] = items.map((b, i) => ({ n: i + 1, kind: 'buyer', id: b.id, label: b.name }));
  return {
    text: [
      '*Best investor buyers* (from past purchases on the county roll, not a sign they are buying now)',
      ...items.map((b, i) => `${i + 1}. ${b.name} · ${b.purchases} purchases, latest ${b.latest} · ${b.zips.slice(0, 3).join(', ')} · score ${b.score}`),
      '',
      'Reply with a number for details, or *draft 1* for an introduction letter.',
    ].join('\n'),
    listed,
  };
}

export interface CampaignLine {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export function campaignsReply(items: readonly CampaignLine[], siteUrl: string): Reply {
  if (items.length === 0) return { text: `No campaigns yet. Send *sellers* or *buyers*, then *draft* and a number.` };
  const listed: ListedItem[] = items.map((c, i) => ({ n: i + 1, kind: 'campaign', id: c.id, label: c.title }));
  return {
    text: [
      '*Your campaigns*',
      ...items.map((c, i) => `${i + 1}. ${clip(c.title, 70)} · ${c.status}`),
      '',
      `Reply with a number for the letter. Edit in the app: ${siteUrl}/campaigns`,
    ].join('\n'),
    listed,
  };
}

export interface SellerDetail {
  readonly id: string;
  readonly address: string;
  readonly city: string;
  readonly zip: string;
  readonly propertyType: string;
  readonly score: number;
  readonly marketValue: number | null;
  readonly reasons: readonly string[];
}

export function sellerDetailReply(o: SellerDetail, n: number, siteUrl: string): Reply {
  return {
    text: [
      `*${o.address || 'Parcel'}*, ${[o.city, o.zip].filter(Boolean).join(' ')}`,
      `${o.propertyType} · score ${o.score}${o.marketValue ? ` · market value on the roll ${money(o.marketValue)}` : ''}`,
      ...o.reasons.slice(0, 4).map((r) => `• ${clip(r, 140)}`),
      '',
      `Public record: ${siteUrl}/opportunities/${o.id}`,
    ].join('\n'),
    buttons: [
      { title: 'Draft a letter', command: `draft ${n}` },
      { title: 'Save', command: `save ${n}` },
      { title: 'Dismiss', command: `dismiss ${n}` },
    ],
  };
}

export interface BuyerDetailFacts {
  readonly id: string;
  readonly name: string;
  readonly purchases: number;
  readonly parcels: number;
  readonly window: string;
  readonly zips: readonly string[];
  readonly homeTypes: readonly string[];
  readonly priceRange: string | null;
  readonly score: number;
}

export function buyerDetailReply(b: BuyerDetailFacts, n: number, siteUrl: string): Reply {
  return {
    text: [
      `*${b.name}*`,
      `${b.purchases} verified purchases${b.parcels > b.purchases ? ` (${b.parcels} parcels)` : ''}, ${b.window} · score ${b.score}`,
      `ZIP codes: ${b.zips.slice(0, 5).join(', ')}`,
      `Home types: ${b.homeTypes.join(', ')}`,
      ...(b.priceRange ? [`Paid (single homes): ${b.priceRange}`] : []),
      'Past purchases only: the records do not show whether it is buying now.',
      '',
      `Every purchase, with folio numbers: ${siteUrl}/buyers/${b.id}`,
    ].join('\n'),
    buttons: [
      { title: 'Draft a letter', command: `draft ${n}` },
      { title: 'Save', command: `save ${n}` },
      { title: 'Dismiss', command: `dismiss ${n}` },
    ],
  };
}

export interface LetterFacts {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly greeting: string | null;
  readonly paragraphs: readonly string[];
  readonly error: string | null;
}

export function letterReply(c: LetterFacts, siteUrl: string): Reply {
  const body = c.greeting ? [c.greeting, ...c.paragraphs].join('\n\n') : null;
  return {
    text: [
      `*${c.title}* · ${c.status}`,
      ...(body ? ['', clip(body, 2200)] : []),
      ...(c.error ? ['', `It could not be written: ${clip(c.error, 300)}`] : []),
      '',
      'Nothing has been sent.',
      `Review and edit: ${siteUrl}/campaigns/${c.id}`,
    ].join('\n'),
  };
}

export function draftStartedReply(label: string): Reply {
  return { text: `Writing a letter for ${clip(label, 80)}. I'll send it here in a minute. Nothing is sent to anyone.` };
}

export function notLinkedReply(siteUrl: string): Reply {
  return {
    text: `This number is not linked to a GenCut account. To link it, open Profile in the app, choose "Link WhatsApp", and send the code here as *LINK 123456*.\n${siteUrl}/profile`,
  };
}

export const linkedReply = (name: string): Reply => ({
  text: `Linked. Hi ${name.split(/\s+/)[0] || 'there'}, send *new* to see what GenCut found, or *help* for everything you can ask.`,
  buttons: [
    { title: 'What is new', command: 'new' },
    { title: 'Help', command: 'help' },
  ],
});

export const unlinkedReply: Reply = { text: 'This number is unlinked from GenCut. You can link it again from Profile in the app.' };
export const badCodeReply: Reply = { text: 'That code is not valid or has expired. Create a new one under Profile → Link WhatsApp.' };
export const tooManyCodesReply: Reply = { text: 'Too many attempts. Wait an hour, then create a new code in the app.' };
export const noListReply: Reply = { text: 'Which one? Send *sellers*, *buyers* or *campaigns* first, then a number from that list.' };
export const unknownReply = (siteUrl: string): Reply => ({
  text: `I can show your opportunities, buyers and campaigns, and draft letters. Sending, approving and mailing are done in the app, after review: ${siteUrl}\nSend *help* for the list.`,
});
