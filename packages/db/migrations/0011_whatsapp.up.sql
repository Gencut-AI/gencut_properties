-- 0011_whatsapp: the WhatsApp assistant for agents (D-017). Agent-facing only:
-- prospects are never messaged on WhatsApp (D-007).

-- A WhatsApp number linked to a GenCut user by a one-time code the signed-in
-- user created in the app. One active link per number and per user.
CREATE TABLE whatsapp_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wa_id       text NOT NULL CHECK (wa_id ~ '^\d{8,15}$'),
  linked_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX whatsapp_links_active_number ON whatsapp_links (wa_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX whatsapp_links_active_user ON whatsapp_links (user_id) WHERE revoked_at IS NULL;
ALTER TABLE whatsapp_links ENABLE ROW LEVEL SECURITY;

-- Link codes are stored hashed, expire after 15 minutes and work once.
CREATE TABLE whatsapp_link_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_link_codes_open ON whatsapp_link_codes (code_hash) WHERE used_at IS NULL;
ALTER TABLE whatsapp_link_codes ENABLE ROW LEVEL SECURITY;

-- Messages in and out. Inbound rows are the work queue: the webhook stores
-- them (once, by WhatsApp message id) and a background job claims and answers them.
CREATE TABLE whatsapp_messages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wamid                  text UNIQUE,
  direction              text NOT NULL CHECK (direction IN ('in', 'out')),
  wa_id                  text NOT NULL,
  user_id                uuid REFERENCES users(id) ON DELETE SET NULL,
  kind                   text NOT NULL CHECK (kind IN ('text', 'button', 'other')),
  body                   text NOT NULL DEFAULT '',
  status                 text NOT NULL CHECK (status IN ('received', 'processing', 'done', 'failed', 'sent')),
  error                  text,
  sent_at                timestamptz,
  processing_started_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((direction = 'in' AND status IN ('received', 'processing', 'done', 'failed'))
      OR (direction = 'out' AND status IN ('sent', 'failed')))
);
CREATE INDEX whatsapp_messages_queue ON whatsapp_messages (created_at) WHERE direction = 'in' AND status IN ('received', 'processing');
CREATE INDEX whatsapp_messages_number ON whatsapp_messages (wa_id, created_at DESC);
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Per number: the last numbered list shown ("2" means its item 2), when the
-- number last wrote (WhatsApp's 24-hour reply window), and failed link attempts.
CREATE TABLE whatsapp_sessions (
  wa_id                text PRIMARY KEY,
  listed               jsonb NOT NULL DEFAULT '[]',
  last_inbound_at      timestamptz,
  failed_links         integer NOT NULL DEFAULT 0,
  failed_links_since   timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

-- Linking and unlinking a number are audited.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'workspace', 'membership', 'business_profile', 'campaign', 'outreach_action',
  'opportunity', 'permission', 'consent', 'suppression', 'whatsapp_link'));
