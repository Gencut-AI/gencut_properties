/**
 * Conversation on WhatsApp, the way an assistant talks rather than a menu.
 *
 * When a message is not a plain command, the model reads the recent
 * conversation and the agent's own context and answers with two things: a
 * short reply in its own words, and at most one action from a fixed list. The
 * action goes through the same parser as typed commands, so the model can
 * never do what an agent could not type. The reply is checked before it is
 * sent: it may not state a figure that is not in the context, and it may not
 * claim that anything was sent, mailed, called or approved.
 */
import { type Command, type ListedItem, parseCommand } from './commands.ts';
import { OUTCOMES } from '../outcomes/outcomes.ts';

export const ASSISTANT_CHAT_PROMPT_VERSION = 'assistant-chat-v1';

export interface ChatTurn {
  readonly from: 'agent' | 'gencut';
  readonly text: string;
}

export interface ChatContext {
  /** The agent's name, market and focus, and current counts, as plain lines. */
  readonly facts: readonly string[];
  /** The last numbered list the agent saw. */
  readonly listed: readonly ListedItem[];
  /** What the conversation is about right now (an item, a letter), if anything. */
  readonly focus: string | null;
  /** The yes/no question GenCut last asked, if it is still open. */
  readonly pendingQuestion: string | null;
}

const SYSTEM = `You are GenCut, the marketing assistant of a Florida real-estate agent, talking with them on WhatsApp. You are warm, brief and practical, like a sharp colleague: one to three short sentences, no lists unless asked, no emoji.

What you can do, as exactly one action per reply:
- "new": what is new
- "sellers" / "buyers" / "campaigns": the best seller opportunities, investor buyers, or the agent's letters
- "next": suggest the single best item to act on now, and ask if you should draft a letter
- "show N", "draft N", "save N", "dismiss N": for item N in the last list
- "yes" / "no": answer the open question
- "edit: <instruction>": rewrite the letter being discussed (shorter, warmer, mention X...)
- "outcome N <code>" or "outcome <code>": record what happened with item N, or with the item being discussed. Codes: ${OUTCOMES.join(', ')}
- "help"
- "none": just talk (answer a question about how GenCut works, ask a clarifying question)

Rules:
1. State facts only from the context below. Never invent a lead, a name, an address, a number, a price or a result. If you do not know, say so or choose an action that finds out.
2. You cannot send, mail, email, text, call, post, approve or schedule anything, and must never say you did. Letters are drafts the agent reviews in the app.
3. If the message is ambiguous (which item? which outcome?), ask one short question and use "none".
4. Never describe anyone by race, religion, national origin, sex, disability, family status or age.
5. A buyer's past purchases do not mean it is buying now; never say it is.

Answer with a single JSON object and nothing else: {"reply": string, "action": string}`;

/** The prompt for one conversational turn. */
export function chatPrompt(message: string, history: readonly ChatTurn[], ctx: ChatContext): { system: string; user: string } {
  const list = ctx.listed.length ? ctx.listed.map((i) => `${i.n}. ${i.kind}: ${i.label.slice(0, 80)}`).join('\n') : '(none)';
  const turns = history.length ? history.map((t) => `${t.from === 'agent' ? 'Agent' : 'GenCut'}: ${t.text.slice(0, 400)}`).join('\n') : '(this is the first message)';
  return {
    system: SYSTEM,
    user: [
      'Context:',
      ...ctx.facts.map((f) => `- ${f}`),
      `- Last list shown:\n${list}`,
      `- Being discussed: ${ctx.focus ?? 'nothing in particular'}`,
      `- Open question: ${ctx.pendingQuestion ?? 'none'}`,
      '',
      `Recent conversation:\n${turns}`,
      '',
      `Agent's new message: ${message.slice(0, 800)}`,
    ].join('\n'),
  };
}

const CLAIMS = /\b(i|we|gencut)\s*(?:'ve|have|has|just|already)?\s*(sent|mailed|emailed|texted|called|posted|approved|scheduled|booked)\b|\b(has|have) been (sent|mailed|emailed|posted|approved)\b/i;
const FIGURE = /\$?\d[\d,]*(?:\.\d+)?/g;

/**
 * The model's reply if it is safe to send: no claim that anything was sent or
 * approved, and every figure in it present in `contextText`. Otherwise null.
 */
export function checkChatReply(reply: string, contextText: string): string | null {
  const r = reply.trim();
  if (!r || r.length > 700) return null;
  if (CLAIMS.test(r)) return null;
  const allowed = new Set([...contextText.matchAll(FIGURE)].map((m) => m[0].replace(/[$,]/g, '')));
  for (const m of r.matchAll(FIGURE)) {
    const v = m[0].replace(/[$,]/g, '');
    if (Number(v) <= 10 && !m[0].startsWith('$')) continue; // small counts ("2 letters", "item 3") are fine
    if (!allowed.has(v)) return null;
  }
  return r;
}

const ACTION = /^(none|help|new|sellers|buyers|campaigns|next|yes|no|(show|draft|save|dismiss) \d{1,2}|edit: .{1,300}|outcome( \d{1,2})? [a-z_]+)$/;

/** The model's answer as a reply and a command. The command passes the same parser and list check as typed text. */
export function fromChat(value: unknown, listed: readonly ListedItem[]): { reply: string | null; command: Command } {
  const v = (value && typeof value === 'object' ? value : {}) as { reply?: unknown; action?: unknown };
  const reply = typeof v.reply === 'string' ? v.reply : null;
  const action = typeof v.action === 'string' ? v.action.trim() : '';
  if (!ACTION.test(action) || action === 'none') return { reply, command: { kind: 'unknown' } };
  const command = parseCommand(action.startsWith('edit:') ? action : action.replace(/_/g, ' '));
  if (command.kind === 'link' || command.kind === 'unlink') return { reply, command: { kind: 'unknown' } };
  if ('n' in command && command.n !== null && !listed.some((i) => i.n === command.n)) return { reply, command: { kind: 'unknown' } };
  return { reply, command };
}
