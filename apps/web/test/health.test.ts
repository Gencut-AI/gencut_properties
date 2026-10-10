import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getHealth } from '../lib/health.ts';

const now = () => new Date('2026-10-10T18:00:00Z');

describe('health report', () => {
  it('is ok without a database configured', async () => {
    const h = await getHealth({ GENCUT_VERSION: '0.1.0' }, async () => true, now);
    assert.deepEqual(h, {
      status: 'ok',
      version: '0.1.0',
      commit: null,
      database: 'not_configured',
      checkedAt: '2026-10-10T18:00:00.000Z',
    });
  });

  it('reports a reachable database', async () => {
    const h = await getHealth({ DATABASE_URL: 'postgres://x', GENCUT_COMMIT: 'abcdef1234567890' }, async () => true, now);
    assert.equal(h.status, 'ok');
    assert.equal(h.database, 'reachable');
    assert.equal(h.commit, 'abcdef123456');
  });

  it('degrades when the probe fails or throws, without leaking details', async () => {
    const failed = await getHealth({ DATABASE_URL: 'postgres://secret@host/db' }, async () => false, now);
    assert.equal(failed.status, 'degraded');
    const threw = await getHealth(
      { DATABASE_URL: 'postgres://secret@host/db' },
      async () => {
        throw new Error('password authentication failed for secret');
      },
      now,
    );
    assert.equal(threw.database, 'unreachable');
    assert.ok(!JSON.stringify(threw).includes('secret'));
  });
});
