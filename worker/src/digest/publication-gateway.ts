/**
 * Physical daily publication objects are never public R2 assets. Public daily
 * page/video routes resolve an authorized D1 release head and verify the full
 * object bytes before returning a response.
 */
export interface VirtualDailyVideoKey {
  video_publication_id: string;
  role: 'mp4' | 'poster' | 'vtt';
}

export function parseVirtualDailyVideoKey(key: string): VirtualDailyVideoKey | null {
  const match = key.match(/^daily-video\/public\/([0-9a-f]{64})\/(mp4|poster|vtt)$/);
  return match ? {
    video_publication_id: match[1],
    role: match[2] as VirtualDailyVideoKey['role'],
  } : null;
}

function privateShape(key: string): boolean {
  if (parseVirtualDailyVideoKey(key)) return false;
  return key.startsWith('daily/versions/')
    || key.startsWith('daily/publications/')
    || /^daily\/\d{4}-\d{2}-\d{2}\.html$/.test(key)
    || key.startsWith('daily-video/');
}

export function isPrivateDailyPublicationKey(key: string): boolean {
  const normalized = key.normalize('NFC');
  if (privateShape(normalized)) return true;
  try {
    const decoded = decodeURIComponent(normalized).normalize('NFC');
    if (decoded.includes('\\') || decoded.split('/').some((part) => part === '..' || part === '.')) {
      return decoded.startsWith('daily') || decoded.startsWith('daily-video');
    }
    return decoded !== normalized && privateShape(decoded);
  } catch {
    return normalized.startsWith('daily') || normalized.startsWith('daily-video');
  }
}
