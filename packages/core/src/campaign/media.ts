/**
 * Film Crew, first slice: a social post and a neighborhood picture for a
 * campaign, plus the agent's own headshot.
 *
 * The post markets the AGENT to homeowners in the area. It never names the
 * campaign's property, its address or its owner: that home is not for sale,
 * and advertising it would be misleading (Fla. Stat. §475.25(1)(c)) and would
 * expose an owner who never asked for attention. Like every Florida real-estate
 * ad, the post carries the brokerage name (Fla. Admin. Code R. 61J2-10.025).
 *
 * The picture is a general scene of the area, generated and always labelled
 * "Illustrative image"; GenCut has no photos of the home and never pretends to.
 */
import { type Result, err, ok } from '../result.ts';
import { DOR_USE_LABELS, type StoredParcel } from '../sources/fl-dor-nal.ts';
import {
  type AgentForDraft,
  type CampaignFact,
  type DraftProblem,
  campaignFacts,
  normalizeText,
  prohibitedTerms,
  unsupportedFigures,
} from './draft.ts';

/** Version of the social-post prompt and checks; recorded on every post and model run. */
export const SOCIAL_POST_PROMPT_VERSION = 'social-post-v1';
/** Version of the neighborhood-image prompt; recorded on every generated image. */
export const NEIGHBORHOOD_IMAGE_PROMPT_VERSION = 'neighborhood-image-v1';

/** Film Crew progress for one campaign. */
export const MEDIA_STATES = ['none', 'generating', 'ready', 'failed'] as const;
export type MediaState = (typeof MEDIA_STATES)[number];

export const MEDIA_ASSET_KINDS = ['headshot', 'neighborhood_image'] as const;
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

export const MEDIA_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

/** Largest headshot an agent may upload. */
export const MAX_HEADSHOT_BYTES = 3 * 1024 * 1024;

/**
 * Most the Film Crew may spend on one campaign before asking the agent, in US
 * dollars (Paul, 22 Oct 2026). Counts every Film Crew model call: post copy
 * and images. The letter draft is not media and is not counted.
 */
export const MEDIA_BUDGET_USD_PER_CAMPAIGN = 1;

/** Ok with the amount left after `nextCostUsd`, or an error saying what is spent and what is left. */
export function checkMediaBudget(
  spentUsd: number,
  nextCostUsd: number,
  capUsd: number = MEDIA_BUDGET_USD_PER_CAMPAIGN,
): Result<number, 'over_budget'> {
  const left = Math.round((capUsd - spentUsd - nextCostUsd) * 1_000_000) / 1_000_000;
  if (left >= 0) return ok(left);
  return err(
    'over_budget',
    `This campaign has used $${spentUsd.toFixed(2)} of its $${capUsd.toFixed(2)} media budget; the next step would cost about $${nextCostUsd.toFixed(2)}.`,
  );
}

/** Identify an image from its first bytes; null if it is not PNG, JPEG or WebP. */
export function sniffImageType(bytes: Uint8Array): MediaContentType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * The only facts a post may use: the area (ZIP code, city when the roll names
 * one, county), the kind of home, and the agent. Deliberately absent: the
 * address, the owner, and everything about how the owner was selected.
 */
export function areaFacts(parcel: StoredParcel, agent: AgentForDraft): CampaignFact[] {
  const f: CampaignFact[] = [];
  const pr = (key: string, label: string, value: string | null | undefined) => {
    if (value?.trim()) f.push({ key, label, value: value.trim(), source: 'public_record' });
  };
  pr('area.zip', 'ZIP code', parcel.situs.zip);
  // The roll says "UNINCORPORATED COUNTY" (or similar) where no city applies; that is not a place name.
  if (parcel.situs.city && !/unincorporated|county/i.test(parcel.situs.city)) pr('area.city', 'City', titleCase(parcel.situs.city));
  pr('area.home_type', 'Home type', DOR_USE_LABELS[parcel.useCode]);
  f.push(...campaignFacts(parcel, agent).filter((x) => x.key.startsWith('agent.')));
  return f;
}

export interface SocialPost {
  readonly headline: string;
  readonly caption: string;
  readonly callToAction: string;
  readonly hashtags: readonly string[];
  /** What the picture should show; turned into the image prompt by `neighborhoodImagePrompt`. */
  readonly imageBrief: string;
  readonly factsUsed: readonly string[];
}

const SYSTEM = `You are the social-media copywriter on a real-estate agent's marketing team in Florida. You write one social post (Instagram or Facebook) that introduces the agent to homeowners in an area who may be thinking about selling. The agent reviews everything; nothing is posted without their approval.

Rules you must follow:
1. Use ONLY the facts provided. Never invent prices, values, sales, statistics, market trends, timelines, awards, reviews or anything else.
2. The post is about the agent and the area, never about one property: do not mention any address, street, house number or property owner, and never imply you know anyone's plans or circumstances.
3. Never mention or hint at tax records, assessments, homestead, absentee or out-of-state ownership, estates, probate, inheritance, death, divorce, debt, foreclosure, illness, age, or any hardship.
4. Fair housing: never refer to race, colour, religion, national origin, sex, disability, familial status (children, families, couples, singles), age, or any proxy for them, and never describe who lives or should live in the area.
5. No pressure or guarantees: no "act now", no guaranteed sale or price, no claims that the market is about to change.
6. Florida advertising: the caption must include the agent's name and the brokerage name exactly as provided, and the license number if provided.
7. Format: headline up to 70 characters; caption 40 to 150 words; one call to action inviting a no-obligation conversation (by direct message or by contacting the agent); 3 to 6 hashtags, each "#" followed by letters and digits only.
8. imageBrief: one or two sentences describing a photograph of the general area to accompany the post (streets, trees, water, skyline or light) with no people, no text or signs, and no single identifiable house.

Answer with a single JSON object and nothing else, in this shape:
{"headline": string, "caption": string, "callToAction": string, "hashtags": [string], "imageBrief": string, "factsUsed": [string]}
"factsUsed" contains only keys from the provided facts.`;

/** The prompt for one post. `problems` is set on the single retry after a failed check. */
export function socialPostPrompt(facts: readonly CampaignFact[], problems: readonly string[] = []): { system: string; user: string } {
  const lines = facts.map((x) => `- ${x.key} (${x.label}): ${x.value}`).join('\n');
  const retry = problems.length
    ? `\n\nYour previous post was rejected for these reasons. Fix every one:\n${problems.map((p) => `- ${p}`).join('\n')}`
    : '';
  return {
    system: SYSTEM,
    user: `Write one social post introducing this agent to homeowners in this area who may be considering selling.\n\nFacts:\n${lines}${retry}`,
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validate the model's JSON. Anything malformed is a failed post, never a guess. */
export function parseSocialPost(value: unknown): Result<SocialPost, 'invalid_post'> {
  const bad = (why: string) => err('invalid_post' as const, why);
  if (!value || typeof value !== 'object') return bad('The reply is not an object.');
  const v = value as Record<string, unknown>;
  if (!isStr(v.headline) || !isStr(v.caption) || !isStr(v.callToAction) || !isStr(v.imageBrief)) return bad('Missing headline, caption, call to action or image brief.');
  if (!strArr(v.hashtags) || !strArr(v.factsUsed)) return bad('Missing hashtags or facts used.');
  return ok({
    headline: v.headline.trim(),
    caption: v.caption.trim(),
    callToAction: v.callToAction.trim(),
    hashtags: v.hashtags.map((h) => h.trim()).filter(Boolean),
    imageBrief: v.imageBrief.trim(),
    factsUsed: v.factsUsed,
  });
}

/** Text a reader of the post sees, plus the image brief (which must not reveal the subject either). */
export function socialPostText(p: SocialPost): string {
  return [p.headline, p.caption, p.callToAction, p.hashtags.join(' '), p.imageBrief].join('\n');
}

/** What a post must never reveal: the campaign's property and its owner. */
export interface PostSubject {
  readonly address: string;
  readonly ownerName: string;
}

/** Run every check. An empty list means the post may be shown for review. */
export function checkSocialPost(
  p: SocialPost,
  facts: readonly CampaignFact[],
  agent: AgentForDraft,
  subject: PostSubject,
): DraftProblem[] {
  const problems: DraftProblem[] = [...unsupportedFigures(socialPostText(p), facts)];
  const keys = new Set(facts.map((f) => f.key));
  for (const k of p.factsUsed) if (!keys.has(k)) problems.push({ code: 'unknown_fact', message: `Fact key "${k}" was not provided.` });

  const caption = normalizeText(p.caption);
  if (!caption.includes(normalizeText(agent.brokerageName))) {
    problems.push({ code: 'missing_brokerage', message: `The caption must include the brokerage name "${agent.brokerageName}".` });
  }
  if (!caption.includes(normalizeText(agent.licenseeName))) {
    problems.push({ code: 'missing_brokerage', message: `The caption must include the agent's name "${agent.licenseeName}".` });
  }

  // The property and its owner never appear: not the address, the house number followed by the
  // start of the street, the street itself, or the owner's name. A house number alone is not
  // flagged: it can equal a ZIP code or another figure the post may use.
  const text = ` ${normalizeText(socialPostText(p))} `;
  const address = normalizeText(subject.address);
  const houseNumber = /^\d+/.exec(address)?.[0];
  const street = houseNumber ? address.slice(houseNumber.length).trim() : address;
  const streetStart = street.split(' ')[0] ?? '';
  const numberOnStreet = houseNumber && streetStart ? ` ${houseNumber} ${streetStart} ` : null;
  if (address && (text.includes(` ${address} `) || (numberOnStreet && text.includes(numberOnStreet)) || (street.length > 5 && text.includes(` ${street} `)))) {
    problems.push({ code: 'reveals_subject', message: 'The post must not mention the property, its address or its street.' });
  }
  const owner = normalizeText(subject.ownerName);
  if (owner.length > 3 && text.includes(` ${owner} `)) {
    problems.push({ code: 'reveals_subject', message: 'The post must not mention the property owner.' });
  }

  problems.push(...prohibitedTerms(socialPostText(p), agent));

  if (p.headline.length > 80) problems.push({ code: 'too_long', message: `The headline has ${p.headline.length} characters; keep it under 70.` });
  const words = p.caption.split(/\s+/).filter(Boolean).length;
  if (words > 170) problems.push({ code: 'too_long', message: `The caption has ${words} words; keep it under 150.` });
  if (p.imageBrief.length > 400) problems.push({ code: 'too_long', message: 'The image brief is too long; keep it to two sentences.' });
  if (p.hashtags.length < 1 || p.hashtags.length > 8) problems.push({ code: 'bad_hashtag', message: 'Use 3 to 6 hashtags.' });
  for (const h of p.hashtags) {
    if (!/^#[A-Za-z0-9]{2,40}$/.test(h)) problems.push({ code: 'bad_hashtag', message: `"${h}" is not a valid hashtag; use "#" followed by letters and digits.` });
  }
  return problems.filter((x, i, all) => all.findIndex((q) => q.message === x.message) === i);
}

/**
 * The image prompt: the copywriter's brief inside fixed rules. The rules are
 * GenCut's, not the model's, so a brief cannot remove them.
 */
export function neighborhoodImagePrompt(brief: string, facts: readonly CampaignFact[]): string {
  const v = (key: string) => facts.find((f) => f.key === key)?.value;
  const place = [v('area.city'), v('agent.market'), 'Florida'].filter(Boolean).join(', ');
  return [
    `A photorealistic, editorial-quality photograph for a real-estate agent's social media post, set in ${place}.`,
    `Scene: ${brief}`,
    'Requirements: no people and no faces; no text, letters, numbers, signs, logos or watermarks; show a general neighborhood or landscape, never a single identifiable house or address; natural light; portrait framing.',
  ].join('\n');
}
