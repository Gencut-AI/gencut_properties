import 'server-only';
import { GraphInstagramClient, type InstagramConfig, instagramConfigFromEnv } from '@gencut/services';

/** The Instagram pilot connection for this deploy (D-024), or null. */
export function instagramConfig(): InstagramConfig | null {
  return instagramConfigFromEnv();
}

export function instagramClient(config: InstagramConfig): GraphInstagramClient {
  return new GraphInstagramClient(config.accessToken);
}
