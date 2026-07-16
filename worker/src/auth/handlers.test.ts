import { beforeEach, describe, expect, it, vi } from 'vitest';

const authDependencies = vi.hoisted(() => ({
  verifyTurnstile: vi.fn(async () => true),
  checkRateLimits: vi.fn(async () => ({ ok: true as const })),
  checkAndIncrDailyCap: vi.fn(async () => ({ ok: true, sent: 1, cap: 200 })),
  checkDailyCapAlerts: vi.fn(async () => undefined),
  generateCode: vi.fn(() => '123456'),
  hashCode: vi.fn(async () => 'code-hash'),
  sendSmsViaTencent: vi.fn(async () => ({ ok: true as const, requestId: 'request-id' })),
}));

vi.mock('./turnstile', () => ({
  verifyTurnstile: authDependencies.verifyTurnstile,
}));

vi.mock('./sms', () => ({
  checkRateLimits: authDependencies.checkRateLimits,
  checkAndIncrDailyCap: authDependencies.checkAndIncrDailyCap,
  checkDailyCapAlerts: authDependencies.checkDailyCapAlerts,
  generateCode: authDependencies.generateCode,
  hashCode: authDependencies.hashCode,
  sendSmsViaTencent: authDependencies.sendSmsViaTencent,
}));

import { handleEmailSend } from './email-handlers';
import { handleMe, handleSmsSend } from './handlers';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://api.example.com/api/auth/sms/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': 'device-12345678',
    },
    body: JSON.stringify(body),
  });
}

function makeRuntime(enableSmsLogin?: string) {
  const statement = {
    bind: vi.fn(),
    run: vi.fn(async () => ({ success: true })),
  };
  statement.bind.mockReturnValue(statement);

  const env = {
    ENABLE_SMS_LOGIN: enableSmsLogin,
    DB: { prepare: vi.fn(() => statement) },
  };
  const ctx = { waitUntil: vi.fn() };

  return { env, ctx };
}

describe('handleSmsSend feature flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([undefined, '', 'false', 'TRUE', '1'])(
    'fails closed with zero side effects when ENABLE_SMS_LOGIN=%s',
    async (enableSmsLogin) => {
      const { env, ctx } = makeRuntime(enableSmsLogin);

      const response = await handleSmsSend(
        makeRequest({ phone: '13800138000', turnstile_token: 'token' }),
        env as never,
        ctx as never,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'sms login disabled',
        reason: 'sms_disabled',
      });
      expect(authDependencies.verifyTurnstile).not.toHaveBeenCalled();
      expect(authDependencies.checkRateLimits).not.toHaveBeenCalled();
      expect(authDependencies.checkAndIncrDailyCap).not.toHaveBeenCalled();
      expect(authDependencies.checkDailyCapAlerts).not.toHaveBeenCalled();
      expect(authDependencies.generateCode).not.toHaveBeenCalled();
      expect(authDependencies.hashCode).not.toHaveBeenCalled();
      expect(authDependencies.sendSmsViaTencent).not.toHaveBeenCalled();
      expect(env.DB.prepare).not.toHaveBeenCalled();
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    },
  );

  it('preserves the existing request validation when SMS login is explicitly enabled', async () => {
    const { env, ctx } = makeRuntime('true');
    const request = new Request('https://api.example.com/api/auth/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000', turnstile_token: 'token' }),
    });

    const response = await handleSmsSend(request, env as never, ctx as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'missing or invalid X-Device-Id' });
  });

  it('does not apply the SMS flag to the email send handler', async () => {
    const { env, ctx } = makeRuntime('false');
    const request = new Request('https://api.example.com/api/auth/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'device-12345678',
      },
      body: JSON.stringify({ email: 'not-an-email', turnstile_token: 'token' }),
    });

    const response = await handleEmailSend(request, env as never, ctx as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid email' });
  });
});

describe('handleMe anonymous discovery', () => {
  it('returns a successful nullable session result instead of a console-visible 401', async () => {
    const { env, ctx } = makeRuntime();
    const response = await handleMe(
      new Request('https://api.example.com/api/auth/me'),
      env as never,
      ctx as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ user: null });
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
});
