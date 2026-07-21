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
    const update = () => setNarrow(mq.matches);
    mq.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return narrow;
}
