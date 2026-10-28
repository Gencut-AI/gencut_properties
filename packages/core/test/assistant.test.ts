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

describe('Assistant conversation', () => {
  it('parses yes/no, next, details, outcomes and letter edits', async () => {
    const { parseCommand: p } = await import('../src/index.ts');
    assert.deepEqual(p('Yes'), { kind: 'confirm', yes: true });
    assert.deepEqual(p('not now'), { kind: 'confirm', yes: false });
    assert.deepEqual(p("what's next?"), { kind: 'suggest' });
    assert.deepEqual(p('details'), { kind: 'show', n: null });
    assert.deepEqual(p('outcome 2 responded'), { kind: 'outcome', n: 2, outcome: 'responded' });
    assert.deepEqual(p('outcome qualified conversation'), { kind: 'outcome', n: null, outcome: 'qualified_conversation' });
    assert.deepEqual(p('outcome 2 sold it'), { kind: 'unknown' }, 'only known outcome codes');
    assert.deepEqual(p('Edit: mention I grew up in Aventura'), { kind: 'edit', instruction: 'mention I grew up in Aventura' });
    assert.deepEqual(p('make it shorter'), { kind: 'edit', instruction: 'make it shorter' });
  });

  it('takes the model\'s action only from the fixed list, and only for listed items', async () => {
    const { fromChat } = await import('../src/index.ts');
    assert.deepEqual(fromChat({ reply: 'Here are your buyers.', action: 'buyers' }, listed), { reply: 'Here are your buyers.', command: { kind: 'list', target: 'buyers' } });
    assert.deepEqual(fromChat({ reply: 'Noted.', action: 'outcome 2 no_response' }, listed).command, { kind: 'outcome', n: 2, outcome: 'no_response' });
    assert.deepEqual(fromChat({ reply: 'Sure.', action: 'edit: warmer, and shorter' }, listed).command, { kind: 'edit', instruction: 'warmer, and shorter' });
    assert.deepEqual(fromChat({ reply: 'Which one?', action: 'none' }, listed).command, { kind: 'unknown' });
    assert.deepEqual(fromChat({ reply: 'x', action: 'draft 9' }, listed).command, { kind: 'unknown' }, 'not in the list');
    assert.deepEqual(fromChat({ reply: 'x', action: 'send 2' }, listed).command, { kind: 'unknown' });
    assert.deepEqual(fromChat({ reply: 'x', action: 'link 123456' }, listed).command, { kind: 'unknown' });
    assert.deepEqual(fromChat('buyers', listed), { reply: null, command: { kind: 'unknown' } });
  });

  it('never lets a reply claim something was sent, or state a figure it was not given', async () => {
    const { checkChatReply, chatPrompt } = await import('../src/index.ts');
    const context = 'You have 42 seller opportunities in 33180; median price $512,000.';
    assert.equal(checkChatReply('You have 42 sellers in 33180.', context), 'You have 42 sellers in 33180.');
    assert.equal(checkChatReply('I sent the letter to the owner.', context), null);
    assert.equal(checkChatReply("I've mailed it.", context), null);
    assert.equal(checkChatReply('The letter has been approved.', context), null);
    assert.equal(checkChatReply('Homes there sell for $640,000.', context), null, 'an invented price');
    assert.equal(checkChatReply('Two of them look strong.', context), 'Two of them look strong.');
    assert.equal(checkChatReply('Item 3 looks strong.', context), 'Item 3 looks strong.', 'small counts are fine');
    const p = chatPrompt('who should I write to first?', [{ from: 'agent', text: 'hi' }, { from: 'gencut', text: 'Hi Ana.' }], { facts: ['Agent: Ana Test, Miami-Dade, ZIP 33180'], listed, focus: null, pendingQuestion: null });
    assert.match(p.user, /Agent: hi\nGenCut: Hi Ana\./);
    assert.match(p.system, /never say you did/);
  });
});
