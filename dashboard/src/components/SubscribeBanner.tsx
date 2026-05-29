import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';

// 未登录用户的订阅引导横幅。每天首次到访展示，可关闭（当天不再弹，次日重新展示）；
// 不做"关闭后永久不弹"的记忆。登录用户不展示。
const DISMISS_KEY = 'aifeeds:sub_banner_dismissed';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function SubscribeBanner() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === todayStr();
    } catch {
      return false;
    }
  });

  // 登录态确定前不渲染（避免给已登录用户闪一下）；已登录 / 今日已关闭 → 不展示
  if (!hydrated || user || dismissed) return null;

  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, todayStr());
    } catch {
      // localStorage 不可用（隐私模式）→ 仅当前会话内关闭，刷新会再出现，可接受
    }
    setDismissed(true);
  };

  return (
    <div className="border-b border-neutral-800 bg-neutral-900 text-white">
      <div className="mx-auto flex max-w-[1280px] items-center gap-3 px-3 py-2 sm:px-8 lg:px-16">
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-100">每日邮件精选 AI 资讯</span>
        <button
          type="button"
          onClick={() => navigate('/subscribe')}
          className="shrink-0 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-200"
        >
          立即订阅
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="关闭"
          className="shrink-0 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
