import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkInboundLead, leadConsentText, leadPageSlug, leadSourceOf } from '../src/index.ts';

const ok = { name: '  Ana   Test ', email: ' Ana@Example.COM ', phone: '(305) 555-0100', interest: 'selling', zip: '33180', message: ' Hi ', consent: true };

describe('inbound leads', () => {
  it('cleans a valid submission', () => {
    const r = checkInboundLead(ok);
    assert.deepEqual(r, { ok: true, lead: { name: 'Ana Test', email: 'ana@example.com', phone: '13055550100', interest: 'selling', zip: '33180', message: 'Hi' } });
    const minimal = checkInboundLead({ ...ok, phone: '', zip: '', message: '' });
    assert.ok(minimal.ok && minimal.lead.phone === null && minimal.lead.zip === null && minimal.lead.message === null);
  });

  it('reports each bad field, and requires consent', () => {
    const r = checkInboundLead({ name: 'A', email: 'nope', phone: '123', interest: 'renting', zip: '331', message: 'x'.repeat(1001), consent: false });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r.ok ? {} : r.fields).sort(), ['consent', 'email', 'interest', 'message', 'name', 'phone', 'zip']);
  });

  it('knows the source from ?src= or the referring network', () => {
    assert.equal(leadSourceOf('instagram', null), 'instagram');
    assert.equal(leadSourceOf('IG', null), 'instagram');
    assert.equal(leadSourceOf('fb', 'https://www.tiktok.com/'), 'facebook', 'explicit source wins');
    assert.equal(leadSourceOf(null, 'https://l.instagram.com/?u=x'), 'instagram');
    assert.equal(leadSourceOf(null, 'https://lm.facebook.com/'), 'facebook');
    assert.equal(leadSourceOf(null, 'https://t.co/abc'), 'x');
    assert.equal(leadSourceOf(null, 'https://evilinstagram.com/'), 'link');
    assert.equal(leadSourceOf('spam', 'not a url'), 'link');
  });

  it('names the agent in the consent text and makes safe page addresses', () => {
    assert.match(leadConsentText('Ana Test', 'Example Bay Realty'), /Ana Test of Example Bay Realty may contact me by email or phone/);
    assert.equal(leadPageSlug('José  Núñez-Ruiz', 'A1B2C3'), 'jose-nunez-ruiz-a1b2c3');
    assert.equal(leadPageSlug('!!!', 'abc123'), 'agent-abc123');
  });
});
