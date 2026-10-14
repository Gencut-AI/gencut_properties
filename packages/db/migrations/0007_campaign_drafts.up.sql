-- 0007_campaign_drafts: generated campaign drafts, a cost-and-usage log for
-- every model call, and outcomes recorded against opportunities.

ALTER TABLE campaigns ADD COLUMN draft jsonb;            -- the checked draft (CampaignDraft in core)
ALTER TABLE campaigns ADD COLUMN facts jsonb;            -- the facts the model was given (CampaignFact[])
ALTER TABLE campaigns ADD COLUMN problems jsonb;         -- check failures of the last attempt
ALTER TABLE campaigns ADD COLUMN prompt_version text;
ALTER TABLE campaigns ADD COLUMN generation_attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN generation_started_at timestamptz;
ALTER TABLE campaigns ADD COLUMN error text;
-- At most one draft being written per opportunity at a time.
CREATE UNIQUE INDEX campaigns_one_generating ON campaigns (opportunity_id) WHERE status = 'generating';
CREATE INDEX campaigns_workspace_recent ON campaigns (workspace_id, created_at DESC);

CREATE TABLE model_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id        uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  purpose            text NOT NULL,                 -- e.g. 'campaign_draft'
  role               text NOT NULL CHECK (role IN ('reasoning', 'creative', 'fast')),
  provider           text NOT NULL,
  model              text NOT NULL,
  prompt_version     text NOT NULL,
  status             text NOT NULL CHECK (status IN ('ok', 'error')),
  input_tokens       integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cost_usd           numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  latency_ms         integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  fact_keys          jsonb NOT NULL DEFAULT '[]',   -- which facts the call was given
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_runs_workspace ON model_runs (workspace_id, created_at DESC);

CREATE TABLE opportunity_outcomes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id   uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  outcome          text NOT NULL CHECK (outcome IN (
                     'contacted', 'no_response', 'responded', 'not_interested',
                     'appointment', 'listing', 'wrong_address')),
  -- The score and rule that ranked the opportunity when the outcome happened, for calibration.
  score            smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  scoring_version  text NOT NULL,
  occurred_on      date NOT NULL,
  note             text CHECK (char_length(note) <= 500),
  recorded_by      uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_outcomes_opportunity ON opportunity_outcomes (opportunity_id, occurred_on DESC);
CREATE INDEX opportunity_outcomes_workspace ON opportunity_outcomes (workspace_id, scoring_version);

ALTER TABLE model_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_outcomes ENABLE ROW LEVEL SECURITY;
