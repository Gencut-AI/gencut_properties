/**
 * Instagram comments as leads (D-024). Someone comments a keyword ("VALUE")
 * on the agent's post; GenCut shows it on the Leads tab, and the agent can
 * send one private reply with the lead-page link. Pure rules only.
 */

export const DEFAULT_INSTAGRAM_KEYWORDS = ['VALUE', 'SEND', 'INFO', 'HOME', 'LINK'] as const;

/** Keywords from configuration: comma- or space-separated words, upper-cased; the defaults when empty. */
export function parseKeywords(raw: string | undefined): readonly string[] {
  const words = (raw ?? '')
    .split(/[\s,;]+/)
    .map((w) => w.trim().toUpperCase())
    .filter((w) => /^[A-Z0-9]{2,30}$/.test(w));
  return words.length ? [...new Set(words)] : DEFAULT_INSTAGRAM_KEYWORDS;
}

/** The keyword a comment asks with, as a whole word in any case ("value please!" → VALUE), or null. */
export function matchKeyword(text: string, keywords: readonly string[]): string | null {
  const upper = text.toUpperCase();
  return keywords.find((k) => new RegExp(`(^|[^A-Z0-9])${k}([^A-Z0-9]|$)`).test(upper)) ?? null;
}

/** Meta allows one private reply per comment, within 7 days of the comment. */
export const PRIVATE_REPLY_WINDOW_DAYS = 7;

export function canPrivateReply(commentedAt: Date, now: Date): boolean {
  return now.getTime() - commentedAt.getTime() < PRIVATE_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/** The private reply: thanks, the link they asked for, and who it is from. Plain text, under Instagram's 1,000-character limit. */
export function instagramReplyText(username: string, agentFirstName: string, link: string): string {
  const handle = username.replace(/[^A-Za-z0-9._]/g, '').slice(0, 30);
  return `Hi${handle ? ` @${handle}` : ''}! Thanks for your comment. Here's the link you asked for: ${link}\n\nTell me a little about what you're planning and I'll get back to you personally. — ${agentFirstName}`;
}
