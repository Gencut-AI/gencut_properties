import type { AuditActorType, AuditEntityType, AuditInterface } from '@gencut/core';
import type { Db } from './db.ts';

export interface AuditRecord {
  readonly workspaceId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly via: AuditInterface;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  readonly action: string;
  readonly fromState?: string | null;
  readonly toState?: string | null;
  /** Structured detail. Never secrets, prompts or full personal data. */
  readonly detail?: Record<string, unknown>;
}

/** Append one audit event. Call inside the same transaction as the change. */
export async function recordAudit(db: Db, r: AuditRecord): Promise<void> {
  await db`
    INSERT INTO audit_events (workspace_id, actor_type, actor_id, via, entity_type, entity_id, action, from_state, to_state, detail)
    VALUES (${r.workspaceId}, ${r.actorType}, ${r.actorId}, ${r.via}, ${r.entityType}, ${r.entityId}, ${r.action},
            ${r.fromState ?? null}, ${r.toState ?? null}, ${db.json((r.detail ?? {}) as never)})
  `;
}
