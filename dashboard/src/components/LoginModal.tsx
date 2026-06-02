import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import * as authApi from '../lib/auth';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';
import { toast } from '../lib/toast';

const TURNSTILE_SITE_KEY = '0x4AAAAAADJyUx6JD4IMD_1i'; // ai-feeds-login-v3 widget
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WECHAT_GREEN = '#07C160'; // 微信品牌色（PM 指定；登录唯一品牌色例外）

// 微信内置浏览器：qrconnect 扫码用不了（自己扫自己），turnstile 也不稳。
// 策略：微信浏览器里只给微信登录入口 + 引导外部浏览器打开（PR4 公众号网页授权后无缝）。
function isWeChatBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /MicroMessenger/i.test(navigator.userAgent);
}

// 微信 logo（simple-icons 标准路径；UI chrome 用 SVG 不用 emoji）
function WechatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.81-.054a4.752 4.752 0 0 1-.196-1.36c0-3.36 3.27-6.085 7.302-6.085.236 0 .47.01.7.03-.63-3.276-4.04-5.755-8.252-5.755zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-3.539 0-6.41 2.42-6.41 5.404 0 2.987 2.871 5.405 6.41 5.405.733 0 1.442-.104 2.106-.298a.713.713 0 0 1 .59.082l1.452.85a.247.247 0 0 0 .127.041.244.244 0 0 0 .243-.246c0-.06-.024-.12-.04-.177l-.298-1.135a.49.49 0 0 1 .177-.553c1.31-.96 2.16-2.394 2.16-3.969 0-2.984-2.871-5.404-6.41-5.404h.001zm-2.119 2.972c.428 0 .775.353.775.787a.781.781 0 0 1-.775.786.781.781 0 0 1-.775-.786c0-.434.347-.787.775-.787zm4.238 0c.428 0 .775.353.775.787a.781.781 0 0 1-.775.786.781.781 0 0 1-.775-.786c0-.434.347-.787.775-.787z" />
    </svg>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: (code?: string) => void;
          'expired-callback'?: () => void;
          theme?: 'auto' | 'light' | 'dark';
          size?: 'normal' | 'compact' | 'flexible';
          appearance?: 'always' | 'execute' | 'interaction-only';
          retry?: 'auto' | 'never';
          'retry-interval'?: number;
          'refresh-expired'?: 'auto' | 'manual' | 'never';
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

  const wechatOnly = isWeChatBrowser();
  // 登录方式 tab：微信浏览器强制微信；其他默认微信，可切邮箱
  const [tab, setTab] = useState<'wechat' | 'email'>('wechat');
  const activeTab: 'wechat' | 'email' = wechatOnly ? 'wechat' : tab;

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [turnstileError, setTurnstileError] = useState('');
  const [cooldownSec, setCooldownSec] = useState(0);

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);

  // open 改 true：上报埋点 + reset 状态 + 回到默认 tab
  useEffect(() => {
    if (!open) return;
    track(EVENTS.LOGIN_MODAL_OPEN, { trigger_action: trigger });
    setTab('wechat');
    setEmail('');
    setCode('');
    setTurnstileToken(null);
    setCodeSent(false);
    setLoading(false);
    setPhoneError('');
    setCodeError('');
    setTurnstileError('');
    setCooldownSec(0);
  }, [open, trigger]);

  // 只在【邮箱 tab 激活】时加载 + render Turnstile（微信 tab 不带 turnstile）。
  // 切走时显式 remove，避免老 widgetId 失效后 reset 报错。
  useEffect(() => {
    if (!open || activeTab !== 'email') return;
    let cancelled = false;
    let createdId: string | null = null;
    (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || !turnstileContainerRef.current || !window.turnstile) return;
        const id = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'auto',
          size: 'flexible',
          retry: 'auto',
          'retry-interval': 8000,
          'refresh-expired': 'auto',
          callback: (token: string) => {
            setTurnstileToken(token);
            setTurnstileError('');
          },
          'error-callback': (code?: string) => {
            setTurnstileToken(null);
            const c = String(code || '');
            const map: Record<string, string> = {
              '600010': '人机校验未通过（浏览器环境被判定为异常）。请刷新重试；如反复失败，可关闭 VPN / 代理与广告拦截插件，或更换浏览器（开发者调试时请先关闭 DevTools）。',
              '300010': '人机校验已超时，请刷新页面重试。',
              '300020': '人机校验加载失败（网络受限）。如果开启了网络代理，请尝试关闭后重试。',
              '300030': '人机校验失败，请刷新页面重试。',
              '300031': '人机校验 token 异常，已自动重试。如果反复失败，请尝试刷新页面或更换浏览器；微信内置浏览器 / WebView 中可能不稳定。',
            };
            setTurnstileError(map[c] || `人机校验失败（错误码 ${c || 'unknown'}），请刷新页面重试。`);
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
      setTurnstileToken(null);
    };
  }, [open, activeTab]);

  // 倒计时
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setTimeout(() => setCooldownSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  function handleWechatLogin() {
    track('wechat_login_redirect', { trigger_action: trigger });
    // 跳到 .cc relay /start，带当前页 return_to（登录成功后回这里）
    window.location.href = authApi.wechatStartUrl(window.location.href);
  }

  async function handleSendCode() {
    setPhoneError('');
    setCodeError('');
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmed)) {
      setPhoneError('请输入正确的邮箱');
      return;
    }
    if (!turnstileToken) {
      setPhoneError('请先完成人机验证');
      return;
    }
    setLoading(true);
    track(EVENTS.SMS_SEND_ATTEMPT, { channel: 'email' });
    try {
      await authApi.sendEmailCode(trimmed, turnstileToken);
      track(EVENTS.SMS_SEND_SUCCESS, { channel: 'email' });
      setCodeSent(true);
      setCooldownSec(60);
    } catch (e) {
      const a = e as AuthError;
      let msg = a.message;
      if (a.status === 400 && a.reason === 'disposable_blocked') msg = '请使用真实邮箱（不支持临时邮箱）';
      else if (a.status === 400 && a.reason === 'mx_failed') msg = '邮箱地址无效';
      else if (a.status === 429 && a.reason === 'email_60s_limit') msg = '请稍候再试（60 秒内只能发 1 次）';
      else if (a.status === 429 && a.reason === 'email_5min_limit') msg = '请稍候再试';
      else if (a.status === 429 && a.reason === 'email_24h_limit') msg = '今日发送次数过多，请明天再试';
      else if (a.status === 429 && a.reason === 'email_locked_30min') msg = '账户已临时锁定，请 30 分钟后再试';
      else if (a.status === 503) msg = '服务暂不可用，请稍后再试';
      else if (a.status === 502) msg = '邮件服务暂时不可用，请稍后重试';
      else if (a.status === 403) msg = '人机验证失败，请重试';
      setPhoneError(msg);
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
    track(EVENTS.CODE_VERIFY_ATTEMPT, { channel: 'email' });
    try {
      const data = await authApi.login(email.trim().toLowerCase(), code);
      track(EVENTS.LOGIN_SUCCESS, { is_new_user: data.user.is_new, login_method: 'email-code' });
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

  const sendDisabled = loading || !email || !turnstileToken || cooldownSec > 0;
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

        {/* 登录方式 tab（微信浏览器只给微信，不显示切换） */}
        {!wechatOnly && (
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-neutral-100 p-1">
            <button
              type="button"
              onClick={() => setTab('wechat')}
              className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'wechat' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              微信登录
            </button>
            <button
              type="button"
              onClick={() => setTab('email')}
              className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'email' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              邮箱登录
            </button>
          </div>
        )}

        {activeTab === 'wechat' ? (
          /* ── 微信登录面板 ── */
          <div>
            {wechatOnly && (
              <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="mb-1 font-medium">微信内请在浏览器打开</div>
                <div className="text-amber-800">
                  微信内置浏览器暂不支持扫码登录。请点右上角「···」→
                  <span className="font-medium">「在浏览器打开」</span>，再用微信登录。
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(window.location.href).then(() => {
                      toast.success('链接已复制，可粘贴到浏览器打开');
                    }).catch(() => {});
                  }}
                  className="mt-2 rounded border border-amber-400 bg-white px-2 py-1 text-[11px] text-amber-900 hover:bg-amber-100"
                >
                  复制本页链接
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={handleWechatLogin}
              className="flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: WECHAT_GREEN }}
            >
              <WechatIcon className="h-5 w-5" />
              微信登录
            </button>
            <p className="mt-3 text-center text-xs text-neutral-500">
              {wechatOnly ? '在浏览器中打开后，用微信扫码即可登录' : '将跳转到微信，扫码授权后自动返回'}
            </p>
          </div>
        ) : (
          /* ── 邮箱登录面板 ── */
          <div>
            <label className="mb-1 block text-sm text-neutral-700">邮箱</label>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value.slice(0, 254))}
                placeholder="请输入邮箱"
                disabled={codeSent && cooldownSec > 0}
                className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-500"
                autoFocus
                autoComplete="email"
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
            {phoneError && <p className="mt-1 text-xs text-rose-600">{phoneError}</p>}

            {/* Turnstile widget（仅邮箱 tab 渲染） */}
            <div ref={turnstileContainerRef} className="mt-3 flex justify-center" />
            {turnstileError && (
              <p className="mt-1 text-center text-xs text-rose-600">{turnstileError}</p>
            )}

            <label className="mb-1 mt-3 block text-sm text-neutral-700">验证码</label>
            <input
              type="tel"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={codeSent ? '请输入验证码' : '请先点击「获取验证码」'}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
            />
            {codeError && <p className="mt-1 text-xs text-rose-600">{codeError}</p>}

            <button
              type="button"
              onClick={handleLogin}
              disabled={loginDisabled}
              className="mt-4 w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading && codeSent ? '登录中…' : '登录 / 注册'}
            </button>
          </div>
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
