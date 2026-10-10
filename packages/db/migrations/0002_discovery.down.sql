ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_opportunity_fk;
DROP TABLE IF EXISTS opportunities;
DROP TABLE IF EXISTS prospects;
DROP TABLE IF EXISTS source_records;
DROP TABLE IF EXISTS data_sources;
