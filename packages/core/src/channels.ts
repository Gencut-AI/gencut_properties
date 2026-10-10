/**
 * Outreach channels GenCut can prepare actions for.
 *
 * "call" and "mail" are tasks the agent performs personally; GenCut prepares
 * and tracks them but never dials or posts anything itself.
 */
export const CHANNELS = ['email', 'mail', 'call', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

/**
 * Channels the platform supports executing in the current release.
 * SMS and WhatsApp-to-prospect stay unavailable until their provider
 * integrations, registration (A2P 10DLC, WhatsApp opt-in) and counsel review
 * are complete. See docs/decisions.md (D-007).
 */
export const MVP_AVAILABLE_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['email', 'mail', 'call']);
