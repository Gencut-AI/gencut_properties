-- audit_events is append-only, so its Instagram rows stay; the old CHECK is restored NOT VALID.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'workspace', 'membership', 'business_profile', 'campaign', 'outreach_action', 'opportunity', 'permission',
  'consent', 'suppression', 'whatsapp_link', 'inbound_lead')) NOT VALID;
DROP TABLE IF EXISTS instagram_comments;
DROP TABLE IF EXISTS instagram_accounts;
