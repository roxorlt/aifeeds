// 共享 Turnstile（Cloudflare 人机校验）基础设施。
// LoginModal.tsx 维持自己的内联实现（关键登录路径，多次修过 bug，不动）；
// 本模块供订阅页等其他场景复用，避免重复脚本加载 + 错误码翻译逻辑。

export const TURNSTILE_SITE_KEY = '0x4AAAAAADJyUx6JD4IMD_1i'; // ai-feeds-login-v3 widget
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

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

// 缓存在途 promise，避免 React StrictMode 开发期 effect 双跑 / 多组件并发调用
// 时重复 append 脚本（否则 Turnstile 会告警 "already been loaded"）。
let loadPromise: Promise<void> | null = null;
export function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null; // 允许后续重试
      reject(new Error('turnstile script load failed'));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

// 错误码 → 用户可读中文。完整列表见 Cloudflare Turnstile 文档：
// https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/
export function turnstileErrorMessage(code?: string): string {
  const c = String(code || '');
  const map: Record<string, string> = {
    '600010': '人机校验配置异常（域名未在 Cloudflare Turnstile 授权列表内），请联系管理员。',
    '300010': '人机校验已超时，请刷新页面重试。',
    '300020': '人机校验加载失败（网络受限）。如果开启了网络代理，请尝试关闭后重试。',
    '300030': '人机校验失败，请刷新页面重试。',
    '300031': '人机校验 token 异常，已自动重试。如果反复失败，请尝试刷新页面或更换浏览器；微信内置浏览器 / WebView 中可能不稳定。',
  };
  return map[c] || `人机校验失败（错误码 ${c || 'unknown'}），请刷新页面重试。`;
}
