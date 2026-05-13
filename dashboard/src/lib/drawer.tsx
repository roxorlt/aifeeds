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
import { dispatchItemUpdate } from "./itemUpdateBus";

interface DrawerState {
  item: Item | null;
  siblings: Item[];
  loading: boolean;
  error: "not_found" | "network" | null;
}

interface DrawerContextValue {
  state: DrawerState;
  openTweet: (item: Item, siblings?: Item[]) => void;
  // Generic: open any source's item in the drawer. For X items this delegates
  // to openTweet (URL → /t/:id); for GitHub items it sets state directly until
  // PR-5 wires /g/:owner/:repo. Either way the drawer renders.
  openItem: (item: Item, siblings?: Item[]) => void;
  close: () => void;
  // Spotlight: latest item the user opened via /t/:id (cold link or in-app
  // click). Feed prepends this to its data with dedup, so closing the drawer
  // doesn't leave the user without the tweet they just shared/landed on.
  // Persists for the session — cleared only on full page reload or when
  // overwritten by a different /t/:id navigation.
  spotlightItem: Item | null;
  /** 释放当前 spotlight（feed 列头筛选条件变了的话需要清掉，否则 pin 的 item 不符合新筛选）*/
  clearSpotlight: () => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

function parseDeepLinkFromPath(pathname: string): { compositeId: string } | null {
  // /t/:source_id  → x_list:<source_id>
  const tweetMatch = pathname.match(/^\/t\/([^/]+)$/);
  if (tweetMatch) {
    return { compositeId: `x_list:${tweetMatch[1]}` };
  }
  // /g/:owner/:repo → github:<owner>/<repo>
  const ghMatch = pathname.match(/^\/g\/([^/]+)\/([^/]+)$/);
  if (ghMatch) {
    const owner = decodeURIComponent(ghMatch[1]);
    const repo = decodeURIComponent(ghMatch[2]);
    return { compositeId: `github:${owner}/${repo}` };
  }
  // /ph/:slug/:date → product_hunt:<slug>:<date>
  const phMatch = pathname.match(/^\/ph\/([^/]+)\/([^/]+)$/);
  if (phMatch) {
    const slug = decodeURIComponent(phMatch[1]);
    const date = decodeURIComponent(phMatch[2]);
    return { compositeId: `product_hunt:${slug}:${date}` };
  }
  // /c/:slug → clawhub:<slug>
  const chMatch = pathname.match(/^\/c\/([^/]+)$/);
  if (chMatch) {
    const slug = decodeURIComponent(chMatch[1]);
    return { compositeId: `clawhub:${slug}` };
  }
  // /e/:event_id → huodongxing:<event_id>（站点原始数字 ID，如 5859894940100）
  const hdxMatch = pathname.match(/^\/e\/([^/]+)$/);
  if (hdxMatch) {
    const eventId = decodeURIComponent(hdxMatch[1]);
    return { compositeId: `huodongxing:${eventId}` };
  }
  return null;
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

  const openItem = useCallback(
    (item: Item, siblings: Item[] = []) => {
      // Optimistic open: set state first so URL effect sees cache hit.
      setState({ item, siblings, loading: false, error: null });
      setSpotlightItem(item);
      activeIdRef.current = item.id;
      if (item.source_type === "x_list") {
        navigate(`/t/${encodeURIComponent(item.source_id)}`);
      } else if (item.source_type === "github") {
        // /g/:owner/:repo (two segments — same shape as github.com URLs)
        const [owner, repo] = item.source_id.split("/");
        if (owner && repo) {
          navigate(`/g/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
        }
      } else if (item.source_type === "product_hunt") {
        // /ph/:slug/:date — source_id 是 <slug>:<launch_date> 复合键
        const [slug, date] = item.source_id.split(":");
        if (slug && date) {
          navigate(`/ph/${encodeURIComponent(slug)}/${encodeURIComponent(date)}`);
        }
      } else if (item.source_type === "clawhub") {
        // /c/:slug — source_id 是 skill slug（单段）
        navigate(`/c/${encodeURIComponent(item.source_id)}`);
      } else if (item.source_type === "huodongxing") {
        // /e/:event_id — source_id 是站点原始数字 ID（如 5859894940100）
        navigate(`/e/${encodeURIComponent(item.source_id)}`);
      }
      // Future sources: youtube / podcast / arxiv — add URL forms here.
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
    const parsed = parseDeepLinkFromPath(location.pathname);

    if (!parsed) {
      if (activeIdRef.current !== null) {
        activeIdRef.current = null;
        setState({ item: null, siblings: [], loading: false, error: null });
      }
      return;
    }

    const { compositeId } = parsed;
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

  // PR6.6 lazy enrich：drawer 上的 item 变化时立即触发 on-demand refresh（X syndication）
  // 用单独的 useEffect 监听 state.item?.id，覆盖三种打开方式：
  // (1) URL 直接访问 → URL useEffect 跑 fetchItem → state 设置
  // (2) openTweet/openItem (点卡片，optimistic) → state 立即设置，URL useEffect 因
  //     activeIdRef 已被预设而 early return，不会跑 fetchItem
  // 两种情况下，state.item 都更新到新 id，这个 useEffect 都会触发
  // worker 端 KV 5min throttle，重复打开不会重复 syndication 调用
  useEffect(() => {
    const id = state.item?.id;
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const { refreshItem } = await import("../api");
        const r = await refreshItem(id);
        if (cancelled || !r.refreshed) return;
        // 等 worker 写完 D1（~100ms），再拉新数据
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (cancelled || activeIdRef.current !== id) return;
        const fresh = await fetchItem(id);
        if (cancelled || activeIdRef.current !== id) return;
        setState({ item: fresh.item, siblings: fresh.siblings, loading: false, error: null });
        setSpotlightItem(fresh.item);
        // 同步 feed 流里那张卡片，避免「抽屉新、feed 老」（6.6.2 / 6.6.3）
        dispatchItemUpdate(fresh.item);
      } catch {
        // 静默失败
      }
    })();
    return () => { cancelled = true; };
  }, [state.item?.id]);

  return (
    <DrawerContext.Provider value={{ state, openTweet, openItem, close, spotlightItem, clearSpotlight: () => setSpotlightItem(null) }}>
      {children}
    </DrawerContext.Provider>
  );
}

export function useDrawer(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used within DrawerProvider");
  return ctx;
}
