import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmFailurePath, googleRedirectTo, googleSignInEnabled, parseEmailCode } from '../lib/sign-in.ts';

describe('sign-in helpers', () => {
  it('shows Google only when the flag is on', () => {
    assert.equal(googleSignInEnabled({ GENCUT_GOOGLE_SIGNIN: 'on' }), true);
    assert.equal(googleSignInEnabled({ GENCUT_GOOGLE_SIGNIN: ' ON ' }), true);
    assert.equal(googleSignInEnabled({ GENCUT_GOOGLE_SIGNIN: 'true' }), false, 'only "on"');
    assert.equal(googleSignInEnabled({}), false);
  });

  it('returns Google to /auth/confirm, marked, with a same-site next path only', () => {
    assert.equal(googleRedirectTo('https://gencutv1.netlify.app', '/buyers'), 'https://gencutv1.netlify.app/auth/confirm?via=google&next=%2Fbuyers');
    assert.equal(googleRedirectTo('https://x.test', 'https://evil.test/'), 'https://x.test/auth/confirm?via=google&next=%2Fhome');
    assert.equal(googleRedirectTo('https://x.test', null), 'https://x.test/auth/confirm?via=google&next=%2Fhome');
  });

  it('sends a failed Google sign-in to its own message', () => {
    assert.equal(confirmFailurePath('google'), '/sign-in?error=google');
    assert.equal(confirmFailurePath(null), '/sign-in?error=link');
  });

  it('reads the emailed code', () => {
    assert.equal(parseEmailCode(' 123 456 '), '123456');
    assert.equal(parseEmailCode('123-456'), '123456');
    assert.equal(parseEmailCode('12345678'), '12345678');
    assert.equal(parseEmailCode('12345'), null);
    assert.equal(parseEmailCode('12a456'), null);
  });
});
