// PR2 PushDeer 告警接入
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 11
// 实现参考：/Users/roxor/brain/30-projects/xueqiuFollow/src/notifier.py

import type { Env } from './index';

const PUSHDEER_ENDPOINT = 'https://api2.pushdeer.com/message/push';

export async function pushDeerAlert(
  env: Env,
  title: string,
  body: string,
): Promise<void> {
  const keysCsv = env.PUSHDEER_ADMIN_KEYS;
  if (!keysCsv) {
    console.warn('[notifier] PUSHDEER_ADMIN_KEYS not set, skip alert');
    return;
  }

  const keys = keysCsv.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return;

  const fullTitle = `xList告警 | ${title}`;

  await Promise.allSettled(
    keys.map(async (key) => {
      try {
        const r = await fetch(PUSHDEER_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            pushkey: key,
            text: fullTitle,
            desp: body,
            type: 'markdown',
          }),
        });
        if (!r.ok) {
          console.error(`[pushdeer] ${r.status}`, await r.text());
          return;
        }
        const data = await r.json<{ code?: number; error?: string }>();
        if (data.code !== 0) {
          console.error('[pushdeer]', data);
        }
      } catch (e) {
        console.error('[pushdeer] exception', e);
      }
    }),
  );
}
