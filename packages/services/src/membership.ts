import { z } from 'zod';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { ServiceError } from './errors.ts';

export type MembershipRole = 'owner' | 'member';

/** The caller's role in the workspace, or `forbidden`. Every workspace read and write goes through this. */
export async function requireMembership(db: Db, userId: string, workspaceId: string): Promise<MembershipRole> {
  if (!z.uuid().safeParse(workspaceId).success) throw new ServiceError('forbidden', 'You do not have access to this workspace.');
  const [row] = await db<{ role: MembershipRole }[]>`
    SELECT role FROM memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
  `;
  if (!row) throw new ServiceError('forbidden', 'You do not have access to this workspace.');
  return row.role;
}

/** `requireMembership` for the signed-in caller. */
export function requireMembershipFor(db: Db, ctx: RequestContext, workspaceId: string): Promise<MembershipRole> {
  return requireMembership(db, ctx.userId, workspaceId);
}
