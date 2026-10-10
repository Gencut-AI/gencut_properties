import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANNELS, defaultPermissions, isPermitted, withContact } from '../src/index.ts';

describe('three-permission model', () => {
  it('new workspaces can discover and generate but contact nobody', () => {
    const p = defaultPermissions();
    assert.equal(isPermitted(p, { kind: 'discover' }), true);
    assert.equal(isPermitted(p, { kind: 'generate' }), true);
    for (const channel of CHANNELS) {
      assert.equal(isPermitted(p, { kind: 'contact', channel }), false, channel);
    }
  });

  it('grants contact one channel at a time', () => {
    const p = withContact(defaultPermissions(), 'email', true);
    assert.equal(isPermitted(p, { kind: 'contact', channel: 'email' }), true);
    assert.equal(isPermitted(p, { kind: 'contact', channel: 'sms' }), false);
    const revoked = withContact(p, 'email', false);
    assert.equal(isPermitted(revoked, { kind: 'contact', channel: 'email' }), false);
  });

  it('does not mutate the original', () => {
    const p = defaultPermissions();
    withContact(p, 'mail', true);
    assert.equal(p.contact.mail, false);
  });
});
