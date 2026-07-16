export type ImpressionElementRef = { current: Element | null };

export type ImpressionPendingEntry = {
  itemId: string;
  timer: number | null;
};

export type ImpressionElementLifecycle = {
  pending: WeakMap<Element, ImpressionPendingEntry>;
  observe: (element: Element) => void;
  unobserve: (element: Element) => void;
  clearTimer: (timer: number) => void;
};

/**
 * Rebind one callback-ref-owned element without retaining the previous item.
 * React invokes an old callback ref with null before invoking the new ref with
 * the same DOM node, so cleanup must cancel its dwell timer and observer entry
 * before the new item id is registered.
 */
export function updateObservedImpressionElement(
  node: Element | null,
  itemId: string | null | undefined,
  elementRef: ImpressionElementRef,
  lifecycle: ImpressionElementLifecycle,
): void {
  if (!node) {
    const previous = elementRef.current;
    if (!previous) return;
    const state = lifecycle.pending.get(previous);
    if (state?.timer != null) lifecycle.clearTimer(state.timer);
    lifecycle.pending.delete(previous);
    lifecycle.unobserve(previous);
    elementRef.current = null;
    return;
  }

  if (!itemId || elementRef.current === node) return;
  elementRef.current = node;
  lifecycle.pending.set(node, { itemId, timer: null });
  lifecycle.observe(node);
}
