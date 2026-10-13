-- 0005_discovery_jobs: which ZIP codes have public-record coverage, each
-- workspace's discovery run, and one opportunity per parcel per workspace.
--
-- Parcel rolls are shared public records: imported once per county ZIP and
-- reused by every workspace that focuses on that ZIP.

ALTER TABLE source_records ADD COLUMN zip text CHECK (zip ~ '^[0-9]{5}$');
CREATE INDEX source_records_zip ON source_records (source_id, zip, file_date) WHERE workspace_id IS NULL;

CREATE TABLE zip_coverage (
  county_code   text NOT NULL,
  zip           text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'importing', 'ready', 'failed')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  source_file   text,          -- file name of the roll the ZIP was imported from
  roll_label    text,          -- e.g. '2026 preliminary roll'
  file_date     date,          -- matches source_records.file_date for this import
  parcel_count  integer CHECK (parcel_count >= 0),
  error         text,
  PRIMARY KEY (county_code, zip)
);

CREATE TABLE workspace_discovery (
  workspace_id      uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  scoring_version   text,
  parcels_considered integer CHECK (parcels_considered >= 0),
  parcels_qualified  integer CHECK (parcels_qualified >= 0),
  opportunity_count  integer CHECK (opportunity_count >= 0),
  error             text
);

-- One opportunity per subject (e.g. 'fl-dor-nal:23:<parcel id>') per type, so
-- a newer roll updates the opportunity instead of duplicating it.
ALTER TABLE opportunities ADD COLUMN subject_key text NOT NULL;
ALTER TABLE opportunities ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE opportunities ADD CONSTRAINT opportunities_subject UNIQUE (workspace_id, type, subject_key);

INSERT INTO data_sources (key, name, kind, terms_url, notes) VALUES (
  'fl-dor-nal',
  'Florida Department of Revenue — Name-Address-Legal (NAL) assessment roll',
  'public_record',
  'https://floridarevenue.com/property/dataportal/',
  'Public record under Fla. Stat. ch. 119, published by DOR Property Tax Oversight for all 67 counties; free. '
  'Preliminary roll each summer, final roll each autumn. Owner names and mailing addresses only; no phone numbers '
  'or emails. Confidential owner records (Fla. Stat. 119.071) appear with blank names and are not imported. '
  'Authorizes discovery only, never contact.'
) ON CONFLICT (key) DO NOTHING;

ALTER TABLE zip_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_discovery ENABLE ROW LEVEL SECURITY;
