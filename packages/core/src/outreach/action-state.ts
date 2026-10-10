import { err, ok, type Result } from '../result.ts';

/**
 * Lifecycle of every external action (an email, a mailed letter, a call task…).
 * Recommendation and execution are never confused: only the executor can move
 * an action past APPROVED, and only a user can approve.
 */
export const OUTREACH_STATES = ['DRAFT', 'READY', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED'] as const;
export type OutreachState = (typeof OUTREACH_STATES)[number];

/** Who is asking for the transition. */
export const ACTORS = ['user', 'system', 'executor'] as const;
export type Actor = (typeof ACTORS)[number];

interface TransitionRule {
  readonly from: OutreachState;
  readonly to: OutreachState;
  readonly actors: readonly Actor[];
  readonly meaning: string;
}

/**
 * The complete set of legal transitions. Anything not listed is rejected.
 * Mirrored by the database trigger in packages/db/migrations/0001_core.up.sql;
 * a test keeps the two in sync.
 */
export const OUTREACH_TRANSITIONS: readonly TransitionRule[] = [
  { from: 'DRAFT', to: 'READY', actors: ['user', 'system'], meaning: 'content complete and checked' },
  { from: 'READY', to: 'DRAFT', actors: ['user'], meaning: 'user edits the content' },
  { from: 'READY', to: 'APPROVED', actors: ['user'], meaning: 'user approves this exact content' },
  { from: 'APPROVED', to: 'DRAFT', actors: ['user'], meaning: 'editing revokes the approval' },
  { from: 'APPROVED', to: 'EXECUTING', actors: ['executor'], meaning: 'compliance gate passed at send time' },
  { from: 'APPROVED', to: 'FAILED', actors: ['executor'], meaning: 'compliance gate blocked it at send time' },
  { from: 'EXECUTING', to: 'COMPLETED', actors: ['executor'], meaning: 'provider confirmed delivery or task done' },
  { from: 'EXECUTING', to: 'FAILED', actors: ['executor'], meaning: 'provider or task failed' },
  { from: 'FAILED', to: 'DRAFT', actors: ['user'], meaning: 'user revises; it must be approved again' },
];

export function isOutreachState(value: string): value is OutreachState {
  return (OUTREACH_STATES as readonly string[]).includes(value);
}

function findRule(from: OutreachState, to: OutreachState): TransitionRule | undefined {
  return OUTREACH_TRANSITIONS.find((r) => r.from === from && r.to === to);
}

/** True when some actor may make this transition. */
export function isLegalOutreachTransition(from: OutreachState, to: OutreachState): boolean {
  return findRule(from, to) !== undefined;
}

export type OutreachTransitionError = 'illegal_transition' | 'actor_not_allowed' | 'approval_missing';

export interface OutreachTransitionRequest {
  readonly from: OutreachState;
  readonly to: OutreachState;
  readonly actor: Actor;
  /** Required when a user approves: the id of the approving user. */
  readonly approvedBy?: string;
}

/**
 * Validate a requested transition. Pure: persisting the new state and writing
 * the audit event are the caller's job (see audit/audit.ts).
 */
export function checkOutreachTransition(
  req: OutreachTransitionRequest,
): Result<OutreachState, OutreachTransitionError> {
  const rule = findRule(req.from, req.to);
  if (!rule) {
    return err('illegal_transition', `An action cannot move from ${req.from} to ${req.to}.`);
  }
  if (!rule.actors.includes(req.actor)) {
    return err(
      'actor_not_allowed',
      `Only ${rule.actors.join(' or ')} may move an action from ${req.from} to ${req.to}.`,
    );
  }
  if (req.to === 'APPROVED' && !req.approvedBy) {
    return err('approval_missing', 'Approving an action requires the id of the approving user.');
  }
  return ok(req.to);
}

/** States in which nothing external has happened yet and content may still change. */
export function isEditable(state: OutreachState): boolean {
  return state === 'DRAFT' || state === 'READY' || state === 'FAILED';
}
