import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentForDraft,
  type SocialPost,
  type StoredParcel,
  areaFacts,
  checkMediaBudget,
  checkSocialPost,
  extractJson,
  neighborhoodImagePrompt,
  parseSocialPost,
  sniffImageType,
  socialPostPrompt,
} from '../src/index.ts';

// Synthetic parcel and agent. Not real people or properties.
const parcel: StoredParcel = {
  parcelId: 'TEST000002',
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
  officeAddress: null,
  specialty: 'Single-family homes',
  market: 'Miami-Dade County',
};
const facts = areaFacts(parcel, agent);
const subject = { address: parcel.situs.address, ownerName: parcel.owner.name };

const good: SocialPost = {
  headline: 'Thinking about selling in Aventura?',
  caption:
    'I am Ana Test with Example Bay Realty LLC (License SL3456789), and I work with single-family homeowners across 33180 and Miami-Dade County. If you have wondered what your next step could look like, I am happy to talk it through.',
  callToAction: 'Send me a message for a no-obligation conversation.',
  hashtags: ['#Aventura', '#MiamiDadeRealEstate', '#HomeSellers'],
  imageBrief: 'A quiet tree-lined residential street at golden hour with palm trees and soft light.',
  factsUsed: ['area.city', 'area.zip', 'agent.name', 'agent.brokerage'],
};
const problems = (p: SocialPost) => checkSocialPost(p, facts, agent, subject).map((x) => x.code);

describe('Film Crew social post', () => {
  it('gives the copywriter the area and the agent, never the address, owner, value or how the owner was found', () => {
    const keys = facts.map((f) => f.key);
    assert.ok(keys.includes('area.zip') && keys.includes('area.city') && keys.includes('agent.brokerage'));
    const all = JSON.stringify(facts);
    for (const hidden of ['EXAMPLE WAY', 'TEST HOLDINGS', '2664071', '2,664,071', '2,400,000', 'NEW YORK', '1957']) {
      assert.ok(!all.includes(hidden), `facts must not include ${hidden}`);
    }
    const { system, user } = socialPostPrompt(facts, ['"#bad tag" is not a valid hashtag.']);
    assert.match(system, /never about one property/);
    assert.match(user, /area\.zip \(ZIP code\): 33180/);
    assert.match(user, /rejected for these reasons/);
  });

  it('drops the roll\'s "unincorporated" placeholder instead of using it as a city', () => {
    const unincorporated = areaFacts({ ...parcel, situs: { ...parcel.situs, city: 'UNINCORPORATED COUNTY' } }, agent);
    assert.ok(!unincorporated.some((f) => f.key === 'area.city'));
  });

  it('accepts a grounded, signed post about the agent and the area', () => {
    assert.deepEqual(problems(good), []);
  });

  it('rejects a post that names the property, its street or its owner', () => {
    for (const caption of [`${good.caption} Like the home at 100 Example Way.`, `${good.caption} Homes on Example Way are special.`, `${good.caption} Hello Test Holdings LLC.`]) {
      assert.ok(problems({ ...good, caption }).includes('reveals_subject'), caption);
    }
    assert.ok(problems({ ...good, imageBrief: 'The house at 100 Example Way at dusk.' }).includes('reveals_subject'));
    assert.ok(problems({ ...good, caption: `${good.caption} See 100 Example soon.` }).includes('reveals_subject'), 'number with the start of the street');
  });

  it('does not mistake a ZIP code that equals the house number for the address', () => {
    const sameNumber = { address: '33180 SAMPLE AVE', ownerName: 'TEST HOLDINGS LLC' };
    assert.deepEqual(checkSocialPost(good, facts, agent, sameNumber).map((x) => x.code), []);
  });

  it('requires the brokerage and agent name, and rejects invented figures, prohibited words and bad hashtags', () => {
    assert.ok(problems({ ...good, caption: 'I help homeowners in 33180. Send me a message.' }).includes('missing_brokerage'));
    assert.ok(problems({ ...good, caption: `${good.caption} Prices rose 12% this year.` }).includes('unsupported_figure'));
    assert.ok(problems({ ...good, caption: `${good.caption} Perfect for families, act now!` }).includes('prohibited_term'));
    assert.ok(problems({ ...good, hashtags: ['#ok', 'no hash', '#has space'] }).includes('bad_hashtag'));
    assert.ok(problems({ ...good, factsUsed: ['owner.name'] }).includes('unknown_fact'));
  });

  it('parses a model reply strictly', () => {
    const parsed = parseSocialPost(extractJson(`Here you go:\n${JSON.stringify(good)}`));
    assert.ok(parsed.ok && parsed.value.hashtags.length === 3);
    assert.equal(parseSocialPost({ ...good, caption: '' }).ok, false);
    assert.equal(parseSocialPost({ ...good, hashtags: 'nope' }).ok, false);
  });

  it('wraps the image brief in fixed rules: no people, no text, no single identifiable house', () => {
    const prompt = neighborhoodImagePrompt(good.imageBrief, facts);
    assert.match(prompt, /Aventura, Miami-Dade County, Florida/);
    assert.match(prompt, /no people/);
    assert.match(prompt, /no text, letters, numbers, signs/);
    assert.match(prompt, /never a single identifiable house/);
    assert.ok(prompt.includes(good.imageBrief));
  });
});

describe('Film Crew budget and uploads', () => {
  it('stops before a step that would take a campaign over its media budget', () => {
    const fits = checkMediaBudget(0.9, 0.05);
    assert.ok(fits.ok && Math.abs(fits.value - 0.05) < 1e-9);
    const over = checkMediaBudget(0.98, 0.0336);
    assert.equal(over.ok, false);
    assert.match(over.ok ? '' : over.message, /used \$0\.98 of its \$1\.00 media budget/);
    assert.equal(checkMediaBudget(0, 1).ok, true, 'exactly the cap is allowed');
  });

  it('recognises PNG, JPEG and WebP by their bytes, not their names', () => {
    assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffImageType(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), null);
    assert.equal(sniffImageType(new Uint8Array([])), null);
  });
});
