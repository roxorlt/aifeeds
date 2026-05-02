import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import * as authApi from '../lib/auth';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';

const TURNSTILE_SITE_KEY = '0x4AAAAAADHQ15rM-NnOZ2zL';
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const PHONE_REGEX = /^1[3-9]\d{9}$/;

/** dev 环境检测：localhost / 127.0.0.1 跳过 Turnstile widget（dev worker 也 bypass 服务端校验） */
function isDevHost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

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

export function LoginModal() {
  const open = useAuthStore((s) => s.loginModalOpen);
  const trigger = useAuthStore((s) => s.loginTrigger);
  const closeModal = useAuthStore((s) => s.closeLoginModal);
  const onLoginSuccess = useAuthStore((s) => s.onLoginSuccess);

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);   // 是否已成功发出验证码
  const [loading, setLoading] = useState(false);
  const [phoneError, setPhoneError] = useState('');  // 紧挨手机号输入框的提示
  const [codeError, setCodeError] = useState('');    // 紧挨验证码输入框的提示
  const [cooldownSec, setCooldownSec] = useState(0);

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const dev = isDevHost();

  // open 改 true：上报埋点 + reset 状态
  useEffect(() => {
    if (!open) return;
    track(EVENTS.LOGIN_MODAL_OPEN, { trigger_action: trigger });
    setPhone('');
    setCode('');
    setTurnstileToken(dev ? 'dev-bypass' : null);  // dev 模式直接给 fake token
    setCodeSent(false);
    setLoading(false);
    setPhoneError('');
    setCodeError('');
    setCooldownSec(0);
  }, [open, trigger, dev]);

  // open + 非 dev：加载 + render Turnstile widget
  useEffect(() => {
    if (!open || dev) return;
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
        setPhoneError(`captcha 加载失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dev]);

  // 倒计时
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setTimeout(() => setCooldownSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  async function handleSendCode() {
    setPhoneError('');
    setCodeError('');
    if (!PHONE_REGEX.test(phone)) {
      setPhoneError('请输入正确的手机号');
      return;
    }
    if (!turnstileToken) {
      setPhoneError('请先完成人机验证');
      return;
    }
    setLoading(true);
    track(EVENTS.SMS_SEND_ATTEMPT, {});
    try {
      await authApi.sendSmsCode(phone, turnstileToken);
      track(EVENTS.SMS_SEND_SUCCESS, {});
      setCodeSent(true);
      setCooldownSec(60);
    } catch (e) {
      const a = e as AuthError;
      let msg = a.message;
      if (a.status === 429 && a.reason === 'phone_60s_limit') msg = '请稍候再试（60 秒内只能发 1 次）';
      else if (a.status === 429 && a.reason === 'phone_24h_limit') msg = '今日发送次数过多，请明天再试';
      else if (a.status === 429 && a.reason === 'phone_locked_30min') msg = '账户已临时锁定，请 30 分钟后再试';
      else if (a.status === 503) msg = '服务暂不可用，请稍后再试';
      else if (a.status === 403) msg = '人机验证失败，请重试';
      setPhoneError(msg);
      // 真 widget 时 token 已被消费，reset
      if (!dev && turnstileWidgetId && window.turnstile) {
        window.turnstile.reset(turnstileWidgetId);
        setTurnstileToken(null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin() {
    setCodeError('');
    if (!/^\d{6}$/.test(code)) {
      setCodeError('验证码必须是 6 位数字');
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
      setCodeError(msg);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const sendDisabled = loading || !phone || !turnstileToken || cooldownSec > 0;
  const loginDisabled = loading || !codeSent || code.length !== 6;

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

        {/* 手机号 + 获取验证码 */}
        <label className="mb-1 block text-sm text-neutral-700">手机号</label>
        <div className="flex gap-2">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
            placeholder="请输入手机号"
            disabled={codeSent && cooldownSec > 0}
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-500"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSendCode}
            disabled={sendDisabled}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cooldownSec > 0
              ? `${cooldownSec}s`
              : loading && !codeSent
              ? '发送中…'
              : codeSent
              ? '重发'
              : '获取验证码'}
          </button>
        </div>
        {phoneError && (
          <p className="mt-1 text-xs text-rose-600">{phoneError}</p>
        )}

        {/* Turnstile widget — dev 不渲染 */}
        {!dev && (
          <div ref={turnstileContainerRef} className="mt-3 flex justify-center" />
        )}

        {/* 验证码 — 始终显示，未发码时 disabled */}
        <label className="mb-1 mt-3 block text-sm text-neutral-700">验证码</label>
        <input
          type="tel"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="请输入验证码"
          disabled={!codeSent}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-400"
        />
        {codeError && (
          <p className="mt-1 text-xs text-rose-600">{codeError}</p>
        )}

        {/* 登录按钮 */}
        <button
          type="button"
          onClick={handleLogin}
          disabled={loginDisabled}
          className="mt-4 w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          {loading && codeSent ? '登录中…' : '登录 / 注册'}
        </button>

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
