import { useCallback, useEffect, useRef, useState } from "react";
import { MOTION_DURATION, shouldReduceMotion } from "./motion.ts";

export type MotionLayerKind = "modal" | "sheet" | "lightbox" | "popover";

export function exitDurationForLayer(kind: MotionLayerKind): number {
  return kind === "popover" ? MOTION_DURATION.popoverExit : MOTION_DURATION.modalExit;
}

export function layerClassName(kind: MotionLayerKind, leaving: boolean): string {
  return [
    "motion-layer",
    `motion-layer-${kind}`,
    leaving ? "motion-layer-leaving" : "",
  ].filter(Boolean).join(" ");
}

/**
 * Keeps a mounted layer alive long enough to render its exit state. The parent
 * still owns open/closed state; callers use requestClose for user-initiated
 * dismissals and may call the original onClose immediately for completed work.
 */
export function useMotionDismiss(
  onClose: () => void,
  kind: MotionLayerKind = "modal",
  active = true,
) {
  const [previousActive, setPreviousActive] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);

  // A controlled component stays mounted while `open` is false. Reset the
  // visual phase as part of the prop-change render so reopening never inherits
  // the prior exit class. React immediately retries this component render.
  if (active !== previousActive) {
    setPreviousActive(active);
    if (active) setLeaving(false);
  }

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    if (shouldReduceMotion()) {
      onClose();
      return;
    }
    closingRef.current = true;
    setLeaving(true);
    closeTimerRef.current = window.setTimeout(onClose, exitDurationForLayer(kind));
  }, [kind, onClose]);

  useEffect(() => {
    if (active) return;
    closingRef.current = false;
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, [active]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  return {
    leaving: active && leaving,
    requestClose,
    layerClassName: layerClassName(kind, active && leaving),
  };
}
