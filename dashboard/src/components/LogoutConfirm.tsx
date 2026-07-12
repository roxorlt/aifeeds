import { useEffect, useRef, useState } from 'react';
import { useMotionDismiss } from '../lib/motionLayer';
import { activateModalFocus } from '../lib/modalFocus';
import { useScrollLock } from '../lib/useScrollLock';

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

export function LogoutConfirm({ open, onClose, onConfirm }: Props) {
  const [loading, setLoading] = useState(false);
  const { layerClassName, requestClose } = useMotionDismiss(onClose, 'modal', open);
  useScrollLock(open);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const escapeCloseRef = useRef(onClose);
  const dismissAllowedRef = useRef(true);

  useEffect(() => {
    escapeCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    return activateModalFocus(panel, {
      onEscape: () => {
        if (dismissAllowedRef.current) escapeCloseRef.current();
      },
    });
  }, [open]);

  if (!open) return null;

  const handleConfirm = async () => {
    dismissAllowedRef.current = false;
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      dismissAllowedRef.current = true;
      setLoading(false);
    }
  };

  return (
    <div
      className={`${layerClassName} fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="logout-confirm-title"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="motion-layer-panel w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="logout-confirm-title" className="mb-5 text-lg font-semibold text-neutral-900">确认退出登录？</h2>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={requestClose}
            disabled={loading}
            data-modal-initial-focus
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
            {loading ? '退出中…' : '退出登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
