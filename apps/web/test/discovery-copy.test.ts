import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiscoveryView } from '@gencut/services';
import { discoveryHeadline, formatDay, formatMoneyShort } from '../lib/discovery-copy.ts';

const base: DiscoveryView = {
  status: 'ready',
  requestedAt: new Date(),
  finishedAt: new Date(),
  parcelsConsidered: 1683,
  parcelsQualified: 240,
  opportunityCount: 100,
  failed: false,
  coverage: [{ zip: '33180', status: 'ready', rollLabel: '2026 preliminary roll', fileDate: '2026-07-27', parcelCount: 18826 }],
};

describe('discovery copy', () => {
  it('summarises a finished run with the real counts and the source', () => {
    const h = discoveryHeadline(base, 'Miami-Dade');
    assert.equal(h.phase, 'ready');
    assert.equal(h.title, '100 opportunities');
    assert.equal(
      h.body,
      '1,683 homes in your focus area reviewed from the Florida DOR 2026 preliminary roll. 240 showed seller signals; the strongest 100 are here.',
    );
    assert.equal(h.working, false);
  });

  it('says it is reading while any ZIP is waiting for its import, and keeps refreshing', () => {
    const h = discoveryHeadline(
      { ...base, status: 'pending', coverage: [...base.coverage, { zip: '33160', status: 'pending', rollLabel: null, fileDate: null, parcelCount: null }] },
      'Miami-Dade',
    );
    assert.equal(h.phase, 'reading');
    assert.match(h.body, /Miami-Dade property roll for 33160\./);
    assert.equal(h.working, true);
  });

  it('mentions ZIPs that could not be read, and handles an empty area honestly', () => {
    const h = discoveryHeadline(
      {
        ...base,
        parcelsConsidered: 0,
        parcelsQualified: 0,
        opportunityCount: 0,
        coverage: [{ zip: '33999', status: 'failed', rollLabel: null, fileDate: null, parcelCount: null }],
      },
      'Miami-Dade',
    );
    assert.equal(h.title, 'No strong signals yet');
    assert.match(h.body, /No homes of your property types were found/);
    assert.match(h.body, /could not read the records for 33999/);
  });

  it('formats money and dates compactly and without time-zone drift', () => {
    assert.equal(formatMoneyShort(1_250_000), '$1.3M');
    assert.equal(formatMoneyShort(2_000_000), '$2M');
    assert.equal(formatMoneyShort(850_400), '$850K');
    assert.equal(formatMoneyShort(null), '—');
    assert.equal(formatDay('2026-07-27'), '27 Jul 2026');
  });
});
