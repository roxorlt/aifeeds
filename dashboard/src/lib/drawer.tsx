import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import type { Item } from "../types";
import { fetchItem, ItemNotFoundError } from "../api";

interface DrawerState {
  item: Item | null;
  siblings: Item[];
  loading: boolean;
  error: "not_found" | "network" | null;
}

interface DrawerContextValue {
  state: DrawerState;
  openTweet: (item: Item, siblings?: Item[]) => void;
  close: () => void;
  // Spotlight: latest item the user opened via /t/:id (cold link or in-app
  // click). Feed prepends this to its data with dedup, so closing the drawer
  // doesn't leave the user without the tweet they just shared/landed on.
  // Persists for the session — cleared only on full page reload or when
  // overwritten by a different /t/:id navigation.
  spotlightItem: Item | null;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

const SOURCE_TYPE = "x_list" as const;

function parseTweetIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/t\/([^/]+)$/);
  return match ? match[1] : null;
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DrawerState>({
    item: null,
    siblings: [],
    loading: false,
    error: null,
  });
  const [spotlightItem, setSpotlightItem] = useState<Item | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Track which composite id is currently shown / being fetched, to dedupe
  // URL-effect work when the cache was just primed by openTweet().
  const activeIdRef = useRef<string | null>(null);

  const openTweet = useCallback(
    (item: Item, siblings: Item[] = []) => {
      // Optimistic open: set state first so the URL effect sees the cache hit.
      setState({ item, siblings, loading: false, error: null });
      setSpotlightItem(item);
      activeIdRef.current = item.id;
      navigate(`/t/${encodeURIComponent(item.source_id)}`);
    },
    [navigate],
  );

  const close = useCallback(() => {
    // Going back triggers popstate → URL becomes / → URL effect clears state.
    // main.tsx seeds '/' under any cold /t/:id, so history.length > 1 always
    // holds in practice; keep the fallback for paranoia.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/", { replace: true });
    }
  }, [navigate]);

  // URL → drawer state sync.
  useEffect(() => {
    const sourceId = parseTweetIdFromPath(location.pathname);

    if (!sourceId) {
      if (activeIdRef.current !== null) {
        activeIdRef.current = null;
        setState({ item: null, siblings: [], loading: false, error: null });
      }
      return;
    }

    const compositeId = `${SOURCE_TYPE}:${sourceId}`;
    if (activeIdRef.current === compositeId) return;

    activeIdRef.current = compositeId;
    setState((s) => ({ ...s, loading: true, error: null }));

    // Stale-fetch guard uses activeIdRef only — `cancelled` flag would bail
    // valid fetches under StrictMode's double-effect remount. Ref-equality
    // already covers both unmount and URL-changed-mid-fetch cases.
    fetchItem(compositeId)
      .then(({ item, siblings }) => {
        if (activeIdRef.current !== compositeId) return;
        setState({ item, siblings, loading: false, error: null });
        setSpotlightItem(item);
      })
      .catch((err: unknown) => {
        if (activeIdRef.current !== compositeId) return;
        const code = err instanceof ItemNotFoundError ? "not_found" : "network";
        setState({ item: null, siblings: [], loading: false, error: code });
      });
  }, [location.pathname]);

  return (
    <DrawerContext.Provider value={{ state, openTweet, close, spotlightItem }}>
      {children}
    </DrawerContext.Provider>
  );
}

export function useDrawer(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used within DrawerProvider");
  return ctx;
}
