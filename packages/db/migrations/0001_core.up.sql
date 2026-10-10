-- 0001_core: workspaces, people, business profile, permissions, campaigns,
-- outreach actions, consent, suppression and the append-only audit log.
--
-- State lists mirror packages/core; packages/db/test/parity.test.ts fails if
-- they drift. All ids are UUIDs (gen_random_uuid is built into Postgres 13+).

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Mirrors the auth provider's user id (Supabase auth.users.id) once auth lands.
CREATE TABLE users (
  id          uuid PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE business_profiles (
  workspace_id     uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  licensee_name    text NOT NULL,
  -- Licensed brokerage name as registered with Florida DBPR; required on every ad.
  brokerage_name   text NOT NULL CHECK (length(trim(brokerage_name)) > 0),
  license_number   text,
  office_address   text,
  market           text NOT NULL,
  specialty        text,
  focus            jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand            jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Three separate grants; contact is per channel. A row is a grant; revoking
-- sets revoked_at, so history is kept.
CREATE TABLE workspace_permissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('discover', 'generate', 'contact')),
  channel       text CHECK (channel IN ('email', 'mail', 'call', 'sms', 'whatsapp')),
  granted_by    uuid REFERENCES users(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  CHECK ((kind = 'contact') = (channel IS NOT NULL))
);
CREATE UNIQUE INDEX workspace_permissions_active
  ON workspace_permissions (workspace_id, kind, coalesce(channel, ''))
  WHERE revoked_at IS NULL;

CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id  uuid,  -- FK added in 0002 when opportunities exist
  title           text NOT NULL,
  objective       text NOT NULL,
  status          text NOT NULL DEFAULT 'generating' CHECK (status IN (
                    'generating', 'generation_failed', 'review', 'approved',
                    'active', 'completed', 'archived')),
  brief           jsonb,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_workspace ON campaigns (workspace_id, status);

CREATE TABLE outreach_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email', 'mail', 'call', 'sms', 'whatsapp')),
  state           text NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
                    'DRAFT', 'READY', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED')),
  subject_key     text NOT NULL,
  content         jsonb NOT NULL,
  scheduled_for   timestamptz,
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  executed_at     timestamptz,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- An approved or executed action always records who approved it.
  CHECK (state NOT IN ('APPROVED', 'EXECUTING', 'COMPLETED') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX outreach_actions_campaign ON outreach_actions (campaign_id, state);

-- Database-level guard: only legal state transitions, mirroring
-- packages/core/src/outreach/action-state.ts. Actor rules are enforced in the
-- service layer; this stops any code path from skipping states.
CREATE FUNCTION outreach_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'outreach action must be created as DRAFT, got %', NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'DRAFT'     AND NEW.state = 'READY')
    OR (OLD.state = 'READY'     AND NEW.state IN ('DRAFT', 'APPROVED'))
    OR (OLD.state = 'APPROVED'  AND NEW.state IN ('DRAFT', 'EXECUTING', 'FAILED'))
    OR (OLD.state = 'EXECUTING' AND NEW.state IN ('COMPLETED', 'FAILED'))
    OR (OLD.state = 'FAILED'    AND NEW.state = 'DRAFT')
  ) THEN
    RAISE EXCEPTION 'illegal outreach transition % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  -- Content is frozen once approved; editing requires returning to DRAFT
  -- (which may happen in the same statement as the edit).
  IF OLD.state IN ('APPROVED', 'EXECUTING', 'COMPLETED')
     AND NEW.state <> 'DRAFT'
     AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'content of an % action cannot change', OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  -- Leaving approval clears it, so a later approval is always fresh.
  IF NEW.state IN ('DRAFT', 'READY') THEN
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER outreach_actions_guard
  BEFORE INSERT OR UPDATE ON outreach_actions
  FOR EACH ROW EXECUTE FUNCTION outreach_action_guard();

CREATE TABLE consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel            text NOT NULL CHECK (channel IN ('email', 'mail', 'call', 'sms', 'whatsapp')),
  address            text NOT NULL,
  scopes             text[] NOT NULL CHECK (
                       scopes <@ ARRAY['email_marketing', 'marketing_texts',
                                       'automated_marketing_calls', 'whatsapp_marketing']::text[]
                       AND cardinality(scopes) > 0),
  written_signature  boolean NOT NULL,
  disclosure_shown   boolean NOT NULL,
  disclosure_text    text,
  evidence           jsonb NOT NULL DEFAULT '{}'::jsonb,
  obtained_at        timestamptz NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_lookup ON consents (workspace_id, channel, lower(address));

-- Opt-outs. channel NULL suppresses the address on every channel.
CREATE TABLE suppressions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel       text CHECK (channel IN ('email', 'mail', 'call', 'sms', 'whatsapp')),
  address       text NOT NULL,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppressions_unique
  ON suppressions (workspace_id, coalesce(channel, '*'), lower(address));

-- Append-only audit log.
CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'system', 'agent', 'executor')),
  actor_id      text,
  via           text NOT NULL CHECK (via IN ('web', 'whatsapp', 'worker', 'api')),
  entity_type   text NOT NULL CHECK (entity_type IN (
                  'campaign', 'outreach_action', 'opportunity', 'permission', 'consent', 'suppression')),
  entity_id     text NOT NULL,
  action        text NOT NULL,
  from_state    text,
  to_state      text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, occurred_at);

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
