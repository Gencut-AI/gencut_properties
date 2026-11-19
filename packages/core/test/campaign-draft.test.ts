import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentForDraft,
  type CampaignDraft,
  type StoredParcel,
  campaignFacts,
  CAMPAIGN_PROMPT_VERSION,
  MIN_RECENT_SALES,
  type RollSale,
  SELLER_DRAFT,
  campaignPrompt,
  checkCampaignDraft,
  draftKind,
  recentSalesSummary,
  costUsd,
  extractJson,
  parseCampaignDraft,
} from '../src/index.ts';

// Synthetic parcel and agent. Not real people or properties.
const parcel: StoredParcel = {
  parcelId: 'TEST000001',
  countyCode: '23',
  assessmentYear: 2026,
  useCode: '001',
  situs: { address: '100 EXAMPLE WAY', city: 'AVENTURA', zip: '33180' },
  owner: { name: 'TEST HOLDINGS LLC', address1: '9 SAMPLE ST', address2: '', city: 'NEW YORK', state: 'NY', zip: '10001' },
  ownerKind: 'company',
  justValue: 2_664_071,
  assessedValue: 1_555_860,
  homestead: false,
  sales: [{ year: 2022, month: 6, price: 2_400_000, qualificationCode: '01' }],
  prior: null,
  units: 1,
  yearBuilt: 1957,
  livingArea: 2088,
};
const agent: AgentForDraft = {
  licenseeName: 'Ana Test',
  brokerageName: 'Example Bay Realty LLC',
  licenseNumber: 'SL3456789',
  officeAddress: '1 Sample Plaza, Miami, FL 33131',
  specialty: 'Single-family homes',
  market: 'Miami-Dade County',
};
const facts = campaignFacts(parcel, agent);

const good: CampaignDraft = {
  title: 'Introduction to the owner of 100 Example Way',
  strategy: {
    summary: 'A short, personal introduction letter about the single-family home at 100 Example Way.',
    angle: 'Local single-family specialist offering a no-obligation conversation.',
    reasons: [{ text: 'The home was built in 1957 and has 2,088 sq ft of living area.', factKeys: ['property.year_built', 'property.living_area'] }],
  },
  letter: {
    greeting: 'Dear Owner of 100 Example Way,',
    paragraphs: [
      'I work with owners of single-family homes in Aventura, and your 1957 home at 100 Example Way caught my attention.',
      'If you ever want to talk about your plans for the property, I would be glad to share what I see in the area, with no obligation.',
    ],
    closing: 'Warm regards,',
    signature: ['Ana Test', 'Example Bay Realty LLC', 'License SL3456789'],
  },
  followUp: [
    { day: 21, channel: 'mail', action: 'Send a short second letter if there is no reply.' },
    { day: 45, channel: 'call_task', action: 'Remind the agent to call only if the owner has replied with a number.' },
  ],
  factsUsed: ['property.address', 'property.year_built', 'agent.name', 'agent.brokerage', 'agent.license'],
};

const problems = (d: CampaignDraft) => checkCampaignDraft(d, facts, agent).map((p) => p.code);

describe('campaign drafts', () => {
  it('offers the model property and agent facts, never how the owner was found, the roll value or past sales', () => {
    const keys = facts.map((f) => f.key);
    assert.ok(keys.includes('property.address') && keys.includes('agent.brokerage'));
    const all = JSON.stringify(facts);
    for (const hidden of ['2,664,071', '2664071', '1,555,860', '2,400,000', 'NEW YORK', 'NY', 'homestead', 'absentee']) {
      assert.ok(!all.includes(hidden), `facts must not include ${hidden}`);
    }
    const { system, user } = campaignPrompt(facts, ['"$2.1 million" is not in the provided facts.']);
    assert.match(system, /Use ONLY the facts provided/);
    assert.match(user, /property\.year_built \(Year built\): 1957/);
    assert.match(user, /rejected for these reasons/);
  });

  it('accepts a grounded, fair, signed draft', () => {
    assert.deepEqual(problems(good), []);
  });

  it('rejects invented figures, including rounded money', () => {
    const d = { ...good, letter: { ...good.letter, paragraphs: ['Homes like yours sold for $2.1 million last year, up 12% in a year.'] } };
    const found = checkCampaignDraft(d, facts, agent).filter((p) => p.code === 'unsupported_figure').map((p) => p.message);
    assert.equal(found.length, 2, found.join(' | '));
    const year = { ...good, letter: { ...good.letter, paragraphs: ['Built in 1962, it has great bones.'] } };
    assert.ok(problems(year).includes('unsupported_figure'));
  });

  it('rejects fair-housing, hardship and how-we-found-you language', () => {
    for (const phrase of [
      'perfect for families',
      'a quiet place for retirees',
      'I am sorry for your loss; if the estate is in probate',
      'Our records show you live out of state',
      'Since you are an absentee owner',
      'We guarantee a sale',
    ]) {
      const d = { ...good, letter: { ...good.letter, paragraphs: [phrase] } };
      assert.ok(problems(d).includes('prohibited_term'), phrase);
    }
    // "single-family" describes the property, not the people.
    assert.ok(!problems(good).includes('prohibited_term'));
  });

  it('requires the brokerage name in the signature and known fact keys', () => {
    assert.ok(problems({ ...good, letter: { ...good.letter, signature: ['Ana Test'] } }).includes('missing_brokerage'));
    assert.ok(problems({ ...good, factsUsed: ['owner.net_worth'] }).includes('unknown_fact'));
  });

  it('v2: signs with a way to reach the agent when the profile has one, and only then', () => {
    assert.equal(CAMPAIGN_PROMPT_VERSION, 'campaign-draft-v2');
    assert.equal(draftKind('campaign-draft-v1'), SELLER_DRAFT, 'letters written under v1 stay editable');
    const reachable = campaignFacts(parcel, { ...agent, phone: '(305) 555-0123', email: 'ana@example.com' });
    assert.deepEqual(reachable.filter((f) => f.key.startsWith('agent.p') || f.key === 'agent.email').map((f) => [f.key, f.value]), [
      ['agent.phone', '(305) 555-0123'],
      ['agent.email', 'ana@example.com'],
    ]);
    const codes = (d: CampaignDraft) => checkCampaignDraft(d, reachable, agent).map((p) => p.code);
    assert.ok(codes(good).includes('missing_contact'), 'no phone or email in the signature');
    assert.deepEqual(codes({ ...good, letter: { ...good.letter, signature: [...good.letter.signature, '305.555.0123'] } }), [], 'the phone, any format');
    assert.deepEqual(codes({ ...good, letter: { ...good.letter, signature: [...good.letter.signature, 'Ana@Example.com'] } }), [], 'or the email');
    assert.deepEqual(checkCampaignDraft(good, facts, agent), [], 'no contact facts (a v1 campaign): not required');
    const { system } = campaignPrompt(reachable);
    assert.match(system, /reason to reply/);
    assert.match(system, /phone and email if provided/);
    assert.match(system, /never tell the owner the property is outside the agent's focus/);
  });

  it('summarises recent qualified sales of the same kind of home in the ZIP code, leaving out multi-parcel deeds and the owner', () => {
    const sale = (parcelId: string, year: number, month: number | null, price: number | null, qualificationCode = '01'): RollSale => ({ parcelId, year, month, price, qualificationCode });
    const sales = [
      sale('A', 2026, 7, 400_000), sale('B', 2026, 5, 420_000), sale('C', 2026, 1, 380_000), sale('D', 2025, 9, 450_000),
      sale('E', 2025, 8, 410_000),
      sale('F', 2025, 7, 999_000), // 12 months before the newest: outside the window
      sale('G', 2026, 6, 300_000, '11'), // disqualified transfer
      sale('H', 2026, 6, 2_000_000), sale('I', 2026, 6, 2_000_000), // one deed covering two parcels
      sale('OWN', 2026, 3, 100_000), // the owner's own sale is never counted
      sale('J', 2026, 2, 500_000, '01'), sale('K', 2026, null, 500_000),
    ];
    assert.equal(recentSalesSummary(sales, '33156', '004', 'OWN'), '6 condominium sales in ZIP 33156 from Aug 2025 to Jul 2026, median price $415,000');
    assert.equal(recentSalesSummary(sales.slice(0, MIN_RECENT_SALES - 1), '33156', '004', 'OWN'), null, 'too few to say anything');
    const withSales = campaignFacts(parcel, agent, '6 condominium sales in ZIP 33156 from Aug 2025 to Jul 2026, median price $415,000');
    const draft: CampaignDraft = { ...good, letter: { ...good.letter, paragraphs: [...good.letter.paragraphs, 'Six nearby sales had a median price of $415,000.'] } };
    assert.deepEqual(checkCampaignDraft(draft, withSales, agent), [], 'the median may be quoted');
  });

  it('parses a model reply strictly', () => {
    const reply = `Here is the campaign:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
    const parsed = parseCampaignDraft(extractJson(reply));
    assert.ok(parsed.ok);
    assert.equal(parsed.ok && parsed.value.followUp[0]?.day, 21);
    assert.equal(parseCampaignDraft({ ...good, followUp: [{ day: 3, channel: 'sms', action: 'Text them' }] }).ok, false);
    assert.equal(parseCampaignDraft({ ...good, letter: { ...good.letter, paragraphs: [] } }).ok, false);
    assert.throws(() => extractJson('no json here'));
  });

  it('prices a call from its usage, counting cached input at the cache rate', () => {
    const price = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 };
    assert.equal(costUsd({ inputTokens: 21_000, outputTokens: 4_000, cacheReadTokens: 0 }, price), 0.082);
    assert.equal(costUsd({ inputTokens: 21_000, outputTokens: 4_000, cacheReadTokens: 3_000 }, price), 0.0763);
    // Writing 3,000 tokens to the cache costs 1.25x the input price.
    assert.equal(costUsd({ inputTokens: 21_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 3_000 }, price), 0.0835);
  });
});
