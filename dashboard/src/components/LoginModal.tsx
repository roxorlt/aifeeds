import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import * as authApi from '../lib/auth';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';

const TURNSTILE_SITE_KEY = '0x4AAAAAADHQ15rM-NnOZ2zL';
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const PHONE_REGEX = /^1[3-9]\d{9}$/;

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          theme?: 'auto' | 'light' | 'dark';
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

let scriptLoaded = false;
async function loadTurnstileScript(): Promise<void> {
  if (scriptLoaded || window.turnstile) {
    scriptLoaded = true;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      scriptLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('turnstile script load failed'));
    document.head.appendChild(script);
  });
}

type Phase = 'phone' | 'code';

export function LoginModal() {
  const open = useAuthStore((s) => s.loginModalOpen);
  const trigger = useAuthStore((s) => s.loginTrigger);
  const closeModal = useAuthStore((s) => s.closeLoginModal);
  const onLoginSuccess = useAuthStore((s) => s.onLoginSuccess);

  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [cooldownSec, setCooldownSec] = useState(0);

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);

  // open 改 true：上报埋点 + reset 状态
  useEffect(() => {
    if (!open) return;
    track(EVENTS.LOGIN_MODAL_OPEN, { trigger_action: trigger });
    setPhase('phone');
    setPhone('');
    setCode('');
    setTurnstileToken(null);
    setLoading(false);
    setErrorMsg('');
    setCooldownSec(0);
  }, [open, trigger]);

  // open 阶段 phone：加载 + render Turnstile
  useEffect(() => {
    if (!open || phase !== 'phone') return;
    let cancelled = false;
    (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || !turnstileContainerRef.current || !window.turnstile) return;
        if (turnstileWidgetId) {
          window.turnstile.reset(turnstileWidgetId);
          setTurnstileToken(null);
          return;
        }
        const id = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'auto',
          callback: (token: string) => setTurnstileToken(token),
          'error-callback': () => setTurnstileToken(null),
          'expired-callback': () => setTurnstileToken(null),
        });
        setTurnstileWidgetId(id);
      } catch (e) {
        setErrorMsg(`captcha 加载失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase]);

  // 倒计时
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setTimeout(() => setCooldownSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  async function handleSendCode() {
    setErrorMsg('');
    if (!PHONE_REGEX.test(phone)) {
      setErrorMsg('手机号格式不对');
      return;
    }
    if (!turnstileToken) {
      setErrorMsg('请先完成人机验证');
      return;
    }
    setLoading(true);
    track(EVENTS.SMS_SEND_ATTEMPT, {});
    try {
      await authApi.sendSmsCode(phone, turnstileToken);
      track(EVENTS.SMS_SEND_SUCCESS, {});
      setPhase('code');
      setCooldownSec(60);
    } catch (e) {
      const a = e as AuthError;
      let msg = a.message;
      if (a.status === 429 && a.reason === 'phone_60s_limit') msg = '请稍候再试（60 秒内只能发 1 次）';
      else if (a.status === 429 && a.reason === 'phone_24h_limit') msg = '今日发送次数过多，请明天再试';
      else if (a.status === 429 && a.reason === 'phone_locked_30min') msg = '账户已临时锁定，请 30 分钟后再试';
      else if (a.status === 503) msg = '服务暂不可用，请稍后再试';
      else if (a.status === 403) msg = '人机验证失败，请重试';
      setErrorMsg(msg);
      if (turnstileWidgetId && window.turnstile) {
        window.turnstile.reset(turnstileWidgetId);
        setTurnstileToken(null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin() {
    setErrorMsg('');
    if (!/^\d{6}$/.test(code)) {
      setErrorMsg('验证码必须是 6 位数字');
      return;
    }
    setLoading(true);
    track(EVENTS.CODE_VERIFY_ATTEMPT, {});
    try {
      const data = await authApi.login(phone, code);
      track(EVENTS.LOGIN_SUCCESS, { is_new_user: data.user.is_new, login_method: 'phone-sms' });
      await onLoginSuccess(data.user);
    } catch (e) {
      const a = e as AuthError;
      let msg = a.message;
      if (a.status === 401 && /code expired/i.test(msg)) msg = '验证码已过期，请重新获取';
      else if (a.status === 401 && /no pending code/i.test(msg)) msg = '请先点「获取验证码」';
      else if (a.status === 401 && a.attemptsRemaining !== undefined) {
        msg = `验证码错误，还可尝试 ${a.attemptsRemaining} 次`;
      } else if (a.status === 429) msg = '尝试次数过多，账户已临时锁定 30 分钟';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900">登录 / 注册</h2>
          <button
            type="button"
            onClick={closeModal}
            className="-mr-2 rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        {phase === 'phone' && (
          <>
            <label className="mb-1 block text-sm text-neutral-700">📱 手机号</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
              placeholder="13800001234"
              className="mb-3 w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <div ref={turnstileContainerRef} className="mb-3 flex justify-center" />
            <button
              type="button"
              onClick={handleSendCode}
              disabled={loading || !phone || !turnstileToken}
              className="mb-2 w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {loading ? '发送中…' : '获取验证码'}
            </button>
          </>
        )}

        {phase === 'code' && (
          <>
            <p className="mb-3 text-sm text-neutral-600">
              已发送验证码到 <span className="font-mono">{phone}</span>
            </p>
            <label className="mb-1 block text-sm text-neutral-700">📝 6 位验证码</label>
            <input
              type="tel"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="382751"
              className="mb-3 w-full rounded-md border border-neutral-300 px-3 py-2 text-center text-2xl tracking-[.4em] focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <button
              type="button"
              onClick={handleLogin}
              disabled={loading || code.length !== 6}
              className="mb-2 w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {loading ? '登录中…' : '登录 / 注册'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (cooldownSec > 0) return;
                setPhase('phone');
                setErrorMsg('');
              }}
              disabled={cooldownSec > 0}
              className="w-full text-xs text-neutral-500 hover:text-neutral-700 disabled:cursor-not-allowed"
            >
              {cooldownSec > 0 ? `${cooldownSec}s 后可重新获取` : '重新获取验证码'}
            </button>
          </>
        )}

        {errorMsg && (
          <p className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorMsg}</p>
        )}

        <p className="mt-4 text-center text-[11px] text-neutral-500">
          登录即同意{' '}
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-700">
            隐私政策
          </a>{' '}
          和{' '}
          <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-700">
            服务条款
          </a>
        </p>
      </div>
    </div>
  );
}
