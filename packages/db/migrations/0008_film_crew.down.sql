DELETE FROM model_runs WHERE role = 'image';
ALTER TABLE model_runs DROP CONSTRAINT model_runs_role_check;
ALTER TABLE model_runs ADD CONSTRAINT model_runs_role_check CHECK (role IN ('reasoning', 'creative', 'fast'));
DROP TABLE IF EXISTS media_assets;
ALTER TABLE campaigns DROP COLUMN IF EXISTS media_problems;
ALTER TABLE campaigns DROP COLUMN IF EXISTS social_post;
ALTER TABLE campaigns DROP COLUMN IF EXISTS media_error;
ALTER TABLE campaigns DROP COLUMN IF EXISTS media_started_at;
ALTER TABLE campaigns DROP COLUMN IF EXISTS media_status;
