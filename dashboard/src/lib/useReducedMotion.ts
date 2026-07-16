import { useEffect, useState } from "react";

/**
 * Reactive counterpart to shouldReduceMotion(). Gesture effects depend on the
 * returned value, so a runtime OS preference change tears them down before an
 * already-scheduled transform can run.
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== "undefined"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ));

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReducedMotion(query.matches);
    handler();
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);

  return reducedMotion;
}
