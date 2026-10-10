/** Query-only bounds; the persisted episodic-tokens-v1 index remains unchanged. */
export function tokenizeMemoryText(text: string): readonly string[] {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024) return [];
  const normalized = text.normalize('NFKC').toLowerCase();
  if (Buffer.byteLength(normalized, 'utf8') > 1024) return [];
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/\p{Script=Han}+|[a-z0-9_]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars.slice(i, i + 2).join(''));
    } else if (/[a-z0-9]/u.test(word)) tokens.push(word);
    if (tokens.length > 64) return [];
  }
  return tokens;
}

export function buildMemoryMatchQuery(text: string): string | null {
  const tokens = tokenizeMemoryText(text);
  // Allowed characters cannot contain quotes. Quotes make FTS operators literal terms.
  return tokens.length === 0 ? null : tokens.map(token => `"${token}"`).join(' OR ');
}
