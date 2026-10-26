/**
 * What actually happened with an opportunity (seller or buyer), recorded by the
 * agent. Mirrors the CHECK on opportunity_outcomes.outcome.
 */
export const OUTCOMES = [
  'contacted',
  'no_response',
  'responded',
  'not_interested',
  'qualified_conversation',
  'appointment',
  'offer',
  'listing',
  'closed',
  'wrong_address',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Outcomes that mean the other party replied. */
export const REPLIED_OUTCOMES: readonly Outcome[] = ['responded', 'not_interested', 'qualified_conversation', 'appointment', 'offer', 'listing', 'closed'];
/** Outcomes that mean a meeting or better. */
export const APPOINTMENT_OR_BETTER: readonly Outcome[] = ['appointment', 'offer', 'listing', 'closed'];
/** Outcomes that mean a deal: a listing taken, or a transaction closed. */
export const DEAL_OUTCOMES: readonly Outcome[] = ['listing', 'closed'];
