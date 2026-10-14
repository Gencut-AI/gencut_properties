-- 0006_import_version: record which version of the importer produced each
-- ZIP's records, so an importer that reads more (the previous year's roll,
-- both sale slots, institutional exemptions) re-imports existing ZIPs.
ALTER TABLE zip_coverage ADD COLUMN import_version integer NOT NULL DEFAULT 1 CHECK (import_version >= 1);
