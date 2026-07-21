import { useEffect, useState } from 'react';
import { useToastStore, type ToastItem } from '../lib/toast';
import { cn } from '../lib/utils';

const VARIANT: Record<string, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  info: 'border-neutral-200 bg-white text-neutral-800',
};

function ToastItemView({
  it,
  dismiss,
}: {
  it: ToastItem;
  dismiss: (id: number) => void;
}) {
  const [entered, setEntered] = useState(false);

  // Give the initial transition state one committed frame before revealing it.
  // A dismiss that lands during entry simply retargets the same transition.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      onClick={() => dismiss(it.id)}
      data-mounted={entered && !it.leaving ? 'true' : 'false'}
      data-leaving={it.leaving ? 'true' : 'false'}
      className={cn(
        'motion-toast pointer-events-auto cursor-pointer rounded-md border px-4 py-2 text-sm shadow-md',
        'min-w-[200px] max-w-[420px]',
        VARIANT[it.type] || VARIANT.info,
      )}
      role="status"
    >
      {it.message}
    </div>
  );
}

export function Toast() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((it) => (
        <ToastItemView
          key={it.id}
          it={it}
          dismiss={dismiss}
        />
      ))}
    </div>
  );
}
