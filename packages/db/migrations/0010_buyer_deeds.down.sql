-- 0010_buyer_deeds: the spaces removed from owner keys cannot be restored; the
-- next roll import writes keys in whatever form the running code produces.
UPDATE workspace_discovery SET buyer_status = 'pending' WHERE buyer_status <> 'scoring';
