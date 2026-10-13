DELETE FROM data_sources WHERE key = 'fl-dor-nal'
  AND NOT EXISTS (SELECT 1 FROM source_records r WHERE r.source_id = data_sources.id);
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_subject;
ALTER TABLE opportunities DROP COLUMN IF EXISTS updated_at;
ALTER TABLE opportunities DROP COLUMN IF EXISTS subject_key;
DROP TABLE IF EXISTS workspace_discovery;
DROP TABLE IF EXISTS zip_coverage;
DROP INDEX IF EXISTS source_records_zip;
ALTER TABLE source_records DROP COLUMN IF EXISTS zip;
