/**
 * Only same-site relative paths may be used as post-login destinations,
 * so a crafted link cannot bounce a signed-in user to another site.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/home'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  try {
    const u = new URL(next, 'https://gencut.invalid');
    if (u.origin !== 'https://gencut.invalid') return fallback;
    return `${u.pathname}${u.search}`;
  } catch {
    return fallback;
  }
}
