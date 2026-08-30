import { describe, expect, test } from 'vitest';
import { safeDailyDeliveryError } from './daily-delivery-error';

describe('daily delivery safe errors', () => {
  test('redacts bearer credentials before a one-character configured secret without leaving a partial marker', () => {
    const output = safeDailyDeliveryError(
      'transport B Bearer bearer-sentinel failed',
      ['B'],
    );

    expect(output).toContain('transport');
    expect(output).not.toContain('B');
    expect(output).not.toContain('bearer-sentinel');
    expect(output).not.toMatch(/earer/i);
  });

  test.each([
    ['exact status secret', 'http_502'],
    ['status fragment secret', '502'],
  ])('does not derive a status that reproduces a configured %s', (_label, secret) => {
    const output = safeDailyDeliveryError(
      'gateway http_502: raw-upstream-body-sentinel',
      [secret],
    );

    expect(output).toBe('http_error');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('raw-upstream-body-sentinel');
  });

  test('ignores empty configured secrets', () => {
    expect(safeDailyDeliveryError('transport failed', ['', null, undefined]))
      .toBe('transport failed');
  });

  test('redacts regex metacharacters as literal configured secret text', () => {
    const output = safeDailyDeliveryError('transport a+b? failed', ['a+b?']);

    expect(output).toBe('transport failed');
    expect(output).not.toContain('a+b?');
  });

  test('redacts regular bearer, credentialed URL, query, and relevant environment values', () => {
    const output = safeDailyDeliveryError(
      'transport Bearer regular-bearer env-token review-secret '
      + 'https://url-user:url-pass@example.test/private?token=query-secret failed',
      ['env-token', 'review-secret'],
    );

    expect(output).toContain('transport');
    expect(output).toContain('failed');
    for (const sentinel of [
      'regular-bearer', 'env-token', 'review-secret', 'url-user', 'url-pass',
      'example.test', 'query-secret',
    ]) expect(output).not.toContain(sentinel);
  });

  test('keeps a safe stable HTTP status while dropping the raw upstream body', () => {
    const output = safeDailyDeliveryError(
      `gateway http_503: upstream-body-sentinel ${'x'.repeat(700)}`,
      ['unrelated-secret'],
    );

    expect(output).toBe('http_503');
    expect(output).not.toContain('upstream-body-sentinel');
  });

  test('caps output at 500 code points even when the caller requests a larger limit', () => {
    const output = safeDailyDeliveryError(`transport ${'界'.repeat(700)}`, [], 5_000);

    expect(Array.from(output)).toHaveLength(500);
  });
});
