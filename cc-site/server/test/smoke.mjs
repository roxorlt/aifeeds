// 本地冒烟测试（零依赖）。不碰真微信 API / worker，只验证：
//   - crypto 模块：飞行态签名往返 + 篡改检测 + bridge HMAC 格式
//   - /start：合法 return_to → 302 到微信 + Set-Cookie；非法 return_to → error
//   - /callback：无 code / 无 cookie / 篡改 cookie / state 不匹配 → 各自 error
//   - /health → 200
//
// 真微信换 openid + worker exchange 那两步要真凭据，放 staging 联调验。
//
// 跑：node test/smoke.mjs（会用假 env 起一个临时 server 在 127.0.0.1:13901）

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 13901;
const BASE = `http://127.0.0.1:${PORT}`;

const FAKE_ENV = {
  ...process.env,
  PORT: String(PORT),
  WECHAT_OPEN_APP_ID: 'wx_test_appid_123',
  WECHAT_OPEN_APP_SECRET: 'test_secret_32_chars_xxxxxxxxxxx',
  BRIDGE_SECRET: 'test_bridge_secret_hex_64_chars_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  STATE_SECRET: 'test_state_secret_hex_64_chars_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  RETURN_TO_ALLOWLIST: 'https://ai-feeds.com/',
  COM_LOGIN_URL: 'https://ai-feeds.com/login',
  COM_CALLBACK_URL: 'https://ai-feeds.com/auth/callback',
};

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

// ── 1. crypto 单元 ──
async function testCrypto() {
  console.log('\n=== crypto 模块 ===');
  const { signFlightState, verifyFlightState, buildBridgeHeaders, sha256Hex, hmacSha256Hex } =
    await import('../lib/crypto.mjs');

  const secret = 'unit_test_secret';
  const payload = { return_to: 'https://ai-feeds.com/feed', device_id: 'dev123', nonce: 'abc', ts: 1700000000 };
  const token = signFlightState(payload, secret);
  const back = verifyFlightState(token, secret);
  check('飞行态签名往返一致', back && back.return_to === payload.return_to && back.nonce === 'abc');

  check('错误密钥验签失败', verifyFlightState(token, 'wrong_secret') === null);

  const [p, s] = token.split('.');
  const tampered = `${p}X.${s}`;
  check('篡改 payload 验签失败', verifyFlightState(tampered, secret) === null);
  check('篡改 sig 验签失败', verifyFlightState(`${p}.${s.slice(0, -2)}00`, secret) === null);

  // bridge HMAC 与 worker 端一致性：HMAC(secret, ts + "." + sha256(body))
  const body = '{"openid":"o123"}';
  const h = buildBridgeHeaders(body, secret, 1700000000);
  const expectSig = hmacSha256Hex(secret, `1700000000.${sha256Hex(body)}`);
  check('bridge 签名公式与 worker 端一致', h['X-Bridge-Signature'] === expectSig);
  check('bridge 时间戳头正确', h['X-Bridge-Timestamp'] === '1700000000');
}

// ── 2. server 集成 ──
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(__dirname, '..', 'relay.mjs')], {
      env: FAKE_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening')) resolve(child);
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    child.on('exit', (c) => { if (c !== 0 && !out.includes('listening')) reject(new Error(`server exit ${c}: ${out}`)); });
    setTimeout(() => reject(new Error('server 启动超时')), 5000);
  });
}

async function testServer() {
  console.log('\n=== server 集成 ===');
  const child = await startServer();
  try {
    // health
    const health = await fetch(`${BASE}/auth/wechat/health`);
    check('/health 返回 200', health.status === 200);

    // /start 合法 return_to
    const start = await fetch(
      `${BASE}/auth/wechat/start?return_to=${encodeURIComponent('https://ai-feeds.com/feed')}&device_id=devABC`,
      { redirect: 'manual' },
    );
    check('/start 返回 302', start.status === 302);
    const loc = start.headers.get('location') || '';
    check('/start 跳微信 qrconnect', loc.startsWith('https://open.weixin.qq.com/connect/qrconnect'));
    check('/start 带 appid', loc.includes('appid=wx_test_appid_123'));
    check('/start scope=snsapi_login', loc.includes('scope=snsapi_login'));
    const setCookie = start.headers.get('set-cookie') || '';
    check('/start 设置 wx_oauth cookie', setCookie.includes('wx_oauth='));
    check('/start cookie HttpOnly+Secure+SameSite=Lax',
      /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
    // state nonce 应该出现在 location，且短（非整个 return_to）
    const stateMatch = loc.match(/[?&]state=([^&#]+)/);
    check('/start state 是短 nonce（≤40 字符）', stateMatch && decodeURIComponent(stateMatch[1]).length <= 40);

    // /start 非法 return_to
    const badStart = await fetch(
      `${BASE}/auth/wechat/start?return_to=${encodeURIComponent('https://evil.com/x')}`,
      { redirect: 'manual' },
    );
    const badLoc = badStart.headers.get('location') || '';
    check('/start 非法 return_to → error=bad_return', badLoc.includes('error=bad_return'));

    // /callback 无 code
    const noCode = await fetch(`${BASE}/auth/wechat/callback?state=x`, { redirect: 'manual' });
    check('/callback 无 code → error=wechat_denied',
      (noCode.headers.get('location') || '').includes('error=wechat_denied'));

    // /callback 有 code 但无 cookie
    const noCookie = await fetch(`${BASE}/auth/wechat/callback?code=abc&state=x`, { redirect: 'manual' });
    check('/callback 无 cookie → error=state_invalid',
      (noCookie.headers.get('location') || '').includes('error=state_invalid'));

    // /callback 篡改 cookie
    const badCookie = await fetch(`${BASE}/auth/wechat/callback?code=abc&state=x`, {
      redirect: 'manual',
      headers: { Cookie: 'wx_oauth=garbage.deadbeef' },
    });
    check('/callback 篡改 cookie → error=state_invalid',
      (badCookie.headers.get('location') || '').includes('error=state_invalid'));

    // /callback state 不匹配（用真签名 cookie 但 state 给错）
    const { signFlightState } = await import('../lib/crypto.mjs');
    const realFlight = signFlightState(
      { return_to: 'https://ai-feeds.com/feed', device_id: '', nonce: 'realnonce', ts: Math.floor(Date.now() / 1000) },
      FAKE_ENV.STATE_SECRET,
    );
    const mismatch = await fetch(`${BASE}/auth/wechat/callback?code=abc&state=wrongnonce`, {
      redirect: 'manual',
      headers: { Cookie: `wx_oauth=${realFlight}` },
    });
    check('/callback state≠nonce → error=state_mismatch',
      (mismatch.headers.get('location') || '').includes('error=state_mismatch'));

    // /callback 过期 cookie
    const expiredFlight = signFlightState(
      { return_to: 'https://ai-feeds.com/feed', device_id: '', nonce: 'n', ts: Math.floor(Date.now() / 1000) - 9999 },
      FAKE_ENV.STATE_SECRET,
    );
    const expired = await fetch(`${BASE}/auth/wechat/callback?code=abc&state=n`, {
      redirect: 'manual',
      headers: { Cookie: `wx_oauth=${expiredFlight}` },
    });
    check('/callback 过期 → error=state_expired',
      (expired.headers.get('location') || '').includes('error=state_expired'));

    // 404
    const notFound = await fetch(`${BASE}/auth/wechat/nope`, { redirect: 'manual' });
    check('未知路径 → 404', notFound.status === 404);
  } finally {
    child.kill();
  }
}

await testCrypto();
await testServer();

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${passed} / 失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
