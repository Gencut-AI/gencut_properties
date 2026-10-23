/**
 * Campaign drafts: the facts a model may use, the prompt, the shape of its
 * answer, and the checks every draft must pass before anyone sees it.
 *
 * The checks are deterministic and run on every draft:
 *   - grounding: every figure and year in the copy must come from the facts;
 *   - fair housing: no protected characteristics or proxies;
 *   - sensitivity: no hardship, death or distress language, and no wording
 *     that tells an owner how they were found (absentee, tax records…);
 *   - Florida advertising: the brokerage name is in the signature.
 * A draft that fails is never shown as ready; it is regenerated once with the
 * problems listed, and otherwise marked failed with the reasons.
 */
import { type Result, err, ok } from '../result.ts';
import { DOR_USE_LABELS, type StoredParcel } from '../sources/fl-dor-nal.ts';

/** Version of the prompt and checks; recorded on every draft and model run. */
export const CAMPAIGN_PROMPT_VERSION = 'campaign-draft-v1';

export interface CampaignFact {
  /** Stable key the model cites, e.g. `property.address`. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Where the fact comes from, shown beside the draft. */
  readonly source: 'public_record' | 'agent_profile';
}

export interface AgentForDraft {
  readonly licenseeName: string;
  readonly brokerageName: string;
  readonly licenseNumber: string | null;
  readonly officeAddress: string | null;
  readonly specialty: string | null;
  readonly market: string;
}


/**
 * The only facts a draft may state. Deliberately absent:
 * - how the owner was selected (absentee status, assessment gap, estate status,
 *   exemptions): GenCut uses those to choose whom to write to, never as talking points;
 * - the roll's market value and sale history: quoting a tax-roll value or a past
 *   purchase back to an owner reads as surveillance, and a roll value is not a price.
 */
export function campaignFacts(parcel: StoredParcel, agent: AgentForDraft): CampaignFact[] {
  const f: CampaignFact[] = [];
  const pr = (key: string, label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && String(value).trim()) f.push({ key, label, value: String(value), source: 'public_record' });
  };
  const ap = (key: string, label: string, value: string | null | undefined) => {
    if (value?.trim()) f.push({ key, label, value: value.trim(), source: 'agent_profile' });
  };
  pr('property.address', 'Property address', [parcel.situs.address, parcel.situs.city, `FL ${parcel.situs.zip}`].filter(Boolean).join(', '));
  pr('property.type', 'Property type', DOR_USE_LABELS[parcel.useCode]);
  pr('property.year_built', 'Year built', parcel.yearBuilt);
  pr('property.living_area', 'Living area (sq ft)', parcel.livingArea?.toLocaleString('en-US'));
  if ((parcel.units ?? 0) > 1) pr('property.units', 'Residential units', parcel.units);
  pr('owner.name', 'Owner of record', parcel.owner.name);
  ap('agent.name', 'Agent name', agent.licenseeName);
  ap('agent.brokerage', 'Brokerage', agent.brokerageName);
  ap('agent.license', 'License number', agent.licenseNumber);
  ap('agent.office', 'Office address', agent.officeAddress);
  ap('agent.specialty', 'Specialty', agent.specialty);
  ap('agent.market', 'Market', agent.market);
  return f;
}

export interface FollowUpStep {
  readonly day: number;
  readonly channel: 'mail' | 'call_task' | 'email';
  readonly action: string;
}

export interface CampaignDraft {
  readonly title: string;
  readonly strategy: {
    readonly summary: string;
    readonly angle: string;
    readonly reasons: readonly { readonly text: string; readonly factKeys: readonly string[] }[];
  };
  readonly letter: {
    readonly greeting: string;
    readonly paragraphs: readonly string[];
    readonly closing: string;
    readonly signature: readonly string[];
  };
  readonly followUp: readonly FollowUpStep[];
  readonly factsUsed: readonly string[];
}

const SYSTEM = `You are the copywriter on a real-estate agent's marketing team in Florida. You write one-to-one direct-mail campaigns to property owners on the agent's behalf. The agent reviews and approves everything before anything is sent; you never send anything.

Rules you must follow:
1. Use ONLY the facts provided. Every number, year, amount or property detail you write must appear in a provided fact. Never invent prices, valuations, sales, comparable homes, market statistics, timelines, neighbours, features or anything about the owner.
2. Never mention or hint at how this owner was selected: do not mention tax records, assessments, homestead, absentee or out-of-state ownership, estates, probate, inheritance, death, divorce, debt, foreclosure, illness, age, or any personal hardship. Never imply you know the owner's plans or circumstances.
3. Fair housing: never refer to race, colour, religion, national origin, sex, disability, familial status (children, families, couples, singles), age, or any proxy for them, and never describe who should or should not live in a home or neighbourhood.
4. No pressure or guarantees: no "act now", no guaranteed sale or price, no claims that the market is about to change.
5. Tone: warm, brief, professional, specific to the property. The letter is under 220 words, 2 to 4 short paragraphs, ending with one low-pressure invitation to talk.
6. The signature must include the agent's name and the brokerage name exactly as provided, and the license number if provided.
7. The follow-up plan uses only these channels: "mail" (another letter), "call_task" (a reminder for the agent to call if they have a lawful basis to), "email" (only if the owner replies with an email). 2 to 4 steps, days counted from the first letter.

Answer with a single JSON object and nothing else, in this shape:
{"title": string, "strategy": {"summary": string, "angle": string, "reasons": [{"text": string, "factKeys": [string]}]}, "letter": {"greeting": string, "paragraphs": [string], "closing": string, "signature": [string]}, "followUp": [{"day": number, "channel": "mail" | "call_task" | "email", "action": string}], "factsUsed": [string]}
"factKeys" and "factsUsed" contain only keys from the provided facts.`;

/** The prompt for one draft. `problems` is set on the single retry after a failed check. */
export function campaignPrompt(facts: readonly CampaignFact[], problems: readonly string[] = []): { system: string; user: string } {
  const lines = facts.map((x) => `- ${x.key} (${x.label}): ${x.value}`).join('\n');
  const retry = problems.length
    ? `\n\nYour previous draft was rejected for these reasons. Fix every one:\n${problems.map((p) => `- ${p}`).join('\n')}`
    : '';
  return {
    system: SYSTEM,
    user: `Write a direct-mail campaign to the owner of this property, from this agent, introducing the agent and offering a no-obligation conversation about the property.\n\nFacts:\n${lines}${retry}`,
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validate the model's JSON. Anything malformed is a failed draft, never a guess. */
export function parseCampaignDraft(value: unknown): Result<CampaignDraft, 'invalid_draft'> {
  const bad = (why: string) => err('invalid_draft' as const, why);
  if (!value || typeof value !== 'object') return bad('The reply is not an object.');
  const v = value as Record<string, unknown>;
  const s = v.strategy as Record<string, unknown> | undefined;
  const l = v.letter as Record<string, unknown> | undefined;
  if (!isStr(v.title)) return bad('Missing title.');
  if (!s || !isStr(s.summary) || !isStr(s.angle) || !Array.isArray(s.reasons)) return bad('Missing or incomplete strategy.');
  if (!l || !isStr(l.greeting) || !strArr(l.paragraphs) || l.paragraphs.length === 0 || !isStr(l.closing) || !strArr(l.signature))
    return bad('Missing or incomplete letter.');
  if (!Array.isArray(v.followUp) || !strArr(v.factsUsed)) return bad('Missing follow-up plan or facts used.');
  const reasons = [];
  for (const r of s.reasons as unknown[]) {
    const o = r as Record<string, unknown>;
    if (!isStr(o?.text) || !strArr(o.factKeys)) return bad('A strategy reason is malformed.');
    reasons.push({ text: o.text.trim(), factKeys: o.factKeys });
  }
  const followUp: FollowUpStep[] = [];
  for (const step of v.followUp as unknown[]) {
    const o = step as Record<string, unknown>;
    if (typeof o?.day !== 'number' || !Number.isInteger(o.day) || o.day < 0 || o.day > 365) return bad('A follow-up step has no valid day.');
    if (o.channel !== 'mail' && o.channel !== 'call_task' && o.channel !== 'email') return bad('A follow-up step uses an unsupported channel.');
    if (!isStr(o.action)) return bad('A follow-up step has no action.');
    followUp.push({ day: o.day, channel: o.channel, action: o.action.trim() });
  }
  return ok({
    title: v.title.trim(),
    strategy: { summary: s.summary.trim(), angle: s.angle.trim(), reasons },
    letter: {
      greeting: l.greeting.trim(),
      paragraphs: l.paragraphs.map((p) => p.trim()).filter(Boolean),
      closing: l.closing.trim(),
      signature: l.signature.map((x) => x.trim()).filter(Boolean),
    },
    followUp: followUp.sort((a, b) => a.day - b.day),
    factsUsed: v.factsUsed,
  });
}

/** Words that must never appear in GenCut copy, by rule. Whole-word, case-insensitive. */
export const PROHIBITED_TERMS: Readonly<Record<'fair_housing' | 'sensitivity' | 'how_found' | 'pressure', readonly string[]>> = {
  fair_housing: [
    'race', 'racial', 'ethnic', 'ethnicity', 'religion', 'religious', 'church', 'synagogue', 'mosque', 'christian', 'jewish',
    'muslim', 'catholic', 'hispanic', 'latino', 'white', 'black', 'asian', 'immigrant', 'national origin', 'nationality',
    'disabled', 'disability', 'handicap', 'handicapped', 'wheelchair', 'elderly', 'senior', 'seniors', 'retiree', 'retirees',
    'retirement', 'young', 'children', 'kids', 'family-friendly', 'families', 'couple', 'couples',
    'singles', 'bachelor', 'pregnant', 'exclusive neighborhood', 'safe neighborhood', 'gender',
  ],
  sensitivity: [
    'death', 'died', 'passed away', 'deceased', 'condolences', 'sympathy', 'probate', 'estate sale', 'inherited',
    'inheritance', 'heir', 'heirs', 'divorce', 'foreclosure', 'debt', 'behind on', 'lien', 'distress', 'distressed',
    'hardship', 'illness', 'struggling', 'desperate',
  ],
  how_found: [
    'absentee', 'out-of-state', 'out of state', 'homestead', 'assessed', 'assessment', 'tax roll', 'tax records',
    'public records', 'property records', 'our records', 'records show', 'we noticed', 'we know', 'tired landlord',
  ],
  pressure: ['act now', 'guarantee', 'guaranteed', 'limited time', 'before it is too late', "before it's too late", 'last chance'],
};

export interface DraftProblem {
  readonly code:
    | 'unsupported_figure'
    | 'unknown_fact'
    | 'missing_brokerage'
    | 'prohibited_term'
    | 'too_long'
    | 'reveals_subject'
    | 'bad_hashtag';
  readonly message: string;
}

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?\s*(?:%|percent|k\b|m\b|million|thousand)?/gi;

function numericValue(token: string): number {
  const t = token.toLowerCase().replace(/[$,\s]/g, '');
  const n = Number.parseFloat(t);
  if (/million|m$/.test(t)) return n * 1_000_000;
  if (/thousand|k$/.test(t)) return n * 1_000;
  return n;
}

/** Text the reader sees, in order; follow-up actions only when `withPlan`. */
export function draftText(d: CampaignDraft, withPlan = true): string {
  return [
    d.title,
    d.strategy.summary,
    d.strategy.angle,
    ...d.strategy.reasons.map((r) => r.text),
    d.letter.greeting,
    ...d.letter.paragraphs,
    d.letter.closing,
    ...d.letter.signature,
    ...(withPlan ? d.followUp.map((s) => s.action) : []),
  ].join('\n');
}

/** Lower-case words and digits only, for containment checks. */
export const normalizeText = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Figures in `text` that no fact supports. Anything over 31 (a day count) or
 * with a unit must match a fact: rounded money within 1%, years, counts and
 * areas exactly.
 */
export function unsupportedFigures(text: string, facts: readonly CampaignFact[]): DraftProblem[] {
  const allowed = [...facts.map((f) => f.value).join(' ').matchAll(NUMBER)].map((m) => numericValue(m[0])).filter((n) => Number.isFinite(n));
  const problems: DraftProblem[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const token = m[0].trim();
    const n = numericValue(token);
    if (!Number.isFinite(n)) continue;
    const hasUnit = /[$%]|percent|million|thousand|k\b|m\b/i.test(token);
    if (!hasUnit && n <= 31 && !/,/.test(token)) continue;
    const money = /[$]|million|thousand|k\b|m\b/i.test(token);
    const supported = allowed.some((a) => (money && a > 0 ? Math.abs(a - n) / a <= 0.01 : a === n));
    if (!supported) problems.push({ code: 'unsupported_figure', message: `"${token}" is not in the provided facts.` });
  }
  return problems;
}

/** Prohibited words in `text` (fair housing, sensitivity, how-found, pressure); the agent's own names are exempt. */
export function prohibitedTerms(text: string, agent: Pick<AgentForDraft, 'licenseeName' | 'brokerageName'>): DraftProblem[] {
  const lower = ` ${text.toLowerCase().replace(/[’']/g, "'")} `;
  const own = normalizeText(`${agent.licenseeName} ${agent.brokerageName}`);
  const problems: DraftProblem[] = [];
  for (const [rule, terms] of Object.entries(PROHIBITED_TERMS)) {
    for (const term of terms) {
      const re = new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
      if (re.test(lower) && !own.includes(normalizeText(term))) {
        problems.push({ code: 'prohibited_term', message: `"${term}" is not allowed (${rule.replace('_', ' ')}).` });
      }
    }
  }
  return problems;
}

/** Run every check. An empty list means the draft may be shown for review. */
export function checkCampaignDraft(d: CampaignDraft, facts: readonly CampaignFact[], agent: AgentForDraft): DraftProblem[] {
  const keys = new Set(facts.map((f) => f.key));
  // Follow-up actions count days ("send a second letter after 45 days"); they are checked for wording, not figures.
  const problems: DraftProblem[] = [...unsupportedFigures(draftText(d, false), facts)];

  for (const k of [...d.factsUsed, ...d.strategy.reasons.flatMap((r) => r.factKeys)]) {
    if (!keys.has(k)) problems.push({ code: 'unknown_fact', message: `Fact key "${k}" was not provided.` });
  }

  if (!normalizeText(d.letter.signature.join(' ')).includes(normalizeText(agent.brokerageName))) {
    problems.push({ code: 'missing_brokerage', message: `The signature must include the brokerage name "${agent.brokerageName}".` });
  }

  problems.push(...prohibitedTerms(draftText(d), agent));

  const words = [...d.letter.paragraphs, d.letter.greeting, d.letter.closing].join(' ').split(/\s+/).filter(Boolean).length;
  if (words > 260) problems.push({ code: 'too_long', message: `The letter has ${words} words; keep it under 220.` });

  // One message per distinct problem.
  return problems.filter((p, i, all) => all.findIndex((q) => q.message === p.message) === i);
}
