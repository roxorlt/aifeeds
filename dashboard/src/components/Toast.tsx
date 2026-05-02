import { useToastStore } from '../lib/toast';
import { cn } from '../lib/utils';

const VARIANT: Record<string, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  info: 'border-neutral-200 bg-white text-neutral-800',
};

export function Toast() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((it) => (
        <div
          key={it.id}
          onClick={() => dismiss(it.id)}
          className={cn(
            'pointer-events-auto cursor-pointer rounded-md border px-4 py-2 text-sm shadow-md transition-opacity',
            'min-w-[200px] max-w-[420px]',
            VARIANT[it.type] || VARIANT.info,
          )}
          role="status"
        >
          {it.message}
        </div>
      ))}
    </div>
  );
}
