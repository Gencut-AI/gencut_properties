-- 0016_company_registry: Florida company register records (Sunbiz) for the
-- companies that bought homes, so an agent sees who is behind a buyer (D-028).
--
-- Only companies whose name matches an owner on the stored roll purchases are
-- kept. Officers are stored as name, title and person/company only: their
-- addresses, the registered agent's address and the tax number are not read.

CREATE TABLE company_records (
  state               text NOT NULL CHECK (state = 'FL'),
  document_number     text NOT NULL,
  name                text NOT NULL,
  name_key            text NOT NULL,
  status              text NOT NULL CHECK (status IN ('active', 'inactive')),
  filing_type         text NOT NULL,
  principal           jsonb NOT NULL,
  mailing             jsonb NOT NULL,
  filed_on            date,
  last_transaction_on date,
  report_years        smallint[] NOT NULL DEFAULT '{}',
  registered_agent    jsonb,
  officers            jsonb NOT NULL DEFAULT '[]',
  more_officers       boolean NOT NULL DEFAULT false,
  source_file         text NOT NULL,
  file_date           date NOT NULL,
  imported_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state, document_number)
);
CREATE INDEX company_records_name ON company_records (state, name_key text_pattern_ops);
ALTER TABLE company_records ENABLE ROW LEVEL SECURITY;

-- One import per register file.
CREATE TABLE company_imports (
  state        text NOT NULL CHECK (state = 'FL'),
  source_file  text NOT NULL,
  file_date    date NOT NULL,
  status       text NOT NULL CHECK (status IN ('importing', 'ready', 'failed')),
  rows_read    bigint NOT NULL DEFAULT 0,
  rows_kept    integer NOT NULL DEFAULT 0,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  PRIMARY KEY (state, source_file)
);
ALTER TABLE company_imports ENABLE ROW LEVEL SECURITY;
