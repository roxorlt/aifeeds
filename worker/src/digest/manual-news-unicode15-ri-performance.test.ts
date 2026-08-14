import { expect, test } from 'vitest';

import { segmentExtendedGraphemes15WithMetrics } from './manual-news-unicode15';

test('segments 200k regional indicators with one parity operation per boundary', () => {
  const input = '🇦'.repeat(200_000);
  const result = segmentExtendedGraphemes15WithMetrics(input);
  expect(result.segments).toHaveLength(100_000);
  expect(result.regional_indicator_boundary_checks).toBe(199_999);
});
