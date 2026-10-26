import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentForDraft,
  BUYER_DRAFT,
  BUYER_LETTER_PROMPT_VERSION,
  CAMPAIGN_PROMPT_VERSION,
  type CampaignDraft,
  type PropertyTransaction,
  SELLER_DRAFT,
  buyerFacts,
  buyerLetterPrompt,
  buyerProfile,
  checkBuyerLetter,
  draftKind,
} from '../src/index.ts';

// Synthetic company, purchases and agent. Not real.
const tx = (n: number, over: Partial<PropertyTransaction> = {}): PropertyTransaction => ({
  countyCode: '23', parcelId: `P${n}`, rollYear: 2026, situs: { address: `${n}00 EXAMPLE DR`, city: 'AVENTURA', zip: '33180' },
  useCode: '004', units: 1, livingArea: 1100, yearBuilt: 2005, ownerName: 'BAYVIEW SAMPLE HOLDINGS LLC', ownerKey: 'BAYVIEWSAMPLEHOLDINGSLLC',
  ownerMailing: { address1: '1 SAMPLE PLAZA', address2: '', city: 'MIAMI', state: 'FL', zip: '33131' },
  saleYear: 2026, saleMonth: n, price: 400_000 + n * 25_000, qualificationCode: '01', ...over,
});
const profile = buyerProfile([tx(1), tx(2), tx(3, { situs: { address: '9 SAMPLE ST', city: 'MIAMI', zip: '33160' }, useCode: '001' })]);
const agent: AgentForDraft = {
  licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', licenseNumber: 'SL0000000',
  officeAddress: '100 Sample Blvd, Miami, FL 33131', specialty: 'Condominiums', market: 'Miami-Dade County',
};
const facts = buyerFacts(profile, agent);

const good: CampaignDraft = {
  title: 'Introduction to Bayview Sample Holdings LLC',
  strategy: {
    summary: 'Introduce Ana as a local agent for condominium opportunities in 33180 and 33160.',
    angle: 'A local source of opportunities in the areas the company knows.',
    reasons: [{ text: 'The company has bought condominiums in 33180.', factKeys: ['company.zips', 'company.home_types'] }],
  },
  letter: {
    greeting: 'Dear Bayview Sample Holdings LLC team,',
    paragraphs: [
      'My name is Ana Test, and I work with condominium and single family owners in 33180 and 33160.',
      'If it would be useful, I would be glad to share opportunities in those ZIP codes as they come up.',
      'Would you be open to a short call?',
    ],
    closing: 'Kind regards,',
    signature: ['Ana Test', 'Example Bay Realty LLC', 'License SL0000000', '100 Sample Blvd, Miami, FL 33131'],
  },
  followUp: [{ day: 21, channel: 'mail', action: 'Send a short second letter.' }],
  factsUsed: ['company.name', 'company.zips', 'company.home_types', 'agent.name', 'agent.brokerage'],
};
const withParagraph = (p: string): CampaignDraft => ({ ...good, letter: { ...good.letter, paragraphs: [p, ...good.letter.paragraphs.slice(1)] } });
const codes = (d: CampaignDraft, f = facts) => checkBuyerLetter(d, f, agent).map((p) => p.code);

describe('Buyer introduction letters', () => {
  it('gives the writer patterns only: no address, price, date, count or mailing address', () => {
    assert.deepEqual(facts.filter((f) => f.source === 'public_record').map((f) => [f.key, f.value]), [
      ['company.name', 'BAYVIEW SAMPLE HOLDINGS LLC'],
      ['company.zips', '33180, 33160'],
      ['company.home_types', 'condominium, single family'],
    ]);
    const prompt = buyerLetterPrompt(facts).user;
    for (const secret of ['EXAMPLE DR', '425,000', '475000', '2026', 'SAMPLE PLAZA', '33131 ']) assert.ok(!prompt.includes(secret), secret);
  });

  it('passes a letter that offers, without claiming', () => {
    assert.deepEqual(checkBuyerLetter(good, facts, agent), []);
  });

  it('rejects claims that the company is buying now', () => {
    for (const p of ['I know you are actively buying in 33180.', 'Since you are in the market for condominiums, let us talk.', 'I can help as you keep expanding your portfolio.'])
      assert.ok(codes(withParagraph(p)).includes('claims_intent'), p);
  });

  it('rejects claims that a property is available', () => {
    for (const p of ['I have an off-market condominium in 33180 for you.', 'There is a pocket listing you may like.', 'I have a property that fits.'])
      assert.ok(codes(withParagraph(p)).includes('claims_availability'), p);
  });

  it('rejects what the company bought and how it was found', () => {
    for (const p of [
      'I saw your recent purchases in 33180.', 'You bought several condominiums this year.', 'County records show your activity.',
      'I noticed your 3 homes in 33180.', 'Your home at 200 Example Dr is in a great area.',
    ])
      assert.ok(codes(withParagraph(p)).includes('reveals_subject'), p);
    assert.ok(codes(withParagraph('You paid $450,000 in 33180.')).includes('unsupported_figure'), 'a price is not a fact');
  });

  it('does not flag the words in a company\'s own name', () => {
    const named = (name: string) => buyerFacts({ ...profile, name }, agent);
    for (const name of ['WHITE SAMPLE ACQUISITIONS LLC', '1236 NE 109 STREET PROPERTY', 'SENIOR SAMPLE PURCHASES INC']) {
      const d: CampaignDraft = { ...good, title: `Introduction to ${name}`, letter: { ...good.letter, greeting: `Dear ${name} team,` } };
      assert.deepEqual(checkBuyerLetter(d, named(name), agent), [], name);
    }
  });

  it('keeps every seller-letter rule, including the brokerage in the signature', () => {
    assert.ok(codes(withParagraph('A great place for families.')).includes('prohibited_term'));
    assert.ok(codes({ ...good, letter: { ...good.letter, signature: ['Ana Test'] } }).includes('missing_brokerage'));
  });

  it('looks up the rules a campaign was written under', () => {
    assert.equal(draftKind(BUYER_LETTER_PROMPT_VERSION), BUYER_DRAFT);
    assert.equal(draftKind(CAMPAIGN_PROMPT_VERSION), SELLER_DRAFT);
    assert.equal(draftKind(null), SELLER_DRAFT, 'campaigns from before versions were stored');
    assert.equal(draftKind('campaign-draft-v0'), null);
    assert.equal(BUYER_DRAFT.audience, 'company');
  });
});
