import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTORS,
  OUTREACH_STATES,
  OUTREACH_TRANSITIONS,
  checkOutreachTransition,
  isEditable,
  isLegalOutreachTransition,
} from '../src/index.ts';

describe('outreach action state machine', () => {
  it('accepts exactly the nine documented transitions', () => {
    const legal: string[] = [];
    for (const from of OUTREACH_STATES) {
      for (const to of OUTREACH_STATES) {
        if (isLegalOutreachTransition(from, to)) legal.push(`${from}->${to}`);
      }
    }
    assert.deepEqual(legal.sort(), [
      'APPROVED->DRAFT',
      'APPROVED->EXECUTING',
      'APPROVED->FAILED',
      'DRAFT->READY',
      'EXECUTING->COMPLETED',
      'EXECUTING->FAILED',
      'FAILED->DRAFT',
      'READY->APPROVED',
      'READY->DRAFT',
    ]);
  });

  it('rejects every other pair for every actor', () => {
    for (const from of OUTREACH_STATES) {
      for (const to of OUTREACH_STATES) {
        if (isLegalOutreachTransition(from, to)) continue;
        for (const actor of ACTORS) {
          const r = checkOutreachTransition({ from, to, actor, approvedBy: 'u1' });
          assert.equal(r.ok, false, `${from}->${to} by ${actor} should be rejected`);
          if (!r.ok) assert.equal(r.error, 'illegal_transition');
        }
      }
    }
  });

  it('allows each legal transition only for its listed actors', () => {
    for (const rule of OUTREACH_TRANSITIONS) {
      for (const actor of ACTORS) {
        const r = checkOutreachTransition({ from: rule.from, to: rule.to, actor, approvedBy: 'u1' });
        if (rule.actors.includes(actor)) {
          assert.equal(r.ok, true, `${rule.from}->${rule.to} by ${actor} should pass`);
        } else {
          assert.equal(r.ok, false);
          if (!r.ok) assert.equal(r.error, 'actor_not_allowed');
        }
      }
    }
  });

  it('only the executor can start execution, and nothing skips approval', () => {
    for (const from of OUTREACH_STATES) {
      const toExecuting = checkOutreachTransition({ from, to: 'EXECUTING', actor: 'executor' });
      assert.equal(toExecuting.ok, from === 'APPROVED');
    }
    assert.equal(checkOutreachTransition({ from: 'APPROVED', to: 'EXECUTING', actor: 'user' }).ok, false);
    assert.equal(checkOutreachTransition({ from: 'APPROVED', to: 'EXECUTING', actor: 'system' }).ok, false);
  });

  it('requires the approving user id', () => {
    const r = checkOutreachTransition({ from: 'READY', to: 'APPROVED', actor: 'user' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'approval_missing');
    assert.equal(checkOutreachTransition({ from: 'READY', to: 'APPROVED', actor: 'user', approvedBy: 'u1' }).ok, true);
  });

  it('marks only pre-execution states as editable', () => {
    assert.deepEqual(
      OUTREACH_STATES.filter((s) => isEditable(s)),
      ['DRAFT', 'READY', 'FAILED'],
    );
  });
});
