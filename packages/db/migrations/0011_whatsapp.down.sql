-- audit_events is append-only, so its WhatsApp rows stay; the old CHECK is restored NOT VALID.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'workspace', 'membership', 'business_profile', 'campaign', 'outreach_action',
  'opportunity', 'permission', 'consent', 'suppression')) NOT VALID;
DROP TABLE IF EXISTS whatsapp_sessions;
DROP TABLE IF EXISTS whatsapp_messages;
DROP TABLE IF EXISTS whatsapp_link_codes;
DROP TABLE IF EXISTS whatsapp_links;
