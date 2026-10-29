import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canPrivateReply, DEFAULT_INSTAGRAM_KEYWORDS, instagramReplyText, matchKeyword, parseKeywords } from '../src/index.ts';

describe('instagram comments', () => {
  it('parses keywords and falls back to the defaults', () => {
    assert.deepEqual(parseKeywords(' value, home  value;x '), ['VALUE', 'HOME']);
    assert.deepEqual(parseKeywords(''), DEFAULT_INSTAGRAM_KEYWORDS);
  });

  it('matches whole keywords in any case', () => {
    const k = ['VALUE', 'SEND'];
    assert.equal(matchKeyword('value please!', k), 'VALUE');
    assert.equal(matchKeyword('🔥SEND🔥', k), 'SEND');
    assert.equal(matchKeyword('great valuation', k), null);
    assert.equal(matchKeyword('nice house', k), null);
  });

  it('allows one reply window of 7 days and writes a short, signed reply', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    assert.ok(canPrivateReply(new Date('2026-10-23T12:00:01Z'), now));
    assert.ok(!canPrivateReply(new Date('2026-10-22T12:00:00Z'), now));
    const t = instagramReplyText('ana.test<script>', 'Paul', 'https://x.example/l/paul-abc123?src=instagram');
    assert.match(t, /^Hi @ana\.testscript! /);
    assert.ok(t.includes('https://x.example/l/paul-abc123?src=instagram') && t.endsWith('— Paul'));
    assert.ok(t.length < 1000);
  });
});
