-- 0014_lead_pages: an agent's public lead page, shared on social media, and
-- the leads it collects (D-023). People who submit the form asked to be
-- contacted; each lead links to the consent record shown when they agreed.

CREATE TABLE lead_pages (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_pages ENABLE ROW LEVEL SECURITY;

CREATE TABLE inbound_leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  email           text NOT NULL CHECK (length(email) <= 254),
  phone           text CHECK (phone ~ '^\d{11,15}$'),
  interest        text NOT NULL CHECK (interest IN ('selling', 'buying', 'investing', 'home_value')),
  zip             text CHECK (zip ~ '^\d{5}$'),
  message         text CHECK (length(message) <= 1000),
  source          text NOT NULL CHECK (source IN ('instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube', 'whatsapp', 'link')),
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'dismissed')),
  consent_id      uuid NOT NULL REFERENCES consents(id),
  -- A one-way hash of the submitter's network address and the day, for rate limits only.
  submitter_hash  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_leads_workspace ON inbound_leads (workspace_id, created_at DESC);
CREATE INDEX inbound_leads_submitter ON inbound_leads (submitter_hash, created_at);
ALTER TABLE inbound_leads ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'workspace', 'membership', 'business_profile', 'campaign', 'outreach_action',
  'opportunity', 'permission', 'consent', 'suppression', 'whatsapp_link', 'inbound_lead'));
