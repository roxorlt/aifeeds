import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import * as authApi from '../lib/auth';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';
import { toast } from '../lib/toast';

const TURNSTILE_SITE_KEY = '0x4AAAAAADJv6E97EmdL4BGO';
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
  const [turnstileError, setTurnstileError] = useState('');  // 人机校验自身错误（hostname 未授权 / 网络挂等）
  const [cooldownSec, setCooldownSec] = useState(0);

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);

  // open 改 true：上报埋点 + reset 状态
  useEffect(() => {
    if (!open) return;
    track(EVENTS.LOGIN_MODAL_OPEN, { trigger_action: trigger });
    setPhone('');
    setCode('');
    setTurnstileToken(null);
    setCodeSent(false);
    setLoading(false);
    setPhoneError('');
    setCodeError('');
    setCooldownSec(0);
  }, [open, trigger]);

  // open：加载 + render Turnstile widget。
  // 每次 open 都全新 render，close 时显式 remove，避免老 widgetId 失效后 reset 报错。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let createdId: string | null = null;
    (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || !turnstileContainerRef.current || !window.turnstile) return;
        const id = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'auto',
          callback: (token: string) => {
            setTurnstileToken(token);
            setTurnstileError('');
          },
          'error-callback': (code?: string) => {
            setTurnstileToken(null);
            // 600010 = sitekey 配置 / hostname 未授权；其他保留原始码，便于反馈
            const friendly =
              code === '600010'
                ? '人机校验配置异常（站点 hostname 未在 Cloudflare Turnstile 授权列表内）。请联系管理员。'
                : `人机校验失败（错误码 ${code || 'unknown'}），请刷新重试。`;
            setTurnstileError(friendly);
          },
          'expired-callback': () => setTurnstileToken(null),
        });
        createdId = id;
        setTurnstileWidgetId(id);
      } catch (e) {
        setPhoneError(`captcha 加载失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      if (createdId && window.turnstile) {
        try { window.turnstile.remove(createdId); } catch {}
      }
      setTurnstileWidgetId(null);
    };
  }, [open]);

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
      // token 已被消费，reset 让用户重过验证
      if (turnstileWidgetId && window.turnstile) {
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
      toast.success(data.user.is_new ? '注册成功' : '登录成功');
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

        {/* Turnstile widget */}
        <div ref={turnstileContainerRef} className="mt-3 flex justify-center" />
        {turnstileError && (
          <p className="mt-1 text-center text-xs text-rose-600">{turnstileError}</p>
        )}

        {/* 验证码 — 始终可点击；用户可以提前聚焦 / 粘贴。
            登录按钮的 disabled 已经依赖 codeSent + 6 位长度，
            没必要在输入框上再卡一道（卡了反而 UX 差，每次发码后才能点）。 */}
        <label className="mb-1 mt-3 block text-sm text-neutral-700">验证码</label>
        <input
          type="tel"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder={codeSent ? '请输入验证码' : '请先点击「获取验证码」'}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
        />
        {codeError && (
          <p className="mt-1 text-xs text-rose-600">{codeError}</p>
        )}

        {/* 登录按钮 */}
        <button
          type="button"
          onClick={handleLogin}
          disabled={loginDisabled}
          className="mt-4 w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
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
