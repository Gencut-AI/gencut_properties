import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkSubject,
  composeOutreachEmail,
  defaultSubject,
  fromDisplayName,
  isTestInbox,
  normalizeEmail,
  parseEmailSendingMode,
  parseTestInboxes,
  sendingAllows,
} from '../src/index.ts';

// Synthetic agent and letter.
const sender = { name: 'Ana Test', brokerage: 'Example Bay Realty LLC', licenseNumber: 'SL3456789', postalAddress: '100 Example Blvd, Miami, FL 33131' };
const letter = {
  greeting: 'Dear Owner,',
  paragraphs: ['I work with owners of single-family homes nearby.', 'If you would like to talk, I am glad to help <with no obligation>.'],
  closing: 'Warm regards,',
  signature: ['Ana Test', 'Example Bay Realty LLC'],
};

describe('outreach email', () => {
  it('normalizes addresses and rejects implausible ones', () => {
    assert.equal(normalizeEmail('  Ana.Test+Demo@Example.COM '), 'ana.test+demo@example.com');
    for (const bad of ['', 'ana', 'ana@', '@example.com', 'ana@example', 'a b@example.com', 'ana@exa_mple.com', '<ana@example.com>']) {
      assert.equal(normalizeEmail(bad), null, bad);
    }
  });

  it('sends nowhere when off, only to test inboxes in test mode, and anywhere valid when live', () => {
    const inboxes = parseTestInboxes(' paul@example.com, @team.example.org ;bogus ');
    assert.deepEqual(inboxes, ['paul@example.com', '@team.example.org']);
    assert.ok(isTestInbox('PAUL@example.com', inboxes));
    assert.ok(isTestInbox('anyone@team.example.org', inboxes));
    assert.ok(!isTestInbox('anyone@notteam.example.org.evil.com', inboxes));
    assert.ok(!isTestInbox('owner@example.net', inboxes));

    assert.equal(parseEmailSendingMode(undefined), 'off');
    assert.equal(parseEmailSendingMode('TEST_ONLY'), 'test_only');
    assert.equal(parseEmailSendingMode('yes'), 'off', 'anything unknown is off');
    assert.ok(!sendingAllows('off', inboxes, 'paul@example.com'));
    assert.ok(sendingAllows('test_only', inboxes, 'paul@example.com'));
    assert.ok(!sendingAllows('test_only', inboxes, 'owner@example.net'));
    assert.ok(sendingAllows('live', [], 'owner@example.net'));
    assert.ok(!sendingAllows('live', [], 'not-an-address'));
  });

  it('checks subjects for deception, pressure and shape', () => {
    assert.deepEqual(checkSubject(defaultSubject(sender)), []);
    assert.equal(defaultSubject(sender), 'A note from Ana Test, Example Bay Realty LLC');
    assert.ok(checkSubject('Re: your home').some((p) => /Re:/.test(p)));
    assert.ok(checkSubject('FWD: hello').length > 0);
    assert.ok(checkSubject('Act now on your home').length > 0);
    assert.ok(checkSubject('a\nb c d').length > 0);
    assert.ok(checkSubject('x'.repeat(121)).length > 0);
    assert.ok(checkSubject(' ').length > 0);
  });

  it('builds a message with the advertisement notice, postal address, license and unsubscribe link, and escapes HTML', () => {
    const url = 'https://gencut.example/u/abc.def';
    const m = composeOutreachEmail({ letter, subject: '  A note from Ana  ', sender, unsubscribeUrl: url });
    assert.equal(m.subject, 'A note from Ana');
    assert.equal(m.fromName, 'Ana Test (Example Bay Realty LLC)');
    for (const part of ['Dear Owner,', 'This email is an advertisement from Ana Test, Example Bay Realty LLC · License SL3456789.', sender.postalAddress, `Unsubscribe: ${url}`]) {
      assert.ok(m.text.includes(part), part);
    }
    assert.ok(m.html.includes('&lt;with no obligation&gt;'), 'letter text is escaped');
    assert.ok(!m.html.includes('<with no obligation>'));
    assert.ok(m.html.includes(`href="${url}"`));
    assert.ok(m.html.includes(sender.postalAddress));
    const noLicense = composeOutreachEmail({ letter, subject: 's s s', sender: { ...sender, licenseNumber: null }, unsubscribeUrl: url });
    assert.ok(noLicense.text.includes('advertisement from Ana Test, Example Bay Realty LLC.'));
  });

  it('keeps From display names free of header-breaking characters', () => {
    assert.equal(fromDisplayName({ name: 'Ana "The Agent" <x>', brokerage: 'Bay\r\nRealty' }), 'Ana The Agent x (Bay Realty)');
  });
});
