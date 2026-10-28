/**
 * The assistant's commands: what a linked agent can ask GenCut over a chat
 * channel (WhatsApp first). Every command maps to an existing service the web
 * app also uses; nothing here sends outreach or approves anything.
 *
 * Messages are understood in two steps. A deterministic parser handles the
 * phrasings people use most ("new", "buyers", "2", "draft 2"). Anything else
 * may be passed to a model, which may only answer with one of these commands in
 * their text form; its answer goes through the same parser, so a model can
 * never produce an action the parser would not.
 */

import { OUTCOMES, type Outcome } from '../outcomes/outcomes.ts';

/** Items in the last numbered list the agent was shown; "2" refers to item 2. */
export type ListedKind = 'seller' | 'buyer' | 'campaign';
export interface ListedItem {
  readonly n: number;
  readonly kind: ListedKind;
  readonly id: string;
  readonly label: string;
}

export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'summary' }
  | { readonly kind: 'list'; readonly target: 'sellers' | 'buyers' | 'campaigns' }
  /** Details of item N, or of the item being discussed when n is null. */
  | { readonly kind: 'show'; readonly n: number | null }
  | { readonly kind: 'draft'; readonly n: number }
  | { readonly kind: 'triage'; readonly n: number; readonly status: 'saved' | 'dismissed' }
  | { readonly kind: 'link'; readonly code: string }
  | { readonly kind: 'unlink' }
  /** The next item worth acting on, offered with a yes/no question. */
  | { readonly kind: 'suggest' }
  /** An answer to the last yes/no question. */
  | { readonly kind: 'confirm'; readonly yes: boolean }
  /** Rewrite the letter last shown, following the agent's instruction. */
  | { readonly kind: 'edit'; readonly instruction: string }
  /** Record what happened with item N, or with the item last discussed when n is null. */
  | { readonly kind: 'outcome'; readonly n: number | null; readonly outcome: Outcome }
  | { readonly kind: 'unknown' };

/** A numbered reference: "2", "#2", "number 2", "the second one". */
const ORDINALS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const REF = String.raw`(?:#|no\.?\s*|number\s+)?(\d{1,2})`;

function ref(s: string): number | null {
  const m = s.match(new RegExp(`(?:^|\\s)${REF}(?:\\s|$)`)) ?? null;
  if (m?.[1]) return Number(m[1]);
  for (const [w, n] of Object.entries(ORDINALS)) if (new RegExp(`\\b${w}\\b`).test(s)) return n;
  return null;
}

const has = (s: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`).test(s));

/** Parse one message. Pure; the same text always gives the same command. */
export function parseCommand(text: string): Command {
  const s = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9#.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { kind: 'unknown' };

  const link = s.match(/^link\s*(\d{6})$/);
  if (link?.[1]) return { kind: 'link', code: link[1] };
  if (/^(stop|unlink|unsubscribe|disconnect)$/.test(s)) return { kind: 'unlink' };
  if (/^(help|menu|commands|options|\?|what can you do)$/.test(s)) return { kind: 'help' };
  if (/^(yes|y|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|si)$/.test(s)) return { kind: 'confirm', yes: true };
  if (/^(no|n|nope|not now|pass|skip|no thanks)$/.test(s)) return { kind: 'confirm', yes: false };
  if (/^(details|show details|more|tell me more|show me)$/.test(s)) return { kind: 'show', n: null };
  if (/^(next|suggest|suggestion|whats next|what next|what should i do|who should i contact|whos next|another one|give me one)$/.test(s)) return { kind: 'suggest' };

  const outcome = s.match(/^outcome(?:\s+(\d{1,2}))?\s+([a-z ]+)$/);
  if (outcome?.[2]) {
    const code = outcome[2].trim().replace(/\s+/g, '_');
    if ((OUTCOMES as readonly string[]).includes(code)) return { kind: 'outcome', n: outcome[1] ? Number(outcome[1]) : null, outcome: code as Outcome };
  }
  const instruction = text.trim().replace(/^(edit|rewrite|revise)\s*:?\s*/i, '').slice(0, 300);
  if (/^(edit|rewrite|revise)\b/.test(s) && instruction) return { kind: 'edit', instruction };
  if (/^(make it )?(shorter|longer|warmer|friendlier|simpler|more formal|less formal|more casual|more personal)$/.test(s)) return { kind: 'edit', instruction: text.trim().slice(0, 300) };

  const n = ref(s);
  if (n !== null) {
    if (has(s, 'draft', 'letter', 'write', 'campaign', 'create', 'start')) return { kind: 'draft', n };
    if (has(s, 'save', 'keep', 'star')) return { kind: 'triage', n, status: 'saved' };
    if (has(s, 'dismiss', 'skip', 'hide', 'remove', 'not interested')) return { kind: 'triage', n, status: 'dismissed' };
    if (/^(?:#|no\.?\s*|number\s+)?\d{1,2}$/.test(s) || has(s, 'show', 'open', 'details', 'detail', 'more', 'tell', 'about', 'see', 'view'))
      return { kind: 'show', n };
  }

  if (has(s, 'buyer', 'buyers', 'investor', 'investors')) return { kind: 'list', target: 'buyers' };
  if (has(s, 'seller', 'sellers', 'opportunities', 'opportunity', 'leads', 'lead', 'owners', 'homes')) return { kind: 'list', target: 'sellers' };
  if (has(s, 'campaign', 'campaigns', 'letters', 'drafts')) return { kind: 'list', target: 'campaigns' };
  if (/^(hi|hello|hey|hola|start|new|whats new|what is new|status|today|update|updates|summary|good morning)$/.test(s) || has(s, 'new', 'summary', 'status'))
    return { kind: 'summary' };
  return { kind: 'unknown' };
}

/** Version of the prompt that maps free text to a command; recorded on every model call. */
export const ASSISTANT_INTENT_PROMPT_VERSION = 'assistant-intent-v1';

const INTENT_SYSTEM = `You route messages from a real-estate agent to the commands of GenCut, their marketing assistant. Reply with a single JSON object {"command": string} and nothing else.

The command must be exactly one of:
- "help" — what the assistant can do
- "new" — a summary of what is new
- "sellers" — the best seller opportunities
- "buyers" — the best investor buyers
- "campaigns" — the agent's campaigns
- "show N" — details of item N in the last list
- "draft N" — draft a letter for item N in the last list
- "save N" / "dismiss N" — keep or hide item N
- "unknown" — anything else, including requests to send, approve, publish, call, text or email anyone, which the assistant cannot do here

N is a number from the last list shown below. Never invent a number that is not in the list.`;

/** The prompt for the fallback model call. Gives the model the message and the last list's labels only. */
export function intentPrompt(message: string, listed: readonly ListedItem[]): { system: string; user: string } {
  const list = listed.length
    ? listed.map((i) => `${i.n}. ${i.kind}: ${i.label.slice(0, 80)}`).join('\n')
    : '(no list shown yet)';
  return { system: INTENT_SYSTEM, user: `Last list shown:\n${list}\n\nMessage: ${message.slice(0, 500)}` };
}

/** The model's answer as a command, through the same parser. Anything malformed is "unknown". */
export function commandFromIntent(value: unknown, listed: readonly ListedItem[]): Command {
  const text = value && typeof value === 'object' && typeof (value as { command?: unknown }).command === 'string'
    ? (value as { command: string }).command
    : '';
  if (!/^(help|new|sellers|buyers|campaigns|unknown|(show|draft|save|dismiss) \d{1,2})$/.test(text.trim())) return { kind: 'unknown' };
  const c = parseCommand(text);
  if ('n' in c && c.n !== null && !listed.some((i) => i.n === c.n)) return { kind: 'unknown' };
  if (c.kind === 'link' || c.kind === 'unlink') return { kind: 'unknown' };
  return c;
}

/** WhatsApp ids are the number in international format, digits only. */
export function normalizeWaId(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** A number shown back to its owner without exposing all of it: "+1 ••• ••• 1234". */
export function maskWaId(waId: string): string {
  return waId.length > 4 ? `+${waId.slice(0, waId.length - 10 > 0 ? waId.length - 10 : 1)} ••• ••• ${waId.slice(-4)}` : '••••';
}
