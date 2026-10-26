/**
 * The kinds of campaign draft GenCut writes, keyed by the prompt version stored
 * on each campaign. Generation, editing and re-checking all look the kind up
 * here, so a campaign is always checked by the rules it was written under.
 */
import { BUYER_LETTER_PROMPT_VERSION, buyerLetterPrompt, checkBuyerLetter } from '../buyers/buyer-letter.ts';
import {
  type AgentForDraft,
  CAMPAIGN_PROMPT_VERSION,
  type CampaignDraft,
  type CampaignFact,
  type DraftProblem,
  campaignPrompt,
  checkCampaignDraft,
} from './draft.ts';

export interface DraftKind {
  readonly version: string;
  /** Who the letter is to: the owner of a property, or a buying company. */
  readonly audience: 'owner' | 'company';
  prompt(facts: readonly CampaignFact[], problems?: readonly string[]): { system: string; user: string };
  check(draft: CampaignDraft, facts: readonly CampaignFact[], agent: AgentForDraft): DraftProblem[];
}

export const SELLER_DRAFT: DraftKind = { version: CAMPAIGN_PROMPT_VERSION, audience: 'owner', prompt: campaignPrompt, check: checkCampaignDraft };
export const BUYER_DRAFT: DraftKind = { version: BUYER_LETTER_PROMPT_VERSION, audience: 'company', prompt: buyerLetterPrompt, check: checkBuyerLetter };

/** The kind a stored campaign was written under; null for a version GenCut no longer knows. */
export function draftKind(version: string | null): DraftKind | null {
  if (version === BUYER_LETTER_PROMPT_VERSION) return BUYER_DRAFT;
  if (version === CAMPAIGN_PROMPT_VERSION || version === null) return SELLER_DRAFT;
  return null;
}
