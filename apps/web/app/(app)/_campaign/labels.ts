import type { CampaignState } from '@gencut/core';

export const CAMPAIGN_STATUS_LABEL: Readonly<Record<CampaignState, string>> = {
  generating: 'Writing…',
  generation_failed: 'Needs a retry',
  review: 'Draft for review',
  approved: 'Approved',
  active: 'Active',
  completed: 'Completed',
  archived: 'Archived',
};

export const CHANNEL_LABEL = { mail: 'Letter', call_task: 'Call reminder', email: 'Email' } as const;
