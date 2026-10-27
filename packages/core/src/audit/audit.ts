/**
 * Audit events. Every state change and every gate decision produces one, from
 * whichever interface caused it. Stored append-only (see packages/db).
 */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'agent', 'executor'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_INTERFACES = ['web', 'whatsapp', 'worker', 'api'] as const;
export type AuditInterface = (typeof AUDIT_INTERFACES)[number];

export const AUDIT_ENTITY_TYPES = [
  'workspace',
  'membership',
  'business_profile',
  'campaign',
  'outreach_action',
  'opportunity',
  'permission',
  'consent',
  'suppression',
  'whatsapp_link',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AuditEvent {
  readonly workspaceId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly via: AuditInterface;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  readonly action: string;
  readonly fromState?: string;
  readonly toState?: string;
  /** Structured detail, e.g. the full gate decision. Never prompts or secrets. */
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export function stateChangeEvent(args: {
  workspaceId: string;
  actorType: AuditActorType;
  actorId: string | null;
  via: AuditInterface;
  entityType: AuditEvent['entityType'];
  entityId: string;
  fromState: string;
  toState: string;
  detail?: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}): AuditEvent {
  return { ...args, action: 'state_change' };
}
