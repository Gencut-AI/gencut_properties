import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redirectTo } from '../lib/redirect.ts';

describe('redirectTo', () => {
  it('uses a relative Location so the browser stays on its current host', () => {
    const r = redirectTo('/home');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/home');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  it('keeps query strings and refuses off-site targets', () => {
    assert.equal(redirectTo('/sign-in?error=link').headers.get('location'), '/sign-in?error=link');
    assert.equal(redirectTo('https://evil.example/x').headers.get('location'), '/');
    assert.equal(redirectTo('//evil.example').headers.get('location'), '/');
  });
});
