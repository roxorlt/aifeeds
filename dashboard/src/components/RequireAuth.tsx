import { useEffect } from 'react';
import { useAuthStore } from '../lib/authStore';

// 路由级登录守卫。
// 未登录则触发 LoginModal 弹出 + 渲染占位文字；登录成功后 user 从 null 变有值，
// 组件自动 re-render 出 children（用户停在原 URL 上，不跳首页）。
//
// hydrate 阶段（cookie 验证中）显示加载中，避免 cookie 还在但 user 还是 null 时误弹。
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const openLogin = useAuthStore((s) => s.openLoginModal);

  useEffect(() => {
    if (hydrated && !user) {
      openLogin('route_guard');
    }
  }, [hydrated, user, openLogin]);

  if (!hydrated) {
    return <div className="p-8 text-center text-neutral-500">加载中…</div>;
  }
  if (!user) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="text-sm text-neutral-600">请先登录后访问</p>
      </div>
    );
  }
  return <>{children}</>;
}
