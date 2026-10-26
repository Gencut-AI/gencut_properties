-- 0009_buyer_radar: verified company purchases from the public roll, and buyers
-- as a second kind of opportunity beside sellers.
--
-- Only purchases whose owner of record is a company are stored. Individuals'
-- and personal trusts' purchase histories are never collected.

CREATE TABLE property_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county_code         text NOT NULL,
  parcel_id           text NOT NULL,
  roll_year           smallint NOT NULL,
  source_file         text NOT NULL,               -- the roll file the sale was read from
  file_date           date NOT NULL,
  situs_address       text NOT NULL,
  situs_city          text NOT NULL DEFAULT '',
  situs_zip           text NOT NULL CHECK (situs_zip ~ '^\d{5}$'),
  use_code            text NOT NULL,
  units               integer,
  living_area         integer,
  year_built          smallint,
  owner_name          text NOT NULL,
  owner_key           text NOT NULL,
  owner_mailing       jsonb NOT NULL,
  sale_year           smallint NOT NULL,
  sale_month          smallint CHECK (sale_month BETWEEN 1 AND 12),
  price               bigint NOT NULL CHECK (price >= 10000),
  qualification_code  text NOT NULL CHECK (qualification_code ~ '^0[1-6]$'),
  imported_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX property_transactions_sale
  ON property_transactions (county_code, parcel_id, sale_year, coalesce(sale_month, 0), price);
CREATE INDEX property_transactions_owner ON property_transactions (county_code, owner_key);
ALTER TABLE property_transactions ENABLE ROW LEVEL SECURITY;

-- One import per county and roll file.
CREATE TABLE transaction_imports (
  county_code  text NOT NULL,
  source_file  text NOT NULL,
  file_date    date NOT NULL,
  status       text NOT NULL CHECK (status IN ('importing', 'ready', 'failed')),
  rows_read    integer NOT NULL DEFAULT 0,
  rows_kept    integer NOT NULL DEFAULT 0,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  PRIMARY KEY (county_code, source_file)
);
ALTER TABLE transaction_imports ENABLE ROW LEVEL SECURITY;

-- Buyers per workspace are scored like sellers, on their own schedule.
ALTER TABLE workspace_discovery ADD COLUMN buyer_status text NOT NULL DEFAULT 'pending'
  CHECK (buyer_status IN ('pending', 'scoring', 'ready', 'failed'));
ALTER TABLE workspace_discovery ADD COLUMN buyer_file_date date;
ALTER TABLE workspace_discovery ADD COLUMN buyers_considered integer;
ALTER TABLE workspace_discovery ADD COLUMN buyer_count integer;
ALTER TABLE workspace_discovery ADD COLUMN buyer_error text;
ALTER TABLE workspace_discovery ADD COLUMN buyer_scored_at timestamptz;

-- A buyer is an opportunity too: same statuses, campaigns and outcomes. It
-- cites its purchases in `evidence` instead of one source record.
ALTER TABLE opportunities DROP CONSTRAINT opportunities_type_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_type_check
  CHECK (type IN ('potential_seller', 'responded_to_ad', 'sphere', 'investor_buyer'));
ALTER TABLE opportunities ALTER COLUMN source_record_id DROP NOT NULL;
ALTER TABLE opportunities ADD COLUMN evidence jsonb;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_cites_source
  CHECK (CASE WHEN type = 'investor_buyer' THEN evidence IS NOT NULL ELSE source_record_id IS NOT NULL END);

ALTER TABLE opportunity_outcomes DROP CONSTRAINT opportunity_outcomes_outcome_check;
ALTER TABLE opportunity_outcomes ADD CONSTRAINT opportunity_outcomes_outcome_check CHECK (outcome IN (
  'contacted', 'no_response', 'responded', 'not_interested', 'qualified_conversation',
  'appointment', 'offer', 'listing', 'closed', 'wrong_address'));
