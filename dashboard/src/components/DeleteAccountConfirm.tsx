import { useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';
import { toast } from '../lib/toast';
import { useMotionDismiss } from '../lib/motionLayer';

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
  const { layerClassName, requestClose } = useMotionDismiss(onClose, 'modal', open);

  if (!open || !user) return null;

  const phoneMask = user.phone_masked || 'xxx****xxxx';

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
      toast.success('账号已注销');
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
    <div className={`${layerClassName} fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4`}>
      <div
        className="motion-layer-panel w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold text-neutral-900">确认注销账号？</h2>
        <p className="mb-2 text-sm text-neutral-700">注销后将永久失去：</p>
        <ul className="mb-3 ml-4 list-disc text-sm text-neutral-700">
          <li>收藏的所有内容</li>
          <li>阅读历史</li>
        </ul>
        <p className="mb-4 text-sm font-medium text-rose-700">操作不可逆。</p>

        <div className="mb-1 flex items-baseline gap-2 text-sm">
          <span className="text-neutral-700">手机号</span>
          <span className="font-mono text-neutral-500">{phoneMask}</span>
        </div>
        <input
          type="tel"
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value.replace(/\D/g, '').slice(0, 11))}
          placeholder="请输入要注销账号的登录手机号"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
          autoFocus
        />
        {errorMsg && <p className="mt-1 text-xs text-rose-600">{errorMsg}</p>}

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={requestClose}
            disabled={loading}
            className="flex-1 rounded-md border border-neutral-300 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 rounded-md bg-neutral-900 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? '注销中…' : '确认注销'}
          </button>
        </div>
      </div>
    </div>
  );
}
