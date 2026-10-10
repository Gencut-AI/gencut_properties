import type { AuditInterface } from '@gencut/core';

/**
 * Who is calling and through which interface. Built by the web app from the
 * verified session, by the WhatsApp webhook from the linked identity, and by
 * the worker for system jobs. Services never trust ids from request bodies
 * for authorization; they check membership for `userId`.
 */
export interface RequestContext {
  readonly userId: string;
  readonly email: string;
  readonly via: AuditInterface;
}
