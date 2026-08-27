import { describe, expect, test } from 'vitest';
import { isPrivateDailyPublicationKey, parseVirtualDailyVideoKey } from './publication-gateway';

describe('daily publication gateway namespace classifier', () => {
  test.each([
    'daily/versions/a/page.html',
    'daily/publications/a/manifest.json',
    'daily/2026-08-27.html',
    'daily%2Fversions%2Fa%2Fpage.html',
    'daily-video/candidates/a/video.mp4',
    'daily-video/private/a/poster.jpg',
    'daily-video/public/not-a-publication/mp4',
    'daily-video%2Fpublic%2Fbad%2Fmp4',
  ])('fails closed for private or malformed key %s', (key) => {
    expect(isPrivateDailyPublicationKey(key)).toBe(true);
  });

  test('recognizes only the exact virtual head-authorized media shape', () => {
    const id = 'a'.repeat(64);
    expect(isPrivateDailyPublicationKey(`daily-video/public/${id}/mp4`)).toBe(false);
    expect(parseVirtualDailyVideoKey(`daily-video/public/${id}/poster`)).toEqual({
      video_publication_id: id, role: 'poster',
    });
  });
});
