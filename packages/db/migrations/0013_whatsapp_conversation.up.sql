-- 0013_whatsapp_conversation: what a WhatsApp conversation is about (D-018).
-- pending: the yes/no question GenCut last asked (e.g. "draft a letter for X?").
-- focus: the item or letter being discussed, so "details", "shorter" or "they replied" need no number.
-- suggested: items already offered by "next", so the same one is not offered twice.
ALTER TABLE whatsapp_sessions ADD COLUMN pending jsonb;
ALTER TABLE whatsapp_sessions ADD COLUMN focus jsonb;
ALTER TABLE whatsapp_sessions ADD COLUMN suggested jsonb NOT NULL DEFAULT '[]';
