import { describe, expect, it } from 'vitest';
import { buildMemoryMatchQuery, tokenizeMemoryText } from '../src/memory/chinese-tokenizer.js';

describe('bounded memory query tokens', () => {
  it.each([
    ['连接池 timeout', ['连接', '接池', 'timeout']],
    ['ＴＩＭＥＯＵＴ Pool_WAIT １２', ['timeout', 'pool_wait', '12']],
    ['𠮷连接 😀 池', ['𠮷连', '连接']],
    ['!!! 😀 单', []],
  ])('normalizes %s without breaking Unicode code points', (text, tokens) => {
    expect(tokenizeMemoryText(text)).toEqual(tokens);
  });
  it('quotes every term so operators, quotes and punctuation are data', () => {
    expect(buildMemoryMatchQuery('"timeout" OR NEAR(foo) -bar*')).toBe('"timeout" OR "or" OR "near" OR "foo" OR "bar"');
    expect(buildMemoryMatchQuery('!!!')).toBeNull();
  });
  it('rejects inputs beyond 1 KiB UTF-8 or 64 tokens', () => {
    expect(tokenizeMemoryText('界'.repeat(342))).toEqual([]);
    expect(buildMemoryMatchQuery('a '.repeat(65))).toBeNull();
    expect(tokenizeMemoryText('a '.repeat(64))).toHaveLength(64);
    expect(tokenizeMemoryText('a'.repeat(1024))).toHaveLength(1);
    expect(buildMemoryMatchQuery('a'.repeat(1025))).toBeNull();
  });
});
