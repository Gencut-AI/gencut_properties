import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Command,
  type ListedItem,
  buyersReply,
  commandFromIntent,
  helpReply,
  intentPrompt,
  maskWaId,
  normalizeWaId,
  parseCommand,
  sellerDetailReply,
  summaryReply,
} from '../src/index.ts';

const SITE = 'https://app.example.com';
const listed: ListedItem[] = [
  { n: 1, kind: 'seller', id: 'a', label: '100 EXAMPLE DR' },
  { n: 2, kind: 'seller', id: 'b', label: '200 SAMPLE ST' },
];

describe('Assistant commands', () => {
  it('parses the phrasings agents use', () => {
    const cases: [string, Command][] = [
      ['help', { kind: 'help' }],
      ['Hi', { kind: 'summary' }],
      ["What's new?", { kind: 'summary' }],
      ['buyers', { kind: 'list', target: 'buyers' }],
      ['Show me my best leads', { kind: 'list', target: 'sellers' }],
      ['Find me five new seller opportunities', { kind: 'list', target: 'sellers' }],
      ['how are my campaigns doing', { kind: 'list', target: 'campaigns' }],
      ['2', { kind: 'show', n: 2 }],
      ['#3', { kind: 'show', n: 3 }],
      ['tell me more about the second one', { kind: 'show', n: 2 }],
      ['draft 2', { kind: 'draft', n: 2 }],
      ['Create a campaign for number 1', { kind: 'draft', n: 1 }],
      ['save 1', { kind: 'triage', n: 1, status: 'saved' }],
      ['dismiss 2', { kind: 'triage', n: 2, status: 'dismissed' }],
      ['LINK 123456', { kind: 'link', code: '123456' }],
      ['link123456', { kind: 'link', code: '123456' }],
      ['STOP', { kind: 'unlink' }],
      ['Send the letter to the owner', { kind: 'unknown' }],
      ['', { kind: 'unknown' }],
    ];
    for (const [text, want] of cases) assert.deepEqual(parseCommand(text), want, text);
  });

  it('never turns a price or a ZIP code into a list reference', () => {
    assert.deepEqual(parseCommand('draft homes under 500000'), { kind: 'list', target: 'sellers' });
    assert.notEqual(parseCommand('33180').kind, 'show');
  });

  it('accepts only a known command from the model, and only numbers that were listed', () => {
    assert.deepEqual(commandFromIntent({ command: 'draft 2' }, listed), { kind: 'draft', n: 2 });
    assert.deepEqual(commandFromIntent({ command: 'buyers' }, listed), { kind: 'list', target: 'buyers' });
    assert.deepEqual(commandFromIntent({ command: 'draft 7' }, listed), { kind: 'unknown' }, 'not in the list');
    assert.deepEqual(commandFromIntent({ command: 'link 123456' }, listed), { kind: 'unknown' }, 'linking is never inferred');
    assert.deepEqual(commandFromIntent({ command: 'stop' }, listed), { kind: 'unknown' }, 'unlinking is never inferred');
    assert.deepEqual(commandFromIntent({ command: 'send 2' }, listed), { kind: 'unknown' });
    assert.deepEqual(commandFromIntent('draft 2', listed), { kind: 'unknown' }, 'not an object');
    const p = intentPrompt('write something for the second house', listed);
    assert.match(p.user, /2\. seller: 200 SAMPLE ST/);
    assert.match(p.system, /cannot do here/);
  });

  it('normalizes and masks WhatsApp numbers', () => {
    assert.equal(normalizeWaId('+1 (305) 555-0100'), '13055550100');
    assert.equal(normalizeWaId('12'), null);
    assert.equal(maskWaId('13055550100'), '+1 ••• ••• 0100');
  });
});

describe('Assistant replies', () => {
  it('keep button labels within WhatsApp limits and remember numbered lists', () => {
    const replies = [
      helpReply(SITE),
      summaryReply({ name: 'Ana Test', sellers: 3, buyers: 4, drafting: 1, inReview: 2 }, SITE),
      sellerDetailReply({ id: 'a', address: '100 EXAMPLE DR', city: 'AVENTURA', zip: '33180', propertyType: 'Condominium', score: 60, marketValue: 500000, reasons: ['In your focus area.'] }, 1, SITE),
    ];
    for (const r of replies) {
      assert.ok((r.buttons ?? []).length <= 3);
      for (const b of r.buttons ?? []) assert.ok(b.title.length <= 20, b.title);
    }
    const b = buyersReply([{ id: 'x', score: 80, name: 'SAMPLE HOLDINGS LLC', purchases: 3, zips: ['33180'], latest: 'May 2026' }], SITE);
    assert.deepEqual(b.listed, [{ n: 1, kind: 'buyer', id: 'x', label: 'SAMPLE HOLDINGS LLC' }]);
    assert.match(b.text, /not a sign they are buying now/);
  });
});
