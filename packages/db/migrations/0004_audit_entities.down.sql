ALTER FUNCTION audit_events_append_only() RESET search_path;
ALTER FUNCTION outreach_action_guard() RESET search_path;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'campaign', 'outreach_action', 'opportunity', 'permission', 'consent', 'suppression'));
