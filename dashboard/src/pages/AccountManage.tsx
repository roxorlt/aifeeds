import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { DeleteAccountConfirm } from '../components/DeleteAccountConfirm';

export function AccountManage() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!hydrated) {
    return <div className="p-8 text-center text-neutral-500">加载中…</div>;
  }
  if (!user) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-neutral-700">请先登录</p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          返回首页
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100"
          aria-label="返回"
        >
          ←
        </button>
        <h1 className="text-xl font-semibold text-neutral-900">账号管理</h1>
      </header>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <button
          type="button"
          disabled
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-neutral-400 disabled:cursor-not-allowed"
        >
          <span>更换手机号</span>
          <span className="text-xs">即将开放</span>
        </button>
        <div className="border-t border-neutral-100" />
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-rose-600 hover:bg-rose-50"
        >
          <span>注销账号</span>
          <span className="text-neutral-400">›</span>
        </button>
      </div>

      <DeleteAccountConfirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onSuccess={() => navigate('/')}
      />
    </div>
  );
}
