import { useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function DeleteAccountConfirm({ open, onClose, onSuccess }: Props) {
  const user = useAuthStore((s) => s.user);
  const deleteAct = useAuthStore((s) => s.deleteAccount);

  const [phoneInput, setPhoneInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  if (!open || !user) return null;

  const handleConfirm = async () => {
    setErrorMsg('');
    if (!/^\d{11}$/.test(phoneInput)) {
      setErrorMsg('请输入完整 11 位手机号');
      return;
    }
    setLoading(true);
    try {
      await deleteAct(phoneInput);
      track(EVENTS.ACCOUNT_DELETE, {});
      onSuccess?.();
      onClose();
    } catch (e) {
      const a = e as AuthError;
      if (a.status === 400 && /phone confirm mismatch/i.test(a.message)) {
        setErrorMsg('手机号不匹配');
      } else if (a.status === 401) {
        setErrorMsg('登录已过期，请重新登录');
      } else {
        setErrorMsg(a.message || '注销失败');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-lg font-semibold text-rose-700">⚠️ 确认注销账号？</h2>
        <p className="mb-3 text-sm text-neutral-700">注销后将永久失去：</p>
        <ul className="mb-3 ml-4 list-disc text-sm text-neutral-700">
          <li>收藏的所有内容</li>
          <li>订阅的 author / 关键词</li>
          <li>阅读历史</li>
        </ul>
        <p className="mb-3 text-sm font-medium text-rose-700">操作不可逆。</p>
        <label className="mb-1 block text-sm text-neutral-700">
          请输入完整手机号（{user.phone_masked || '****'}）确认：
        </label>
        <input
          type="tel"
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value.replace(/\D/g, '').slice(0, 11))}
          placeholder="13800001234"
          className="mb-3 w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus:border-rose-500 focus:outline-none"
          autoFocus
        />
        {errorMsg && <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorMsg}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-md border border-neutral-300 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 rounded-md bg-rose-600 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:bg-rose-300"
          >
            {loading ? '注销中…' : '确认注销'}
          </button>
        </div>
      </div>
    </div>
  );
}
