/**
 * Share kit: the agent's lead page as a ready-to-post caption and a tracked
 * link for each network (D-025).
 *
 * GenCut never posts for the agent. The kit opens each network's own share
 * screen (or the phone's share menu) with the caption filled in, and the agent
 * presses Post. That needs no publishing permission from any network, works for
 * any account, and keeps the agent the one who publishes.
 *
 * Every caption names the agent and the brokerage (and the license number when
 * the profile has one): Florida requires the brokerage name in advertising.
 * Each network gets its own `?src=` so a lead shows where it came from.
 */

import type { LeadSource } from '../leads/inbound.ts';

export const SHARE_KIT_VERSION = 'share-v1';

export const SHARE_NETWORKS = ['instagram', 'facebook', 'whatsapp', 'tiktok', 'linkedin', 'x', 'sms'] as const;
export type ShareNetwork = (typeof SHARE_NETWORKS)[number];

export const SHARE_NETWORK_LABEL: Readonly<Record<ShareNetwork, string>> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  x: 'X',
  sms: 'Text message',
};

/** Networks whose captions cannot hold a clickable link: the link goes in the bio or a story link sticker. */
const LINK_IN_BIO: ReadonlySet<ShareNetwork> = new Set(['instagram', 'tiktok']);

/** The lead-source code a network's link carries. A text message has no network: it counts as a shared link. */
const SOURCE: Readonly<Record<ShareNetwork, LeadSource>> = {
  instagram: 'instagram',
  facebook: 'facebook',
  whatsapp: 'whatsapp',
  tiktok: 'tiktok',
  linkedin: 'linkedin',
  x: 'x',
  sms: 'link',
};

export interface ShareKitInput {
  readonly agentName: string;
  readonly brokerage: string;
  readonly licenseNumber: string | null;
  /** The agent's focus ZIP codes; the first one names the area in the caption. */
  readonly zips: readonly string[];
  /** The lead page address without a query, e.g. https://app.example/l/maria-lopez-a1b2c3. */
  readonly pageUrl: string;
}

export interface ShareTarget {
  readonly network: ShareNetwork;
  readonly label: string;
  /** The lead page link for this network, tagged so leads show where they came from. */
  readonly link: string;
  /** The caption for this network: with the link, or pointing to the bio where a link cannot be clicked. */
  readonly caption: string;
  /** Opens the network's own share screen with the post filled in; null where no such screen exists (Instagram, TikTok). */
  readonly openUrl: string | null;
  /** One line on how to post where there is no share screen. */
  readonly howTo: string | null;
}

export interface ShareKit {
  readonly version: string;
  /** The plain caption with the untagged link: for copying anywhere. */
  readonly caption: string;
  readonly targets: readonly ShareTarget[];
}

/** The link for one network: the page address with `?src=`. A text message uses the plain address. */
export function shareLink(pageUrl: string, network: ShareNetwork): string {
  const source = SOURCE[network];
  return source === 'link' ? pageUrl : `${pageUrl}?src=${source}`;
}

/** "Maria Lopez · Lopez Realty · License SL3456789": the advertising disclosure every caption ends with. */
export function shareDisclosure(input: Pick<ShareKitInput, 'agentName' | 'brokerage' | 'licenseNumber'>): string {
  return [input.agentName.trim(), input.brokerage.trim(), input.licenseNumber?.trim() ? `License ${input.licenseNumber.trim()}` : '']
    .filter(Boolean)
    .join(' · ');
}

function body(input: ShareKitInput): string {
  const where = input.zips[0] ? input.zips[0] : 'Miami';
  return `Thinking about buying or selling in ${where}? Tell me what you’re planning and I’ll reply personally, with what’s happening on your street and what your options are.`;
}

/** The caption for one network. */
export function shareCaption(input: ShareKitInput, network: ShareNetwork): string {
  const ask = LINK_IN_BIO.has(network) ? 'Link in my bio.' : `Ask me here: ${shareLink(input.pageUrl, network)}`;
  return `${body(input)}\n\n${ask}\n\n${shareDisclosure(input)}`;
}

function openUrlFor(network: ShareNetwork, link: string, caption: string): string | null {
  const e = encodeURIComponent;
  switch (network) {
    case 'whatsapp':
      return `https://wa.me/?text=${e(caption)}`;
    case 'facebook':
      // Facebook takes the link only; the caption is copied for the agent to paste.
      return `https://www.facebook.com/sharer/sharer.php?u=${e(link)}`;
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${e(link)}`;
    case 'x':
      // X counts every link as 23 characters; the short line keeps the post well inside 280.
      return `https://x.com/intent/post?text=${e(caption.split('\n\n')[0]?.slice(0, 200) ?? '')}&url=${e(link)}`;
    case 'sms':
      return `sms:?&body=${e(caption)}`;
    case 'instagram':
    case 'tiktok':
      return null;
  }
}

function howToFor(network: ShareNetwork, link: string): string | null {
  if (network === 'instagram') return `Paste the caption into a post or story. Put ${link} in your bio, or on a story link sticker.`;
  if (network === 'tiktok') return `Paste the caption into your video description. Put ${link} in your bio.`;
  if (network === 'facebook') return 'Facebook opens with your link; paste the caption above it.';
  return null;
}

/** The whole kit. Pure: the same profile and page always give the same captions and links. */
export function buildShareKit(input: ShareKitInput): ShareKit {
  if (!/^https?:\/\/[^\s?#]+$/.test(input.pageUrl)) throw new Error('pageUrl must be an http(s) address without a query');
  if (!input.agentName.trim() || !input.brokerage.trim()) throw new Error('agentName and brokerage are required');
  const targets = SHARE_NETWORKS.map((network): ShareTarget => {
    const link = shareLink(input.pageUrl, network);
    const caption = shareCaption(input, network);
    return { network, label: SHARE_NETWORK_LABEL[network], link, caption, openUrl: openUrlFor(network, link, caption), howTo: howToFor(network, link) };
  });
  return { version: SHARE_KIT_VERSION, caption: `${body(input)}\n\nAsk me here: ${input.pageUrl}\n\n${shareDisclosure(input)}`, targets };
}
