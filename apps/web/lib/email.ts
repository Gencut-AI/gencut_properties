import 'server-only';
import { type EmailConfig, emailConfigFromEnv } from '@gencut/services';

/**
 * Email settings for this deploy. GENCUT_SITE_URL is fixed at build time
 * (next.config.ts) and only reaches the server when read by its literal name,
 * so it is passed in explicitly.
 */
export function emailConfig(): EmailConfig | null {
  return emailConfigFromEnv({ ...process.env, GENCUT_SITE_URL: process.env.GENCUT_SITE_URL });
}
