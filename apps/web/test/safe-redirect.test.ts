import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeNextPath } from '../lib/safe-redirect.ts';

describe('safeNextPath', () => {
  it('keeps same-site paths', () => {
    assert.equal(safeNextPath('/home'), '/home');
    assert.equal(safeNextPath('/profile?saved=1'), '/profile?saved=1');
  });

  it('falls back for anything that could leave the site', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'home', '', null, undefined, 'javascript:alert(1)']) {
      assert.equal(safeNextPath(bad), '/home', String(bad));
    }
  });
});
