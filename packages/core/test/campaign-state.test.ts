import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CampaignState, CAMPAIGN_STATES, CAMPAIGN_TRANSITIONS, checkCampaignTransition } from '../src/index.ts';

describe('campaign state machine', () => {
  it('accepts listed transitions and rejects all others', () => {
    for (const from of CAMPAIGN_STATES) {
      for (const to of CAMPAIGN_STATES) {
        const expected = CAMPAIGN_TRANSITIONS[from].includes(to);
        assert.equal(checkCampaignTransition(from, to).ok, expected, `${from}->${to}`);
      }
    }
  });

  it('cannot go active without approval', () => {
    const reachActive = CAMPAIGN_STATES.filter((s) => CAMPAIGN_TRANSITIONS[s].includes('active'));
    assert.deepEqual(reachActive, ['approved']);
  });

  it('treats archived as terminal', () => {
    assert.deepEqual(CAMPAIGN_TRANSITIONS.archived, []);
  });

  it('every state can eventually be archived', () => {
    for (const s of CAMPAIGN_STATES) {
      if (s === 'archived') continue;
      const seen = new Set<CampaignState>([s]);
      const queue: CampaignState[] = [s];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const next of CAMPAIGN_TRANSITIONS[cur]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      assert.ok(seen.has('archived'), `${s} cannot reach archived`);
    }
  });
});
