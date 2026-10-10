import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Channel,
  type ConsentRecord,
  type GateCheckCode,
  type GateInput,
  CHANNELS,
  GATE_POLICY_VERSION,
  MVP_AVAILABLE_CHANNELS,
  defaultPermissions,
  evaluateGate,
  localHour,
  withContact,
} from '../src/index.ts';

// 11:00 in Miami (EDT, UTC-4).
const NOW = new Date('2026-10-14T15:00:00Z');
const BROKERAGE = 'Biscayne Bay Realty LLC';
const OFFICE = '100 Brickell Ave, Miami, FL 33131';

function consent(channel: Channel, address: string, scope: ConsentRecord['scopes'][number]): ConsentRecord {
  return {
    channel,
    address,
    scopes: [scope],
    writtenSignature: true,
    disclosureShown: true,
    obtainedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

/** An input that passes every check for the given channel. */
function passing(channel: Channel, overrides: Partial<GateInput> = {}): GateInput {
  let perms = defaultPermissions();
  for (const c of CHANNELS) perms = withContact(perms, c, true);
  const base: GateInput = {
    action: { channel, state: 'APPROVED', subjectKey: 'campaign-1' },
    recipient: {
      email: 'owner@example.com',
      phone: '+13055550100',
      postalAddress: '12 Palm Way, Miami, FL 33139',
      timeZone: 'America/New_York',
      basis: 'none',
      onFloridaDoNotCall: false,
      onNationalDoNotCall: false,
    },
    sender: { brokerageName: BROKERAGE, postalAddress: OFFICE },
    content: {
      text: `Hello from Ana at ${BROKERAGE}. ${OFFICE}. This is an advertisement.`,
      hasUnsubscribeLink: true,
      identifiesAsAdvertisement: true,
      whatsappTemplateId: 'tmpl_1',
    },
    permissions: perms,
    platform: { availableChannels: new Set(CHANNELS), liveEmailSending: true },
    suppressed: false,
    consents: [
      consent('sms', '+13055550100', 'marketing_texts'),
      consent('whatsapp', '+13055550100', 'whatsapp_marketing'),
    ],
    recentAttempts: [],
    now: NOW,
  };
  return { ...base, ...overrides };
}

function failed(input: GateInput): GateCheckCode[] {
  return evaluateGate(input)
    .checks.filter((c) => !c.passed)
    .map((c) => c.code);
}

describe('compliance gate — baseline', () => {
  for (const channel of CHANNELS) {
    it(`allows a fully compliant ${channel} action`, () => {
      const d = evaluateGate(passing(channel));
      assert.deepEqual(failed(passing(channel)), []);
      assert.equal(d.allowed, true);
      assert.equal(d.policyVersion, GATE_POLICY_VERSION);
    });
  }
});

describe('compliance gate — common checks', () => {
  for (const channel of CHANNELS) {
    it(`${channel}: blocks unless the action is APPROVED`, () => {
      for (const state of ['DRAFT', 'READY', 'EXECUTING', 'COMPLETED', 'FAILED'] as const) {
        const input = passing(channel, { action: { channel, state, subjectKey: 'campaign-1' } });
        assert.deepEqual(failed(input), ['action_approved'], state);
      }
    });

    it(`${channel}: blocks without contact permission for that channel`, () => {
      const input = passing(channel);
      const perms = withContact(input.permissions, channel, false);
      assert.deepEqual(failed({ ...input, permissions: perms }), ['contact_permission']);
    });

    it(`${channel}: blocks a suppressed recipient`, () => {
      assert.deepEqual(failed(passing(channel, { suppressed: true })), ['not_suppressed']);
    });

    it(`${channel}: blocks content without the brokerage name`, () => {
      const input = passing(channel);
      const text = input.content.text.replace(BROKERAGE, 'our team');
      assert.deepEqual(failed({ ...input, content: { ...input.content, text } }), ['brokerage_name_present']);
    });
  }

  it('blocks SMS and WhatsApp in the MVP release', () => {
    for (const channel of ['sms', 'whatsapp'] as const) {
      const d = evaluateGate(passing(channel, { platform: { availableChannels: MVP_AVAILABLE_CHANNELS, liveEmailSending: true } }));
      assert.equal(d.allowed, false);
      assert.ok(d.checks.some((c) => c.code === 'channel_available' && !c.passed));
    }
  });

  it('defaults block every channel because contact starts off', () => {
    for (const channel of CHANNELS) {
      const d = evaluateGate(passing(channel, { permissions: defaultPermissions() }));
      assert.equal(d.allowed, false, channel);
    }
  });

  it('reports every check, passed or not', () => {
    const d = evaluateGate(passing('email'));
    assert.ok(d.checks.length >= 9);
    assert.ok(d.checks.every((c) => c.detail.length > 0));
  });
});

describe('compliance gate — email (CAN-SPAM)', () => {
  it('needs a recipient address', () => {
    const input = passing('email');
    const { email: _omit, ...rest } = input.recipient;
    assert.deepEqual(failed({ ...input, recipient: rest }), ['recipient_address_present']);
  });

  it('needs the sender postal address in the message', () => {
    const input = passing('email');
    const text = input.content.text.replace(OFFICE, '');
    assert.deepEqual(failed({ ...input, content: { ...input.content, text } }), ['email_sender_postal_address']);
  });

  it('needs an unsubscribe link', () => {
    const input = passing('email');
    assert.deepEqual(failed({ ...input, content: { ...input.content, hasUnsubscribeLink: false } }), [
      'email_unsubscribe_link',
    ]);
  });

  it('needs an ad disclosure unless the recipient opted in', () => {
    const input = passing('email');
    const noDisclosure = { ...input, content: { ...input.content, identifiesAsAdvertisement: false } };
    assert.deepEqual(failed(noDisclosure), ['email_ad_disclosure']);
    const optedIn = { ...noDisclosure, consents: [consent('email', 'OWNER@example.com', 'email_marketing')] };
    assert.deepEqual(failed(optedIn), []);
  });

  it('stays blocked while live sending is switched off', () => {
    const input = passing('email', { platform: { availableChannels: new Set(CHANNELS), liveEmailSending: false } });
    assert.deepEqual(failed(input), ['email_live_sending_enabled']);
  });
});

describe('compliance gate — calls (Fla. Stat. 501.059 and 501.616)', () => {
  it('fails closed when do-not-call status is unknown', () => {
    const input = passing('call');
    const { onFloridaDoNotCall: _a, ...rest } = input.recipient;
    assert.deepEqual(failed({ ...input, recipient: rest }), ['do_not_call_screened']);
  });

  it('blocks a number on the Florida list unless an exemption applies', () => {
    const input = passing('call');
    const listed = { ...input, recipient: { ...input.recipient, onFloridaDoNotCall: true } };
    assert.deepEqual(failed(listed), ['florida_do_not_call']);
    for (const basis of ['responded_to_ad', 'prior_relationship', 'express_request'] as const) {
      assert.deepEqual(failed({ ...listed, recipient: { ...listed.recipient, basis } }), [], basis);
    }
  });

  it('only an express request overrides the national registry', () => {
    const input = passing('call');
    const listed = { ...input, recipient: { ...input.recipient, onNationalDoNotCall: true } };
    assert.deepEqual(failed(listed), ['national_do_not_call']);
    assert.deepEqual(failed({ ...listed, recipient: { ...listed.recipient, basis: 'responded_to_ad' } }), [
      'national_do_not_call',
    ]);
    assert.deepEqual(failed({ ...listed, recipient: { ...listed.recipient, basis: 'express_request' } }), []);
  });

  it('enforces the 8 a.m.–8 p.m. window in the recipient time zone', () => {
    // 20:30 EDT on 13 Oct
    assert.deepEqual(failed(passing('call', { now: new Date('2026-10-14T00:30:00Z') })), ['calling_hours']);
    // 19:59 EDT is allowed, 20:00 is not
    assert.deepEqual(failed(passing('call', { now: new Date('2026-10-14T23:59:00Z') })), []);
    assert.deepEqual(failed(passing('call', { now: new Date('2026-10-15T00:00:00Z') })), ['calling_hours']);
  });

  it('handles the switch to standard time', () => {
    // 2 Nov 2026 is EST (UTC-5): 12:59Z = 07:59, 13:00Z = 08:00
    assert.deepEqual(failed(passing('call', { now: new Date('2026-11-02T12:59:00Z') })), ['calling_hours']);
    assert.deepEqual(failed(passing('call', { now: new Date('2026-11-02T13:00:00Z') })), []);
  });

  it('fails closed on a missing or invalid time zone', () => {
    const input = passing('call');
    const { timeZone: _tz, ...rest } = input.recipient;
    assert.deepEqual(failed({ ...input, recipient: rest }), ['calling_hours']);
    assert.deepEqual(failed({ ...input, recipient: { ...input.recipient, timeZone: 'Mars/Olympus' } }), [
      'calling_hours',
    ]);
  });

  it('allows at most three calls per 24 hours on the same subject', () => {
    const at = (h: number) => new Date(NOW.getTime() - h * 3600_000);
    const two = [1, 5].map((h) => ({ at: at(h), channel: 'call' as const, subjectKey: 'campaign-1' }));
    assert.deepEqual(failed(passing('call', { recentAttempts: two })), []);
    const three = [...two, { at: at(23), channel: 'call' as const, subjectKey: 'campaign-1' }];
    assert.deepEqual(failed(passing('call', { recentAttempts: three })), ['call_frequency']);
    // older than 24h, other subject, or other channel do not count
    const ignored = [
      ...two,
      { at: at(25), channel: 'call' as const, subjectKey: 'campaign-1' },
      { at: at(2), channel: 'call' as const, subjectKey: 'campaign-2' },
      { at: at(2), channel: 'email' as const, subjectKey: 'campaign-1' },
    ];
    assert.deepEqual(failed(passing('call', { recentAttempts: ignored })), []);
  });
});

describe('compliance gate — SMS (prior express written consent)', () => {
  it('requires written consent for this exact number', () => {
    assert.deepEqual(failed(passing('sms', { consents: [] })), ['written_consent']);
    assert.deepEqual(failed(passing('sms', { consents: [consent('sms', '+13055550199', 'marketing_texts')] })), [
      'written_consent',
    ]);
  });

  it('rejects consent without signature or disclosure, revoked, or future-dated', () => {
    const c = consent('sms', '+13055550100', 'marketing_texts');
    for (const bad of [
      { ...c, writtenSignature: false },
      { ...c, disclosureShown: false },
      { ...c, revokedAt: new Date('2026-10-01T00:00:00Z') },
      { ...c, obtainedAt: new Date('2026-12-01T00:00:00Z') },
      { ...c, scopes: ['email_marketing' as const] },
    ]) {
      assert.deepEqual(failed(passing('sms', { consents: [bad] })), ['written_consent']);
    }
  });
});

describe('compliance gate — WhatsApp', () => {
  it('requires opt-in and an approved template', () => {
    assert.deepEqual(failed(passing('whatsapp', { consents: [] })), ['whatsapp_opt_in']);
    const input = passing('whatsapp');
    const { whatsappTemplateId: _t, ...content } = input.content;
    assert.deepEqual(failed({ ...input, content }), ['whatsapp_template']);
  });
});

describe('compliance gate — mail', () => {
  it('needs a mailing address and nothing phone-related', () => {
    const input = passing('mail', {
      recipient: { basis: 'none', postalAddress: '12 Palm Way, Miami, FL 33139' },
    });
    assert.deepEqual(failed(input), []);
    assert.deepEqual(failed({ ...input, recipient: { basis: 'none' } }), ['recipient_address_present']);
  });
});

describe('localHour', () => {
  it('converts to the recipient zone', () => {
    assert.equal(localHour(NOW, 'America/New_York'), 11);
    assert.equal(localHour(NOW, 'America/Los_Angeles'), 8);
    assert.equal(localHour(NOW, 'Not/AZone'), undefined);
  });
});
