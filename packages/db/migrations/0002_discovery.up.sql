-- 0002_discovery: where facts come from, the people behind them, and the
-- opportunities GenCut scores. Every opportunity points at the source record
-- it was derived from, so every fact shown to a user has provenance.

CREATE TABLE data_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,         -- e.g. 'fl-dor-nal'
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('public_record', 'user_provided', 'licensed_api', 'mls')),
  terms_url   text,
  notes       text,                         -- documented restrictions and costs
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES data_sources(id),
  -- NULL for shared public records; set for a workspace's own uploads.
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id   text NOT NULL,              -- e.g. parcel id
  file_date     date NOT NULL,              -- date of the source file or response
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL
);
CREATE UNIQUE INDEX source_records_unique
  ON source_records (source_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
                     external_id, file_date);

CREATE TABLE prospects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name     text NOT NULL,
  mailing_address  text,
  email            text,
  phone            text,
  time_zone        text,
  -- Why the agent may contact this person at all; mirrors CONTACT_BASES in core.
  contact_basis    text NOT NULL DEFAULT 'none' CHECK (contact_basis IN (
                     'none', 'prior_relationship', 'express_request', 'responded_to_ad')),
  source_record_id uuid REFERENCES source_records(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prospects_workspace ON prospects (workspace_id);

CREATE TABLE opportunities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_record_id  uuid NOT NULL REFERENCES source_records(id),
  prospect_id       uuid REFERENCES prospects(id) ON DELETE SET NULL,
  type              text NOT NULL CHECK (type IN ('potential_seller', 'responded_to_ad', 'sphere')),
  score             smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence        numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reasons           jsonb NOT NULL,
  scoring_version   text NOT NULL,
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'saved', 'dismissed', 'in_campaign')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_record_id, type)
);
CREATE INDEX opportunities_feed ON opportunities (workspace_id, status, score DESC);

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_opportunity_fk
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL;
