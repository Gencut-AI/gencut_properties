import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanText } from './lint.ts';

// Planted keys are assembled at runtime so this file never contains one.
const fake = {
  anthropic: ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-'),
  openai: 'sk-' + 'proj-' + 'B'.repeat(40),
  aws: 'AKIA' + 'C'.repeat(16),
  github: 'ghp_' + 'D'.repeat(36),
  privateKey: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
};

describe('repository lint', () => {
  for (const [name, key] of Object.entries(fake)) {
    it(`catches a planted ${name} secret`, () => {
      const findings = scanText('apps/web/src/config.ts', `const k = "${key}";`);
      assert.equal(findings.length, 1, name);
    });
  }

  it('ignores ordinary code and the env example names', () => {
    assert.deepEqual(scanText('.env.example', 'ANTHROPIC_API_KEY=\nOPENAI_API_KEY='), []);
    assert.deepEqual(scanText('packages/core/src/x.ts', 'export const skipped = "sk-short";'), []);
  });

  it('rejects hard-coded model names in domain code only', () => {
    const line = "const model = 'claude-sonnet-5-5';";
    assert.equal(scanText('packages/core/src/agents/strategy.ts', line)[0]?.rule, 'model-name-in-domain');
    assert.deepEqual(scanText('config/models.ts', line), []);
  });

  it('rejects console output in domain code', () => {
    assert.equal(scanText('packages/core/src/a.ts', 'console.log(x)')[0]?.rule, 'console-in-domain');
  });
});
