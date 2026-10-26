-- 0010_buyer_deeds: Buyer Radar buyer-v2. Owner keys lose their spaces, because
-- the roll spaces the same name differently ("D R HORTON INC" / "DR HORTON INC"),
-- and every workspace's buyers are scored again (a multi-parcel deed now counts
-- as one purchase; see D-016). ownerKey() in core produces the same keys.
UPDATE property_transactions SET owner_key = replace(owner_key, ' ', '') WHERE owner_key LIKE '% %';

-- Buyers nobody has acted on are rebuilt by the next scoring run under the new keys.
DELETE FROM opportunities o
WHERE o.type = 'investor_buyer' AND o.status = 'new'
  AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.opportunity_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM opportunity_outcomes x WHERE x.opportunity_id = o.id);

-- Buyers someone saved, dismissed, campaigned or recorded an outcome on keep
-- their row: their key is rewritten, one row per new key.
UPDATE opportunities o SET subject_key = replace(o.subject_key, ' ', '')
WHERE o.id IN (
    SELECT DISTINCT ON (workspace_id, replace(subject_key, ' ', '')) id FROM opportunities
    WHERE type = 'investor_buyer' AND subject_key LIKE '% %'
    ORDER BY workspace_id, replace(subject_key, ' ', ''), updated_at DESC)
  AND NOT EXISTS (
    SELECT 1 FROM opportunities p
    WHERE p.workspace_id = o.workspace_id AND p.type = o.type AND p.subject_key = replace(o.subject_key, ' ', ''));

UPDATE workspace_discovery SET buyer_status = 'pending' WHERE buyer_status <> 'scoring';
