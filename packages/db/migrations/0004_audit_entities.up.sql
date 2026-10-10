-- 0004_audit_entities: audit workspace, membership and business-profile changes,
-- and pin trigger functions' search_path (they reference no tables).
ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'workspace', 'membership', 'business_profile', 'campaign', 'outreach_action',
  'opportunity', 'permission', 'consent', 'suppression'));

ALTER FUNCTION outreach_action_guard() SET search_path = pg_catalog;
ALTER FUNCTION audit_events_append_only() SET search_path = pg_catalog;
