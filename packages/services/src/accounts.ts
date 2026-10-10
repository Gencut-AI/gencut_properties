import { CHANNELS, type Channel, PROPERTY_USES, type WorkspacePermissions } from '@gencut/core';
import { z } from 'zod';
import { recordAudit } from './audit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Sql } from './db.ts';
import { ServiceError } from './errors.ts';

export const MARKETS = [
  { key: 'miami-dade', label: 'Miami-Dade County' },
  { key: 'broward', label: 'Broward County' },
  { key: 'palm-beach', label: 'Palm Beach County' },
] as const;
export type MarketKey = (typeof MARKETS)[number]['key'];

export type MembershipRole = 'owner' | 'member';

export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: MembershipRole;
}

/**
 * Make sure the signed-in user has a user row and a workspace. The first call
 * for a new user creates a workspace they own, with discover and generate
 * granted and every contact channel off. Safe to call on every request.
 */
export async function ensureWorkspace(sql: Sql, ctx: RequestContext): Promise<WorkspaceMembership & { created: boolean }> {
  return (await sql.begin(async (tx) => {
    // Serialize concurrent first requests for the same user.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${ctx.userId}))`;
    await tx`
      INSERT INTO users (id, email) VALUES (${ctx.userId}, ${ctx.email})
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
    `;
    const existing = await membershipsFor(tx, ctx.userId);
    if (existing[0]) return { ...existing[0], created: false };

    const name = ctx.email.split('@')[0] || 'My workspace';
    const [ws] = await tx<{ id: string }[]>`INSERT INTO workspaces (name) VALUES (${name}) RETURNING id`;
    if (!ws) throw new Error('workspace insert returned no row');
    await tx`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${ws.id}, ${ctx.userId}, 'owner')`;
    await tx`
      INSERT INTO workspace_permissions (workspace_id, kind, granted_by)
      VALUES (${ws.id}, 'discover', ${ctx.userId}), (${ws.id}, 'generate', ${ctx.userId})
    `;
    const actor = { workspaceId: ws.id, actorType: 'user', actorId: ctx.userId, via: ctx.via } as const;
    await recordAudit(tx, { ...actor, entityType: 'workspace', entityId: ws.id, action: 'created' });
    await recordAudit(tx, { ...actor, entityType: 'membership', entityId: ctx.userId, action: 'created', toState: 'owner' });
    await recordAudit(tx, {
      ...actor,
      entityType: 'permission',
      entityId: ws.id,
      action: 'granted',
      detail: { kinds: ['discover', 'generate'] },
    });
    return { workspaceId: ws.id, workspaceName: name, role: 'owner' as const, created: true };
  })) as WorkspaceMembership & { created: boolean };
}

async function membershipsFor(db: Db, userId: string): Promise<WorkspaceMembership[]> {
  const rows = await db<{ workspace_id: string; name: string; role: MembershipRole }[]>`
    SELECT m.workspace_id, w.name, m.role
    FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ${userId}
    ORDER BY m.created_at, m.workspace_id
  `;
  return rows.map((r) => ({ workspaceId: r.workspace_id, workspaceName: r.name, role: r.role }));
}

/** The caller's role in the workspace, or `forbidden`. Every workspace read and write goes through this. */
export async function requireMembership(db: Db, userId: string, workspaceId: string): Promise<MembershipRole> {
  if (!z.uuid().safeParse(workspaceId).success) throw new ServiceError('forbidden', 'You do not have access to this workspace.');
  const [row] = await db<{ role: MembershipRole }[]>`
    SELECT role FROM memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
  `;
  if (!row) throw new ServiceError('forbidden', 'You do not have access to this workspace.');
  return row.role;
}

const zip = z.string().regex(/^\d{5}$/, 'Use 5-digit ZIP codes.');

export const businessProfileInput = z
  .object({
    licenseeName: z.string().trim().min(2, 'Enter your name as licensed.').max(100),
    brokerageName: z
      .string()
      .trim()
      .min(2, 'Enter your brokerage name as registered with the state.')
      .max(120),
    licenseNumber: z
      .string()
      .trim()
      .max(20)
      .regex(/^[A-Za-z0-9-]*$/, 'Use letters and numbers only.')
      .optional()
      .transform((v) => (v ? v.toUpperCase() : undefined)),
    officeAddress: z.string().trim().max(200).optional().transform((v) => v || undefined),
    market: z.enum(MARKETS.map((m) => m.key) as [MarketKey, ...MarketKey[]], { error: 'Choose your market.' }),
    specialty: z.string().trim().max(120).optional().transform((v) => v || undefined),
    focusZips: z.array(zip).min(1, 'Add at least one ZIP code you work.').max(30, 'Up to 30 ZIP codes.'),
    propertyUses: z.array(z.enum(PROPERTY_USES)).min(1, 'Choose at least one property type.'),
    minValue: z.number().int().min(0).max(1_000_000_000).optional(),
    maxValue: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .refine((v) => v.minValue === undefined || v.maxValue === undefined || v.minValue <= v.maxValue, {
    message: 'The minimum price is above the maximum.',
    path: ['maxValue'],
    // Check the price range even when other fields are invalid, so the user
    // sees every problem at once.
    when: (payload) => {
      const v = payload.value as { minValue?: unknown; maxValue?: unknown } | undefined;
      return typeof v?.minValue === 'number' && typeof v?.maxValue === 'number';
    },
  });

export type BusinessProfileInput = z.input<typeof businessProfileInput>;

export interface BusinessProfile {
  readonly workspaceId: string;
  readonly licenseeName: string;
  readonly brokerageName: string;
  readonly licenseNumber: string | null;
  readonly officeAddress: string | null;
  readonly market: MarketKey;
  readonly specialty: string | null;
  readonly focusZips: readonly string[];
  readonly propertyUses: readonly (typeof PROPERTY_USES)[number][];
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly updatedAt: Date;
}

interface ProfileRow {
  workspace_id: string;
  licensee_name: string;
  brokerage_name: string;
  license_number: string | null;
  office_address: string | null;
  market: MarketKey;
  specialty: string | null;
  focus: { zips?: string[]; propertyUses?: BusinessProfile['propertyUses'][number][]; minValue?: number; maxValue?: number };
  updated_at: Date;
}

function toProfile(r: ProfileRow): BusinessProfile {
  return {
    workspaceId: r.workspace_id,
    licenseeName: r.licensee_name,
    brokerageName: r.brokerage_name,
    licenseNumber: r.license_number,
    officeAddress: r.office_address,
    market: r.market,
    specialty: r.specialty,
    focusZips: r.focus.zips ?? [],
    propertyUses: r.focus.propertyUses ?? [],
    minValue: r.focus.minValue ?? null,
    maxValue: r.focus.maxValue ?? null,
    updatedAt: r.updated_at,
  };
}

export async function getBusinessProfile(db: Db, ctx: RequestContext, workspaceId: string): Promise<BusinessProfile | null> {
  await requireMembership(db, ctx.userId, workspaceId);
  const [row] = await db<ProfileRow[]>`SELECT * FROM business_profiles WHERE workspace_id = ${workspaceId}`;
  return row ? toProfile(row) : null;
}

/** Validate and save the business profile; records which fields changed. */
export async function saveBusinessProfile(
  sql: Sql,
  ctx: RequestContext,
  workspaceId: string,
  input: unknown,
): Promise<BusinessProfile> {
  const parsed = businessProfileInput.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fields[key] ??= issue.message;
    }
    throw new ServiceError('invalid', 'Some details need fixing.', fields);
  }
  const v = parsed.data;
  const focus = {
    zips: [...new Set(v.focusZips)],
    propertyUses: [...new Set(v.propertyUses)],
    ...(v.minValue !== undefined ? { minValue: v.minValue } : {}),
    ...(v.maxValue !== undefined ? { maxValue: v.maxValue } : {}),
  };

  return (await sql.begin(async (tx) => {
    await requireMembership(tx, ctx.userId, workspaceId);
    const [before] = await tx<ProfileRow[]>`SELECT * FROM business_profiles WHERE workspace_id = ${workspaceId} FOR UPDATE`;
    const [row] = await tx<ProfileRow[]>`
      INSERT INTO business_profiles (workspace_id, licensee_name, brokerage_name, license_number, office_address, market, specialty, focus, updated_at)
      VALUES (${workspaceId}, ${v.licenseeName}, ${v.brokerageName}, ${v.licenseNumber ?? null}, ${v.officeAddress ?? null},
              ${v.market}, ${v.specialty ?? null}, ${tx.json(focus)}, now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        licensee_name = EXCLUDED.licensee_name, brokerage_name = EXCLUDED.brokerage_name,
        license_number = EXCLUDED.license_number, office_address = EXCLUDED.office_address,
        market = EXCLUDED.market, specialty = EXCLUDED.specialty, focus = EXCLUDED.focus, updated_at = now()
      RETURNING *
    `;
    if (!row) throw new Error('profile upsert returned no row');
    await tx`UPDATE workspaces SET name = ${v.licenseeName} WHERE id = ${workspaceId}`;
    const after = toProfile(row);
    await recordAudit(tx, {
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      via: ctx.via,
      entityType: 'business_profile',
      entityId: workspaceId,
      action: before ? 'updated' : 'created',
      detail: { changedFields: before ? changedFields(toProfile(before), after) : Object.keys(v) },
    });
    return after;
  })) as BusinessProfile;
}

function changedFields(a: BusinessProfile, b: BusinessProfile): string[] {
  const keys = ['licenseeName', 'brokerageName', 'licenseNumber', 'officeAddress', 'market', 'specialty', 'focusZips', 'propertyUses', 'minValue', 'maxValue'] as const;
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** Current grants for a workspace, as the domain model's permission object. */
export async function getPermissions(db: Db, ctx: RequestContext, workspaceId: string): Promise<WorkspacePermissions> {
  await requireMembership(db, ctx.userId, workspaceId);
  const rows = await db<{ kind: string; channel: Channel | null }[]>`
    SELECT kind, channel FROM workspace_permissions WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
  `;
  const contact = Object.fromEntries(CHANNELS.map((c) => [c, rows.some((r) => r.kind === 'contact' && r.channel === c)])) as Record<
    Channel,
    boolean
  >;
  return { discover: rows.some((r) => r.kind === 'discover'), generate: rows.some((r) => r.kind === 'generate'), contact };
}
