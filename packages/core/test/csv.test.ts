import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCsvParser } from '../src/index.ts';

function parse(chunks: string[]): string[][] {
  const rows: string[][] = [];
  const p = createCsvParser((r) => rows.push(r));
  for (const c of chunks) p.push(c);
  p.end();
  return rows;
}

/** Every way of splitting the input into two chunks must give the same rows. */
function parseAllSplits(input: string): string[][] {
  const whole = parse([input]);
  for (let i = 0; i <= input.length; i++) {
    assert.deepEqual(parse([input.slice(0, i), input.slice(i)]), whole, `split at ${i}`);
  }
  assert.deepEqual(parse([...input]), whole, 'one character per chunk');
  return whole;
}

describe('CSV parser', () => {
  it('parses plain rows with LF or CRLF and a missing final newline', () => {
    assert.deepEqual(parseAllSplits('a,b,c\n1,2,3\r\n4,,6'), [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '', '6'],
    ]);
  });

  it('handles quoted commas, escaped quotes and line breaks inside quotes', () => {
    assert.deepEqual(parseAllSplits('"x, y","say ""hi""","line1\nline2"\r\n"",z\n'), [
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['', 'z'],
    ]);
  });

  it('skips blank lines but keeps rows of empty fields', () => {
    assert.deepEqual(parseAllSplits('a\n\n,\n\r\nb\n'), [['a'], ['', ''], ['b']]);
  });

  it('keeps a quote in the middle of an unquoted field literally', () => {
    assert.deepEqual(parseAllSplits('12" PIPE,x\n'), [['12" PIPE', 'x']]);
  });
});
