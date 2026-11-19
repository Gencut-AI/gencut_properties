-- The agent's phone number for owners and companies to call or text back (D-035).
-- Letters and emails carried no way to reach the agent; the sign-in email is the other contact.
ALTER TABLE business_profiles ADD COLUMN phone text CHECK (phone ~ '^\+?[0-9(][0-9 ().-]{6,22}$');
