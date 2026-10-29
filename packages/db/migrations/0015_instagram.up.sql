-- 0015_instagram: comments on the agent's Instagram posts that ask for the
-- lead-page link, and the one private reply the agent may send (D-024).

-- The connected Instagram professional account of a workspace, and its last check.
CREATE TABLE instagram_accounts (
  workspace_id    uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_user_id      text NOT NULL,
  username        text NOT NULL,
  last_synced_at  timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE instagram_accounts ENABLE ROW LEVEL SECURITY;

-- Only comments that contain a keyword are stored.
CREATE TABLE instagram_comments (
  comment_id    text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  media_id      text NOT NULL,
  permalink     text,
  from_id       text,
  username      text NOT NULL,
  text          text NOT NULL CHECK (length(text) <= 2200),
  keyword       text NOT NULL,
  commented_at  timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'dismissed')),
  reply_state   text NOT NULL DEFAULT 'none' CHECK (reply_state IN ('none', 'sent', 'failed')),
  reply_error   text,
  replied_at    timestamptz,
  replied_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (reply_state <> 'sent' OR (replied_at IS NOT NULL AND replied_by IS NOT NULL))
);
CREATE INDEX instagram_comments_workspace ON instagram_comments (workspace_id, commented_at DESC);
ALTER TABLE instagram_comments ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'workspace', 'membership', 'business_profile', 'campaign', 'outreach_action', 'opportunity', 'permission',
  'consent', 'suppression', 'whatsapp_link', 'inbound_lead', 'instagram_comment'));
