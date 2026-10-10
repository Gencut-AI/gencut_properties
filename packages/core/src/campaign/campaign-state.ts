import { err, ok, type Result } from '../result.ts';

/**
 * Lifecycle of a campaign — the central product object that ties an
 * opportunity, its research, creative package, outreach actions and outcomes.
 */
export const CAMPAIGN_STATES = [
  'generating',
  'generation_failed',
  'review',
  'approved',
  'active',
  'completed',
  'archived',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

/** Legal campaign transitions, keyed by the source state. */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignState, readonly CampaignState[]>> = {
  generating: ['review', 'generation_failed'],
  generation_failed: ['generating', 'archived'],
  review: ['generating', 'approved', 'archived'],
  approved: ['review', 'active', 'archived'],
  active: ['completed', 'archived'],
  completed: ['archived'],
  archived: [],
};

export function isCampaignState(value: string): value is CampaignState {
  return (CAMPAIGN_STATES as readonly string[]).includes(value);
}

export function checkCampaignTransition(
  from: CampaignState,
  to: CampaignState,
): Result<CampaignState, 'illegal_transition'> {
  if (CAMPAIGN_TRANSITIONS[from].includes(to)) return ok(to);
  return err('illegal_transition', `A campaign cannot move from ${from} to ${to}.`);
}
