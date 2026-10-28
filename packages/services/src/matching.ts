/**
 * Seller–buyer matches (Buyer Radar B3), computed when a page asks, from the
 * workspace's own seller opportunities and buyers. Agent-only: a match is a
 * recommendation to review, not a sign anyone is buying and not permission to
 * contact either side.
 */
import { type BuyerProfile, type MatchReason, type StoredParcel, DOR_USE_LABELS, matchBuyerToHome } from '@gencut/core';
import { z } from 'zod';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { ServiceError } from './errors.ts';
import { requireMembershipFor } from './membership.ts';

export const MATCHES_SHOWN = 5;

export interface BuyerMatch {
  readonly buyerId: string;
  readonly name: string;
  readonly purchases: number;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

export interface SellerMatch {
  readonly sellerId: string;
  readonly address: string;
  readonly zip: string;
  readonly homeType: string;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

const homeOf = (p: StoredParcel) => ({ zip: p.situs.zip, useCode: p.useCode, marketValue: p.justValue ?? null });

/** Investor buyers whose past purchases fit this seller opportunity, best first. */
export async function matchesForSeller(db: Db, ctx: RequestContext, workspaceId: string, sellerId: string, limit = MATCHES_SHOWN): Promise<BuyerMatch[]> {
  await requireMembershipFor(db, ctx, workspaceId);
  if (!z.uuid().safeParse(sellerId).success) throw new ServiceError('not_found', 'That opportunity does not exist.');
  const [seller] = await db<{ payload: StoredParcel }[]>`
    SELECT r.payload FROM opportunities o JOIN source_records r ON r.id = o.source_record_id
    WHERE o.workspace_id = ${workspaceId} AND o.id = ${sellerId} AND o.type = 'potential_seller'
  `;
  if (!seller) throw new ServiceError('not_found', 'That opportunity does not exist.');
  const home = homeOf(seller.payload);
  const buyers = await db<{ id: string; evidence: { profile: BuyerProfile; rollFileDate: string } }[]>`
    SELECT id, evidence FROM opportunities
    WHERE workspace_id = ${workspaceId} AND type = 'investor_buyer' AND status <> 'dismissed'
      AND evidence->'profile'->'zips' @> ${db.json([{ zip: home.zip }] as never)}
  `;
  return buyers
    .flatMap((b) => {
      const m = matchBuyerToHome(home, b.evidence.profile, b.evidence.rollFileDate);
      return m ? [{ buyerId: b.id, name: b.evidence.profile.name, purchases: b.evidence.profile.purchases, score: m.score, reasons: m.reasons }] : [];
    })
    .sort((a, b) => b.score - a.score || b.purchases - a.purchases || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The workspace's seller opportunities that fit this buyer's past purchases, best first. */
export async function matchesForBuyer(db: Db, ctx: RequestContext, workspaceId: string, buyerId: string, limit = MATCHES_SHOWN): Promise<SellerMatch[]> {
  await requireMembershipFor(db, ctx, workspaceId);
  if (!z.uuid().safeParse(buyerId).success) throw new ServiceError('not_found', 'That buyer does not exist.');
  const [buyer] = await db<{ evidence: { profile: BuyerProfile; rollFileDate: string } }[]>`
    SELECT evidence FROM opportunities WHERE workspace_id = ${workspaceId} AND id = ${buyerId} AND type = 'investor_buyer'
  `;
  if (!buyer) throw new ServiceError('not_found', 'That buyer does not exist.');
  const zips = buyer.evidence.profile.zips.map((z) => z.zip);
  const sellers = await db<{ id: string; payload: StoredParcel }[]>`
    SELECT o.id, r.payload FROM opportunities o JOIN source_records r ON r.id = o.source_record_id
    WHERE o.workspace_id = ${workspaceId} AND o.type = 'potential_seller' AND o.status <> 'dismissed'
      AND r.payload->'situs'->>'zip' = ANY(${zips}::text[])
  `;
  return sellers
    .flatMap((s) => {
      const m = matchBuyerToHome(homeOf(s.payload), buyer.evidence.profile, buyer.evidence.rollFileDate);
      return m
        ? [{ sellerId: s.id, address: s.payload.situs.address, zip: s.payload.situs.zip, homeType: DOR_USE_LABELS[s.payload.useCode] ?? 'Residential', score: m.score, reasons: m.reasons }]
        : [];
    })
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
    .slice(0, limit);
}
