/**
 * Start the discovery job (GitHub Actions, the only place that can reach the
 * Florida DOR portal) as soon as an agent saves a profile, instead of waiting
 * for the next scheduled run, which GitHub may delay by hours.
 *
 * Uses a fine-grained GitHub token with Actions read/write on this repository
 * only (GITHUB_DISPATCH_TOKEN). Without it, nothing happens and the scheduled
 * run picks the work up as before. The job's concurrency group keeps at most
 * one run going and one waiting, so repeated saves cost nothing extra.
 */
export type DispatchOutcome = 'started' | 'not_configured' | 'failed';

export const DEFAULT_DISPATCH_REPO = 'Gencut-AI/gencut_properties';

export async function requestDiscoveryRun(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<DispatchOutcome> {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token) return 'not_configured';
  const repo = env.GITHUB_DISPATCH_REPO?.trim() || DEFAULT_DISPATCH_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return 'failed';
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/actions/workflows/discovery.yml/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 204 ? 'started' : 'failed';
  } catch {
    return 'failed';
  }
}
