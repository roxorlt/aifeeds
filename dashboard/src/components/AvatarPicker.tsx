import { useEffect, useRef, useState } from 'react';
import { DEFAULT_AVATAR_POOL, defaultAvatarUrl } from '../lib/defaultProfile';
import { toast } from '../lib/toast';
import { cn } from '../lib/utils';
import { useMotionDismiss } from '../lib/motionLayer';
import { activateModalFocus } from '../lib/modalFocus';
import { useScrollLock } from '../lib/useScrollLock';

interface Props {
  open: boolean;
  userId: string;
  currentSrc: string | null;
  onClose: () => void;
}

export function AvatarPicker({ open, userId, currentSrc, onClose }: Props) {
  const initial = currentSrc || defaultAvatarUrl(userId);
  const [selected, setSelected] = useState<string>(initial);
  const { layerClassName, requestClose } = useMotionDismiss(onClose, 'modal', open);
  useScrollLock(open);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const escapeCloseRef = useRef(onClose);

  useEffect(() => {
    escapeCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    return activateModalFocus(panel, {
      onEscape: () => escapeCloseRef.current(),
    });
  }, [open]);

  useEffect(() => {
    if (open) setSelected(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentSrc]);

  if (!open) return null;

  const dirty = selected !== initial;

  return (
    <div
      className={`${layerClassName} fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="avatar-picker-title"
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="motion-layer-panel w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 id="avatar-picker-title" className="text-lg font-semibold text-neutral-900">更换头像</h2>
          <button
            type="button"
            onClick={requestClose}
            data-modal-initial-focus
            className="-mr-2 rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        {/* 当前选中预览 */}
        <div className="mb-4 flex justify-center">
          <img
            src={selected}
            alt="预览"
            className="h-32 w-32 rounded-full bg-neutral-100 object-cover ring-2 ring-neutral-200"
          />
        </div>

        {/* 头像池 grid */}
        <div className="mb-5 grid grid-cols-6 gap-2">
          {DEFAULT_AVATAR_POOL.map((src) => {
            const isSelected = src === selected;
            return (
              <button
                key={src}
                type="button"
                onClick={() => setSelected(src)}
                className={cn(
                  'aspect-square overflow-hidden rounded-full bg-neutral-100',
                  isSelected ? 'ring-2 ring-neutral-900' : 'opacity-80 hover:opacity-100',
                )}
                aria-label="选择此头像"
              >
                <img src={src} alt="" className="h-full w-full object-cover" />
              </button>
            );
          })}
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={requestClose}
            className="flex-1 rounded-md border border-neutral-300 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!dirty}
            onClick={() => toast.info('保存功能即将开放')}
            className="flex-1 rounded-md bg-neutral-900 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
