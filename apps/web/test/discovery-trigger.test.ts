import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requestDiscoveryRun } from '../lib/discovery-trigger.ts';

describe('starting the discovery job after a profile save', () => {
  it('does nothing without a token, and dispatches the workflow on main with one', async () => {
    assert.equal(await requestDiscoveryRun({}), 'not_configured');
    let seen: { url: string; auth: string; body: string } | null = null;
    const ok = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: (init?.headers as Record<string, string>).authorization ?? '', body: String(init?.body) };
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    assert.equal(await requestDiscoveryRun({ GITHUB_DISPATCH_TOKEN: 'tok' }, ok), 'started');
    assert.equal(seen!.url, 'https://api.github.com/repos/Gencut-AI/gencut_properties/actions/workflows/discovery.yml/dispatches');
    assert.equal(seen!.auth, 'Bearer tok');
    assert.deepEqual(JSON.parse(seen!.body), { ref: 'main' });
  });

  it('reports failure instead of throwing, so a save never fails because of it', async () => {
    const denied = (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof fetch;
    assert.equal(await requestDiscoveryRun({ GITHUB_DISPATCH_TOKEN: 'tok' }, denied), 'failed');
    const offline = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    assert.equal(await requestDiscoveryRun({ GITHUB_DISPATCH_TOKEN: 'tok' }, offline), 'failed');
    assert.equal(await requestDiscoveryRun({ GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_DISPATCH_REPO: 'bad repo; rm' }), 'failed');
  });
});
