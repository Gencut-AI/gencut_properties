/**
 * Pure helpers for sign-in (D-036): the Google flag, where a failed sign-in
 * returns to, and the one-time code typed from the email.
 */
import { safeNextPath } from './safe-redirect.ts';

/** "Continue with Google" shows only when this is on, after the Supabase Google provider is enabled. */
export function googleSignInEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.GENCUT_GOOGLE_SIGNIN?.trim().toLowerCase() === 'on';
}

/** Where Google returns: /auth/confirm, marked so a failure gets Google's own message. */
export function googleRedirectTo(origin: string, next: string | null | undefined): string {
  const params = new URLSearchParams({ via: 'google', next: safeNextPath(next) });
  return `${origin}/auth/confirm?${params.toString()}`;
}

/** The sign-in page a failed confirmation returns to. */
export function confirmFailurePath(via: string | null): string {
  return via === 'google' ? '/sign-in?error=google' : '/sign-in?error=link';
}

/** The code from the email: 6 to 10 digits, spaces and dashes ignored; null when it cannot be one. */
export function parseEmailCode(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  return /^\d{6,10}$/.test(digits) ? digits : null;
}
