import { describe, expect, test } from 'vitest';

import { parseManualNewsKeyring } from './manual-news-keyring';

const CURRENT_SECRET = '11'.repeat(32);
const OLD_SECRET = '22'.repeat(32);

describe('manual news keyring configuration', () => {
  test('retains bounded historical keys while selecting the explicit current key', () => {
    const keyring = parseManualNewsKeyring({
      keyId: 'current-2026-08',
      secret: CURRENT_SECRET,
      keyringJson: JSON.stringify([{ id: 'old-2026-07', secret: OLD_SECRET }]),
    });

    expect(keyring.currentKeyId).toBe('current-2026-08');
    expect([...keyring.keys]).toEqual([
      ['current-2026-08', CURRENT_SECRET],
      ['old-2026-07', OLD_SECRET],
    ]);
  });

  test.each([
    ['duplicate ID', [{ id: 'current-2026-08', secret: OLD_SECRET }]],
    ['duplicate secret', [{ id: 'old-2026-07', secret: CURRENT_SECRET }]],
    ['extra field', [{ id: 'old-2026-07', secret: OLD_SECRET, active: false }]],
    ['too many retained keys', Array.from({ length: 9 }, (_, index) => ({
      id: `old-${index}`,
      secret: (index + 2).toString(16).padStart(2, '0').repeat(32),
    }))],
  ])('rejects %s without exposing key material', (_name, entries) => {
    let message = '';
    try {
      parseManualNewsKeyring({
        keyId: 'current-2026-08', secret: CURRENT_SECRET, keyringJson: JSON.stringify(entries),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('manual_news_keys_unavailable');
    expect(message).not.toContain(CURRENT_SECRET);
    expect(message).not.toContain(OLD_SECRET);
  });

  test.each([
    ['', CURRENT_SECRET],
    ['UPPERCASE', CURRENT_SECRET],
    ['valid-id', 'AA'.repeat(32)],
    ['valid-id', 'too-short'],
  ])('rejects invalid current key configuration', (keyId, secret) => {
    expect(() => parseManualNewsKeyring({ keyId, secret }))
      .toThrowError('manual_news_keys_unavailable');
  });
});
