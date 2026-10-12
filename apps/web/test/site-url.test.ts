import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signInRedirectOrigin } from '../lib/site-url.ts';

describe('signInRedirectOrigin', () => {
  it('prefers the build-time site address over the request host', () => {
    assert.equal(
      signInRedirectOrigin('https://deploy-preview-4--gencutv1.netlify.app/', '6aca8e--gencutv1.netlify.app', 'https'),
      'https://deploy-preview-4--gencutv1.netlify.app',
    );
  });

  it('falls back to the request origin locally', () => {
    assert.equal(signInRedirectOrigin(undefined, 'localhost:3000', null), 'http://localhost:3000');
    assert.equal(signInRedirectOrigin('', 'example.test', 'https'), 'https://example.test');
  });

  it('returns null when nothing is known', () => {
    assert.equal(signInRedirectOrigin(undefined, null, null), null);
  });
});
