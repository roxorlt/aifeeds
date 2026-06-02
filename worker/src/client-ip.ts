import type { Env } from './index';

/**
 * 取真实客户端 IP（香港中转感知）。
 *
 * 2026-06-02 香港 VPS 中转上线后，api.ai-feeds.com 的流量经 VPS 到达 worker，
 * 因此 `CF-Connecting-IP` 对每个访客都变成 VPS 的 IP。VPS 的 nginx 会把真实访客放进
 * `X-Forwarded-For`，并盖一个共享的 `X-Origin-Secret`。当该 secret 匹配（说明这一跳
 * 是我们自己的中转）时，取 XFF 的第一段为真实 IP；否则回落到 `CF-Connecting-IP`
 * （直连 CF 的流量：admin.ai-feeds.com、staging、或中转前的旧路径）。
 *
 * 把"信任 XFF"绑定到 secret 命中，可防伪造——直连 *.workers.dev 的请求无法伪造
 * `X-Origin-Secret`，因此它自带的 XFF 会被忽略，不会污染限流 / 风控。
 */
export function getClientIp(req: Request, env: Env): string {
  const xff = req.headers.get('X-Forwarded-For') || '';
  const viaRelay = !!env.ORIGIN_SECRET && req.headers.get('X-Origin-Secret') === env.ORIGIN_SECRET;
  if (viaRelay && xff) {
    return xff.split(',')[0].trim();
  }
  return req.headers.get('CF-Connecting-IP') || (xff ? xff.split(',')[0].trim() : '') || '0.0.0.0';
}
