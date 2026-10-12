import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redirectHeaders } from '../lib/redirect-location.ts';

describe('redirectHeaders', () => {
  it('uses a relative Location so the browser stays on its current host', () => {
    assert.deepEqual(redirectHeaders('/home'), { location: '/home', 'cache-control': 'no-store' });
  });

  it('keeps query strings and refuses off-site targets', () => {
    assert.equal(redirectHeaders('/sign-in?error=link').location, '/sign-in?error=link');
    assert.equal(redirectHeaders('https://evil.example/x').location, '/');
    assert.equal(redirectHeaders('//evil.example').location, '/');
  });
});
