export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
export const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
export const DRAWER_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

export const MOTION_DURATION = {
  tab: 160,
  popoverEnter: 160,
  popoverExit: 125,
  modalEnter: 220,
  modalExit: 200,
  drawerEnter: 260,
  drawerExit: 200,
  toastEnter: 160,
  toastExit: 110,
} as const;

type MediaQueryReader = (query: string) => { matches: boolean };

export function shouldReduceMotion(
  reader: MediaQueryReader | undefined =
    typeof window !== "undefined" ? window.matchMedia.bind(window) : undefined,
): boolean {
  return reader?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export interface DismissGesture {
  distance: number;
  crossAxis: number;
  elapsedMs: number;
  viewport: number;
}

export function shouldCommitDismiss({
  distance,
  crossAxis,
  elapsedMs,
  viewport,
}: DismissGesture): boolean {
  if (distance <= 0 || Math.abs(distance) <= Math.abs(crossAxis) * 1.25) return false;
  const deliberateDistance = Math.min(80, Math.max(viewport, 1) * 0.5);
  const velocity = distance / Math.max(elapsedMs, 1);
  return distance >= deliberateDistance || (distance >= 20 && velocity > 0.11);
}

export type DrawerActivationMode = "closed" | "enter" | "restore";

export function drawerActivationMode(
  wasOpen: boolean,
  open: boolean,
): DrawerActivationMode {
  if (!open) return "closed";
  return wasOpen ? "restore" : "enter";
}

interface TransformTransitionOptions {
  fallbackMs: number;
  onComplete: () => void;
  onCancel?: () => void;
  setTimeoutFn?: (callback: () => void, delay: number) => number;
  clearTimeoutFn?: (id: number) => void;
}

/**
 * Wait for one element's transform transition without accepting bubbled child
 * events. The returned disposer is intentionally silent so a new gesture can
 * invalidate an old settle without running either stale callback.
 */
export function watchTransformTransition(
  target: EventTarget,
  {
    fallbackMs,
    onComplete,
    onCancel,
    setTimeoutFn = (callback, delay) => window.setTimeout(callback, delay),
    clearTimeoutFn = (id) => window.clearTimeout(id),
  }: TransformTransitionOptions,
): () => void {
  let active = true;
  let fallbackId: number | null = null;

  const cleanup = () => {
    target.removeEventListener("transitionend", handleEnd);
    target.removeEventListener("transitioncancel", handleCancel);
    if (fallbackId !== null) clearTimeoutFn(fallbackId);
    fallbackId = null;
  };
  const isOwnTransform = (event: Event) => (
    event.target === target
    && (event as TransitionEvent).propertyName === "transform"
  );
  const complete = () => {
    if (!active) return;
    active = false;
    cleanup();
    onComplete();
  };
  function handleEnd(event: Event) {
    if (isOwnTransform(event)) complete();
  }
  function handleCancel(event: Event) {
    if (!active || !isOwnTransform(event)) return;
    active = false;
    cleanup();
    onCancel?.();
  }

  target.addEventListener("transitionend", handleEnd);
  target.addEventListener("transitioncancel", handleCancel);
  fallbackId = setTimeoutFn(complete, fallbackMs);

  return () => {
    if (!active) return;
    active = false;
    cleanup();
  };
}
