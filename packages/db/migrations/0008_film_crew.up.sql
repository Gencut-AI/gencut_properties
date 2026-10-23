-- 0008_film_crew: the Film Crew's first media for a campaign (a social post and
-- a generated neighborhood picture) and the agent's uploaded headshot.
--
-- Images are stored in Postgres (bytea) for now: no new storage service or
-- secret, and the same tenant checks as every other row. The services reach
-- them only through media functions, so moving to object storage later changes
-- one module. Sizes are capped so the table stays small.

ALTER TABLE campaigns ADD COLUMN media_status text NOT NULL DEFAULT 'none'
  CHECK (media_status IN ('none', 'generating', 'ready', 'failed'));
ALTER TABLE campaigns ADD COLUMN media_started_at timestamptz;
ALTER TABLE campaigns ADD COLUMN media_error text;
ALTER TABLE campaigns ADD COLUMN social_post jsonb;          -- the checked SocialPost (core)
ALTER TABLE campaigns ADD COLUMN media_problems jsonb;       -- check failures of the last attempt

CREATE TABLE media_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id   uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('headshot', 'neighborhood_image')),
  source        text NOT NULL CHECK (source IN ('upload', 'generated')),
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes         bytea NOT NULL,
  byte_size     integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  -- Generated scenes are never presented as the real place; the label is not optional.
  illustrative  boolean NOT NULL DEFAULT false,
  provider      text,
  model         text,
  prompt        text,
  created_by    uuid REFERENCES users(id),
  replaced_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'generated') = (provider IS NOT NULL AND model IS NOT NULL)),
  CHECK (kind <> 'neighborhood_image' OR (source = 'generated' AND illustrative AND campaign_id IS NOT NULL)),
  CHECK (kind <> 'headshot' OR (source = 'upload' AND campaign_id IS NULL)),
  CHECK (byte_size = octet_length(bytes))
);
-- One current headshot per workspace; replaced ones are kept until cleaned up.
CREATE UNIQUE INDEX media_assets_one_headshot ON media_assets (workspace_id) WHERE kind = 'headshot' AND replaced_at IS NULL;
CREATE INDEX media_assets_campaign ON media_assets (campaign_id, created_at DESC) WHERE campaign_id IS NOT NULL;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;

-- Image generation is logged with the other model calls.
ALTER TABLE model_runs DROP CONSTRAINT model_runs_role_check;
ALTER TABLE model_runs ADD CONSTRAINT model_runs_role_check CHECK (role IN ('reasoning', 'creative', 'fast', 'image'));
