import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildShareKit, commandFromIntent, fromChat, parseCommand, SHARE_NETWORKS, shareDisclosure, shareLink, shareReply } from '../src/index.ts';

const input = {
  agentName: 'Ana Test',
  brokerage: 'Example Bay Realty LLC',
  licenseNumber: 'SL0000000',
  zips: ['33180'],
  pageUrl: 'https://app.example.test/l/ana-test-a1b2c3',
};

describe('Share kit', () => {
  it('gives every network a caption and a link tagged with where the lead came from', () => {
    const kit = buildShareKit(input);
    assert.deepEqual(kit.targets.map((t) => t.network), [...SHARE_NETWORKS]);
    const by = (n: string) => kit.targets.find((t) => t.network === n)!;
    assert.equal(by('instagram').link, `${input.pageUrl}?src=instagram`);
    assert.equal(by('facebook').link, `${input.pageUrl}?src=facebook`);
    assert.equal(by('whatsapp').link, `${input.pageUrl}?src=whatsapp`);
    assert.equal(by('sms').link, input.pageUrl, 'a text message counts as a shared link');
    assert.equal(shareLink(input.pageUrl, 'x'), `${input.pageUrl}?src=x`);
  });

  it('names the agent, the brokerage and the license in every caption', () => {
    const kit = buildShareKit(input);
    const disclosure = 'Ana Test · Example Bay Realty LLC · License SL0000000';
    assert.equal(shareDisclosure(input), disclosure);
    for (const t of kit.targets) assert.ok(t.caption.endsWith(disclosure), t.network);
    assert.ok(kit.caption.endsWith(disclosure));
    assert.equal(shareDisclosure({ ...input, licenseNumber: null }), 'Ana Test · Example Bay Realty LLC');
    assert.match(kit.caption, /in 33180\?/);
    assert.match(buildShareKit({ ...input, zips: [] }).caption, /in Miami\?/);
  });

  it('points to the bio where a caption link cannot be clicked, and opens share screens elsewhere', () => {
    const kit = buildShareKit(input);
    const by = (n: string) => kit.targets.find((t) => t.network === n)!;
    for (const n of ['instagram', 'tiktok']) {
      assert.match(by(n).caption, /Link in my bio\./);
      assert.ok(!by(n).caption.includes('http'), `${n}: no dead link in the caption`);
      assert.equal(by(n).openUrl, null);
      assert.ok(by(n).howTo?.includes(by(n).link));
    }
    assert.ok(by('whatsapp').openUrl?.startsWith('https://wa.me/?text='));
    assert.equal(decodeURIComponent(by('whatsapp').openUrl!.slice('https://wa.me/?text='.length)), by('whatsapp').caption);
    assert.equal(by('facebook').openUrl, `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(by('facebook').link)}`);
    assert.ok(by('linkedin').openUrl?.includes(encodeURIComponent(by('linkedin').link)));
    const x = new URL(by('x').openUrl!);
    assert.equal(x.searchParams.get('url'), by('x').link);
    assert.ok((x.searchParams.get('text') ?? '').length <= 200);
    assert.ok(by('sms').openUrl?.startsWith('sms:'));
  });

  it('refuses a page address with a query, and a missing name or brokerage', () => {
    assert.throws(() => buildShareKit({ ...input, pageUrl: `${input.pageUrl}?src=x` }));
    assert.throws(() => buildShareKit({ ...input, pageUrl: 'javascript:alert(1)' }));
    assert.throws(() => buildShareKit({ ...input, brokerage: ' ' }));
  });
});

describe('Share on WhatsApp', () => {
  it('understands the ways agents ask to share', () => {
    for (const text of ['share', 'Share it', 'post to Instagram', 'share on facebook', 'Instagram', 'my link', 'link in bio', 'post to social media'])
      assert.deepEqual(parseCommand(text), { kind: 'share' }, text);
    assert.deepEqual(parseCommand('show me my best leads'), { kind: 'list', target: 'sellers' }, 'lead lists are not shares');
    assert.deepEqual(parseCommand('LINK 123456'), { kind: 'link', code: '123456' });
  });

  it('lets the model choose share, and nothing else new', () => {
    assert.deepEqual(commandFromIntent({ command: 'share' }, []), { kind: 'share' });
    assert.deepEqual(fromChat({ reply: 'Here is your post.', action: 'share' }, []).command, { kind: 'share' });
    assert.deepEqual(commandFromIntent({ command: 'publish' }, []), { kind: 'unknown' });
  });

  it('sends the caption as its own message, ready to forward', () => {
    const r = shareReply({ whatsappCaption: 'CAPTION', instagramLink: 'IG', facebookLink: 'FB', tiktokLink: 'TT' }, 'https://app.example.test');
    assert.equal(r.then?.text, 'CAPTION');
    assert.match(r.text, /Instagram bio or story sticker: IG/);
    assert.match(r.text, /https:\/\/app\.example\.test\/leads#share/);
  });
});
