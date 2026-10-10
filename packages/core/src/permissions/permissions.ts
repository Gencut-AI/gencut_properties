import { CHANNELS, type Channel } from '../channels.ts';

/**
 * Three separate grants. Access to public information authorizes discovery
 * only; generating content and contacting a person are separate decisions,
 * and contact is granted channel by channel.
 */
export const PERMISSION_KINDS = ['discover', 'generate', 'contact'] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export interface WorkspacePermissions {
  readonly discover: boolean;
  readonly generate: boolean;
  readonly contact: Readonly<Record<Channel, boolean>>;
}

/** New workspaces may discover and generate; every contact channel starts off. */
export function defaultPermissions(): WorkspacePermissions {
  const contact = Object.fromEntries(CHANNELS.map((c) => [c, false])) as Record<Channel, boolean>;
  return { discover: true, generate: true, contact };
}

export type PermissionRequest =
  | { readonly kind: 'discover' }
  | { readonly kind: 'generate' }
  | { readonly kind: 'contact'; readonly channel: Channel };

export function isPermitted(perms: WorkspacePermissions, req: PermissionRequest): boolean {
  switch (req.kind) {
    case 'discover':
      return perms.discover;
    case 'generate':
      return perms.generate;
    case 'contact':
      return perms.contact[req.channel];
  }
}

/** Return a copy with one contact channel granted or revoked. */
export function withContact(perms: WorkspacePermissions, channel: Channel, granted: boolean): WorkspacePermissions {
  return { ...perms, contact: { ...perms.contact, [channel]: granted } };
}
