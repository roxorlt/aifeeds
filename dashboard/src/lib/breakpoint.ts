import { useEffect, useState } from "react";

const NARROW_QUERY = "(max-width: 767px)";

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(NARROW_QUERY).matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return narrow;
}
