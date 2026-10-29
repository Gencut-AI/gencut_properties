-- audit_events is append-only, so its inbound-lead rows stay; the old CHECK is restored NOT VALID.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (entity_type IN (
  'workspace', 'membership', 'business_profile', 'campaign', 'outreach_action',
  'opportunity', 'permission', 'consent', 'suppression', 'whatsapp_link')) NOT VALID;
DROP TABLE IF EXISTS inbound_leads;
DROP TABLE IF EXISTS lead_pages;
