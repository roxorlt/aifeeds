import { useEffect, useRef, useState } from 'react';
import { adoptSession } from '../lib/auth';
import { useAuthStore } from '../lib/authStore';
import { track, EVENTS } from '../lib/telemetry';
import { toast } from '../lib/toast';

// 微信登录落地页：relay 扫码成功后 302 到 /auth/callback?session=...&return_to=...
// 失败时 relay 302 到 /auth/callback?error=<code>（relay COM_LOGIN_URL 指到同一路由）。
// 这里把 session_token 换成 HttpOnly cookie（adopt），拉 user，再跳回原页。

// 错误码 → 中文提示（与 cc-site/server relay errorRedirect + architecture.md §7 对齐）
const ERROR_MESSAGES: Record<string, string> = {
  bad_return: '登录链接异常，请重试',
  wechat_denied: '已取消微信授权',
  state_invalid: '登录链接异常，请重新发起',
  state_expired: '登录超时，请重新发起',
  state_mismatch: '登录链接异常，请重试',
  code_replay: '请勿重复操作，请重新登录',
  wechat_api: '微信授权异常，请重试',
  exchange_failed: '服务暂不可用，请稍后重试或改用邮箱登录',
  internal: '系统错误，请稍后重试',
};

// return_to 二次校验（防开放重定向）：只允许本站绝对 URL 或相对路径
function safeDest(returnTo: string): string {
  if (returnTo.startsWith('/')) return returnTo;
  try {
    const u = new URL(returnTo);
    if (u.hostname === window.location.hostname) return u.pathname + u.search + u.hash;
  } catch {
    /* ignore */
  }
  return '/';
}

export function AuthCallback() {
  const hydrate = useAuthStore((s) => s.hydrate);
  const openLoginModal = useAuthStore((s) => s.openLoginModal);
  const [msg, setMsg] = useState('正在完成登录…');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode 双跑保护 + adopt 不重复
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const session = params.get('session');
    const error = params.get('error');
    const dest = safeDest(params.get('return_to') || '/');

    const bail = (text: string) => {
      toast.error(text);
      setMsg('登录失败，正在返回…');
      // 清掉带 token/error 的 callback URL，回首页并弹登录
      window.history.replaceState({}, '', '/');
      openLoginModal('manual');
    };

    (async () => {
      if (error) {
        track('wechat_login_failed', { reason: error });
        bail(ERROR_MESSAGES[error] || '登录失败，请重试');
        return;
      }
      if (!session) {
        window.location.replace('/');
        return;
      }
      try {
        await adoptSession(session);
        await hydrate(); // cookie 已下发，拉完整 user
        track(EVENTS.LOGIN_SUCCESS, { login_method: 'wechat' });
        toast.success('登录成功');
        // location.replace：替换掉含 session 的 history 条目，token 不残留
        window.location.replace(dest || '/');
      } catch {
        track('wechat_login_failed', { reason: 'adopt_failed' });
        bail('登录失败，请重试');
      }
    })();
  }, [hydrate, openLoginModal]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 text-neutral-600">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
        <div className="text-sm">{msg}</div>
      </div>
    </div>
  );
}
