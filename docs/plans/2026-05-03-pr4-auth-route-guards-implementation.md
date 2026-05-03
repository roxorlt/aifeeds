# PR4 强制登录拦截 实施计划

> **分支**：`feat/pr4-route-guards`（worktree `.worktrees/feat-pr4-route-guards/`）
> **依赖**：PR3 ✅（LoginModal / authStore / pendingRetry / api.ts 401 拦截器）
> **目标**：未登录用户访问个人态页面自动弹登录，登录成功后停在原页（不跳首页）。
> **不在范围**：收藏 / 订阅按钮触发登录（PR7 实现）；newsletter 订阅（PR7 实现）

---

## 一、范围

### 在 PR4 做
- `RequireAuth` 包装组件 — 未登录则触发登录 modal，登录成功后停在原 URL
- `/settings` + `/settings/account` 套 `RequireAuth`
- 验证 `apiFetch` 401 拦截器在 hydrate 阶段不误弹（PR3 已实现，本 PR 验真）
- 登录后跳回原页（基于 PR3 的 `pendingRetry`）

### 不在 PR4 做（PR5 / PR7）
- 收藏 / 订阅按钮触发登录 → PR7（PR4 时还没有这俩 UI）
- 分享功能未登录拦截 → PR5 分享时再加
- API 级守卫扩展 protectedPaths → 等 PR7 加 favorites/subscriptions 时一起

---

## 二、设计

### 触发场景

| 场景 | 行为 |
|---|---|
| 已登录访问 `/settings` | 直接渲染 |
| 未登录访问 `/settings` | 弹 LoginModal（trigger='route_guard'），下方占位「请先登录」；登录成功后停在 /settings 渲染 |
| 已登录访问 `/settings/account` | 直接渲染 |
| 未登录访问 `/settings/account` | 同上 — 登录成功后停在 /settings/account |
| hydrate 还没完成 | 显示「加载中…」（既不弹也不渲染） |
| `/api/auth/me` 401（hydrate 阶段） | 静默 set `user: null, hydrated: true`，**不弹登录**（首页本身允许匿名） |
| 用户主动点退出 → /settings 已渲染 | 路由 effect 触发：检测到 user→null，弹登录 modal |

### 跳回原页机制

PR3 的 `authStore.openLoginModal(trigger, retry?)` 已经支持传 retry callback，登录成功后自动调。

PR4 的 `RequireAuth` 把 `() => { /* noop, just stay */ }` 注入为 retry — 登录成功后不需要 navigate（用户本来就在这条 URL 上），只要让 `useEffect` 重新走一遍：当 user 从 null → 有值时，组件自然 re-render 出 children。

### 组件接口

```tsx
<RequireAuth>
  <Settings />
</RequireAuth>
```

实现：
```tsx
import { useEffect } from 'react';
import { useAuthStore } from '../lib/authStore';

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
```

### App.tsx 路由改造

```tsx
<Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
<Route path="/settings/account" element={<RequireAuth><AccountManage /></RequireAuth>} />
```

### Settings / AccountManage 内部去重逻辑

PR3 时 Settings 和 AccountManage 自己都做了未登录的兜底渲染（「请先登录」+「返回首页」）。PR4 把这个责任交给 `RequireAuth`，组件内部就可以假定 `user` 已存在，简化逻辑。

---

## 三、文件改动

| 文件 | 改动 |
|---|---|
| `dashboard/src/components/RequireAuth.tsx` | 新建 |
| `dashboard/src/App.tsx` | `/settings` 和 `/settings/account` 路由用 RequireAuth 包 |
| `dashboard/src/pages/Settings.tsx` | 删除内部 `if (!user) return ...` 兜底 |
| `dashboard/src/pages/AccountManage.tsx` | 同上 |
| `dashboard/src/lib/telemetry/event-types.ts` | 加 trigger 'route_guard' 到允许列表（如有约束）|

---

## 四、telemetry 事件

PR1 已有 `LOGIN_MODAL_OPEN` 事件，payload `{ trigger_action }`。PR4 新增 trigger 值 `'route_guard'`，前端发，后端无需改（events 表 payload 是 free-form JSON）。

PR3 的 LoginTrigger 类型已经是 `'manual' | 'favorite' | 'subscribe' | 'api_401' | string` —— 接受 string，所以新值无需改类型定义。

---

## 五、测试场景

build verify 后手动测：

1. **未登录直接访问 /settings**
   - 期望：登录 modal 自动弹出，下方有「请先登录后访问」占位
   - 完成登录 → modal 关，页面渲染 Settings 内容
2. **未登录访问 /settings/account（深链）**
   - 期望：同上，登录后停在 /settings/account
3. **登录态访问 /settings**
   - 期望：直接渲染，无任何弹窗
4. **登录态点退出登录** → 路由还在 /settings
   - 期望：触发 LogoutConfirm → 用户确认 → 退出后立刻弹登录 modal（user→null 触发 RequireAuth effect）
   - 实际 PR3 已经在 LogoutConfirm 完成时 navigate('/')，所以这个场景不会出现「停留在 /settings」
   - PR4 不改这个流程
5. **hydrate 失败的情况**
   - cookie 失效但 localStorage 有持久化 user：hydrate 调 /api/auth/me 401 → set user=null → RequireAuth effect 检测到 → 弹登录
   - 期望：不报错、不跳页面，安静弹登录

---

## 六、回滚

- 单 commit，纯前端改动，无 schema / worker / secret 变化
- 回滚：`git revert <merge-commit>` + dashboard 重新部署上一版

---

## 七、上线 checklist

- [ ] `npm run build` 通过
- [ ] 手动测 5 个场景
- [ ] 移动端 viewport 测一次（横屏 / 竖屏弹窗布局）
- [ ] commit + rebase main + merge --no-ff
- [ ] dashboard 部署 prod
- [ ] worker 不需要部署（无改动）
- [ ] 在 prod 重测场景 1-3
