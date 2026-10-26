/**
 * Buyer introduction letters (Buyer Radar B2): a letter from the agent to a
 * company that bought homes in the county, offering to share opportunities in
 * the areas and home types it has bought.
 *
 * The writer sees patterns, never purchases: the company's name, the ZIP codes
 * and home types it bought in, and the agent's profile. It never sees an
 * address, a price, a date, a purchase count or the score, and the checks
 * reject a letter that claims the company is buying now, that a property is
 * available, or that says how the company was found.
 */
import {
  type AgentForDraft,
  type CampaignDraft,
  type CampaignFact,
  type DraftProblem,
  checkCampaignDraft,
  draftText,
  normalizeText,
} from '../campaign/draft.ts';
import type { BuyerProfile } from './buyer-radar.ts';

export const BUYER_LETTER_PROMPT_VERSION = 'buyer-intro-v1';

/** ZIP codes and home types passed to the writer: the company's top few, by purchases. */
const MAX_PATTERN_ITEMS = 3;

/** The only facts a buyer letter may state. */
export function buyerFacts(profile: BuyerProfile, agent: AgentForDraft): CampaignFact[] {
  const f: CampaignFact[] = [];
  const pr = (key: string, label: string, value: string) => {
    if (value.trim()) f.push({ key, label, value: value.trim(), source: 'public_record' });
  };
  const ap = (key: string, label: string, value: string | null | undefined) => {
    if (value?.trim()) f.push({ key, label, value: value.trim(), source: 'agent_profile' });
  };
  pr('company.name', 'Company', profile.name);
  pr('company.zips', 'ZIP codes it has bought in', profile.zips.slice(0, MAX_PATTERN_ITEMS).map((z) => z.zip).join(', '));
  pr('company.home_types', 'Home types it has bought', profile.homeTypes.slice(0, MAX_PATTERN_ITEMS).map((t) => t.label.toLowerCase()).join(', '));
  ap('agent.name', 'Agent name', agent.licenseeName);
  ap('agent.brokerage', 'Brokerage', agent.brokerageName);
  ap('agent.license', 'License number', agent.licenseNumber);
  ap('agent.office', 'Office address', agent.officeAddress);
  ap('agent.specialty', 'Specialty', agent.specialty);
  ap('agent.market', 'Market', agent.market);
  return f;
}

const SYSTEM = `You are the copywriter on a real-estate agent's marketing team in Florida. You write one-to-one direct-mail letters to real-estate investment companies on the agent's behalf. The agent reviews and approves everything before anything is sent; you never send anything.

Rules you must follow:
1. Use ONLY the facts provided. Every number, ZIP code, year or detail you write must appear in a provided fact. Never invent prices, returns, market statistics, properties, deals, timelines or anything about the company.
2. Never claim or imply that the company is buying now or wants to buy: do not write "actively buying", "looking to buy", "in the market for", "currently acquiring", "expanding your portfolio" or anything like it. Write as an offer the company may or may not want.
3. Never say or imply that a specific property is available, off-market, a pocket listing or a deal. The offer is to share opportunities that fit the company's focus as they come up.
4. Never mention how the company was found or what it bought: no purchases, sales, deeds, records, counts, addresses, prices or dates. You may say the agent works in the ZIP codes and home types provided.
5. Fair housing: never refer to race, colour, religion, national origin, sex, disability, familial status, age, or any proxy for them, and never describe who should or should not live in a home or neighbourhood.
6. No pressure or guarantees: no "act now", no guaranteed returns, no claims that the market is about to change.
7. Tone: brief, professional, business-to-business. The letter is under 180 words, 2 or 3 short paragraphs, ending with one low-pressure invitation to talk.
8. The signature must include the agent's name and the brokerage name exactly as provided, and the license number if provided.
9. The follow-up plan uses only these channels: "mail" (another letter), "call_task" (a reminder for the agent to call if they have a lawful basis to), "email" (only if the company replies with an email). 2 or 3 steps, days counted from the first letter.

Answer with a single JSON object and nothing else, in this shape:
{"title": string, "strategy": {"summary": string, "angle": string, "reasons": [{"text": string, "factKeys": [string]}]}, "letter": {"greeting": string, "paragraphs": [string], "closing": string, "signature": [string]}, "followUp": [{"day": number, "channel": "mail" | "call_task" | "email", "action": string}], "factsUsed": [string]}
"factKeys" and "factsUsed" contain only keys from the provided facts.`;

/** The prompt for one buyer letter. `problems` is set on the single retry after a failed check. */
export function buyerLetterPrompt(facts: readonly CampaignFact[], problems: readonly string[] = []): { system: string; user: string } {
  const lines = facts.map((x) => `- ${x.key} (${x.label}): ${x.value}`).join('\n');
  const retry = problems.length
    ? `\n\nYour previous draft was rejected for these reasons. Fix every one:\n${problems.map((p) => `- ${p}`).join('\n')}`
    : '';
  return {
    system: SYSTEM,
    user: `Write a direct-mail letter to this company, from this agent, introducing the agent and offering to share opportunities in these ZIP codes and home types as they come up.\n\nFacts:\n${lines}${retry}`,
  };
}

/** Phrases that state or imply the company is buying now. Whole phrase, case-insensitive. */
export const INTENT_PHRASES: readonly string[] = [
  'actively buying', 'actively acquiring', 'actively investing', 'looking to buy', 'looking to acquire', 'looking to add',
  'looking for more', 'in the market for', 'currently buying', 'currently acquiring', 'currently investing', 'still buying',
  'still acquiring', 'expanding your portfolio', 'grow your portfolio', 'growing your portfolio', 'your next acquisition',
  'your next purchase', 'your buying', 'your acquisition strategy', 'your investment criteria',
];

/** Phrases that claim a property is available. */
export const AVAILABILITY_PHRASES: readonly string[] = [
  'off-market', 'off market', 'pocket listing', 'exclusive listing', 'just listed', 'coming soon', 'property available',
  'properties available', 'home available', 'homes available', 'have a deal', 'have a property', 'have a home',
  'have properties', 'deal for you', 'under market', 'below market', 'distressed',
];

/** Phrases that tell the company how it was found, or what it bought. */
export const BUYER_HOW_FOUND_PHRASES: readonly string[] = [
  'purchase', 'purchases', 'purchased', 'bought', 'acquired', 'acquisition', 'acquisitions', 'closing', 'closed on',
  'deed', 'deeds', 'county records', 'sales records', 'sale records', 'public record', 'transaction', 'transactions',
  'we noticed', 'i noticed', 'came across', 'your recent', 'recently',
];

const has = (lower: string, phrase: string) =>
  new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(lower);

const STREET = /\b\d{1,6}\s+(?:[nsew]\.?\s+|(?:north|south|east|west)\s+)?(?:[a-z0-9]+\s+){0,3}(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ct|court|ln|lane|way|ter|terrace|pl|place|cir|circle|pkwy|parkway|hwy|highway)\b\.?/i;
/** A small count of homes ("your 4 homes"): grounding allows numbers up to 31, so it is caught here. */
const COUNT = /\b(?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|several|many|dozens of)\s+(?:homes|houses|properties|units|condos|condominiums|buildings|deals|doors)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The draft with the company's own name taken out. Company names carry words the
 * checks would otherwise flag ("WHITE CASTLE PROPERTY", "XYZ ACQUISITIONS LLC",
 * "1236 NE 109 STREET PROPERTY"); the name is a provided fact, so it is set aside.
 */
function withoutCompanyName(d: CampaignDraft, company: string): CampaignDraft {
  if (!company.trim()) return d;
  const re = new RegExp(escape(company.trim()), 'gi');
  const x = (s: string) => s.replace(re, 'the company');
  return {
    ...d,
    title: x(d.title),
    strategy: { ...d.strategy, summary: x(d.strategy.summary), angle: x(d.strategy.angle), reasons: d.strategy.reasons.map((r) => ({ ...r, text: x(r.text) })) },
    letter: { ...d.letter, greeting: x(d.letter.greeting), paragraphs: d.letter.paragraphs.map(x), closing: x(d.letter.closing) },
    followUp: d.followUp.map((f) => ({ ...f, action: x(f.action) })),
  };
}

/** Every check a seller letter gets, plus the buyer rules. An empty list means the letter may be shown for review. */
export function checkBuyerLetter(d: CampaignDraft, facts: readonly CampaignFact[], agent: AgentForDraft): DraftProblem[] {
  const clean = withoutCompanyName(d, facts.find((f) => f.key === 'company.name')?.value ?? '');
  const problems: DraftProblem[] = [...checkCampaignDraft(clean, facts, agent)];
  // Intent and availability are checked everywhere the agent reads; what the company bought may be
  // named in the strategy (the agent's view) but never in the letter.
  const text = draftText(clean, false);
  const lower = ` ${text.toLowerCase().replace(/[’']/g, "'")} `;
  const letter = [clean.letter.greeting, ...clean.letter.paragraphs, clean.letter.closing].join('\n');
  const letterLower = ` ${letter.toLowerCase().replace(/[’']/g, "'")} `;
  const own = normalizeText(`${agent.licenseeName} ${agent.brokerageName} ${agent.officeAddress ?? ''}`);
  const allowed = (phrase: string) => own.includes(normalizeText(phrase));

  for (const p of INTENT_PHRASES) {
    if (has(lower, p)) problems.push({ code: 'claims_intent', message: `"${p}" claims the company is buying; write it as an offer instead.` });
  }
  for (const p of AVAILABILITY_PHRASES) {
    if (has(lower, p) && !allowed(p)) problems.push({ code: 'claims_availability', message: `"${p}" implies a property is available; offer to share opportunities as they come up.` });
  }
  for (const p of BUYER_HOW_FOUND_PHRASES) {
    if (has(letterLower, p) && !allowed(p)) problems.push({ code: 'reveals_subject', message: `"${p}" refers to what the company bought or how it was found.` });
  }
  // The agent's office address, in the signature, is the one street address a letter may carry.
  if (STREET.test(letter)) problems.push({ code: 'reveals_subject', message: 'The letter must not contain a street address.' });
  if (COUNT.test(letter)) problems.push({ code: 'reveals_subject', message: 'The letter must not count the homes the company owns or bought.' });

  const words = [...d.letter.paragraphs, d.letter.greeting, d.letter.closing].join(' ').split(/\s+/).filter(Boolean).length;
  if (words > 220) problems.push({ code: 'too_long', message: `The letter has ${words} words; keep it under 180.` });

  return problems.filter((p, i, all) => all.findIndex((q) => q.message === p.message) === i);
}
