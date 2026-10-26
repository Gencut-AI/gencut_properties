DELETE FROM opportunity_outcomes WHERE outcome IN ('qualified_conversation', 'offer', 'closed');
ALTER TABLE opportunity_outcomes DROP CONSTRAINT opportunity_outcomes_outcome_check;
ALTER TABLE opportunity_outcomes ADD CONSTRAINT opportunity_outcomes_outcome_check CHECK (outcome IN (
  'contacted', 'no_response', 'responded', 'not_interested', 'appointment', 'listing', 'wrong_address'));
DELETE FROM opportunities WHERE type = 'investor_buyer';
ALTER TABLE opportunities DROP CONSTRAINT opportunities_cites_source;
ALTER TABLE opportunities DROP COLUMN IF EXISTS evidence;
ALTER TABLE opportunities ALTER COLUMN source_record_id SET NOT NULL;
ALTER TABLE opportunities DROP CONSTRAINT opportunities_type_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_type_check CHECK (type IN ('potential_seller', 'responded_to_ad', 'sphere'));
ALTER TABLE workspace_discovery DROP COLUMN IF EXISTS buyer_scored_at;
ALTER TABLE workspace_discovery DROP COLUMN IF EXISTS buyer_error;
ALTER TABLE workspace_discovery DROP COLUMN IF EXISTS buyer_count;
ALTER TABLE workspace_discovery DROP COLUMN IF EXISTS buyers_considered;
ALTER TABLE workspace_discovery DROP COLUMN IF EXISTS buyer_file_date;
ALTER TABLE workspace_discovery DROP COLUMN IF EXISTS buyer_status;
DROP TABLE IF EXISTS transaction_imports;
DROP TABLE IF EXISTS property_transactions;
