import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import type { Item } from "../types";
import { fetchItem, ItemNotFoundError, type ItemDetailResponse } from "../api";
import { dispatchItemUpdate, subscribeItemUpdate } from "./itemUpdateBus";
import { createDetailLoader, type DetailLoader } from "./detailLoader";
import { DrawerContext } from "./drawerContext";
import { homePathForItem } from "../home/itemPath";

export interface DrawerState {
  item: Item | null;
  siblings: Item[];
  siblings_has_more?: boolean;
  metrics_history?: ItemDetailResponse["metrics_history"];
  loading: boolean;
  error: "not_found" | "network" | null;
}

export interface DrawerContextValue {
  state: DrawerState;
  openTweet: (item: Item, siblings?: Item[]) => void;
  // Generic: open any source's item in the drawer. For X items this delegates
  // to openTweet (URL → /t/:id); for GitHub items it sets state directly until
  // PR-5 wires /g/:owner/:repo. Either way the drawer renders.
  openItem: (item: Item, siblings?: Item[]) => void;
  // 抽屉内下钻打开另一条（如 PH「同类产品」）：覆盖式压栈，新页顶栏显示「←」返回
  // 而非「✕」，返回回到上一条。深度记在 history state（drawerDepth），浏览器前进/
  // 后退天然同步。覆盖打开不走 spotlight（不向流内插该条）。
  pushItem: (item: Item) => void;
  close: () => void;
  /** 抽屉下钻深度：0=根层（流内/冷链打开），>0=覆盖下钻层。驱动顶栏 ←/✕。 */
  depth: number;
  // Spotlight: latest item the user opened via /t/:id (cold link or in-app
  // click). Feed prepends this to its data with dedup, so closing the drawer
  // doesn't leave the user without the tweet they just shared/landed on.
  // Persists for the session — cleared only on full page reload or when
  // overwritten by a different /t/:id navigation.
  spotlightItem: Item | null;
  /** 释放当前 spotlight（feed 列头筛选条件变了的话需要清掉，否则 pin 的 item 不符合新筛选）*/
  clearSpotlight: () => void;
}

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
  // /h/:arxiv_id → hf_paper:<arxiv_id>（HF Daily Papers，arxiv_id 如 2605.13301）
  const hfMatch = pathname.match(/^\/h\/([^/]+)$/);
  if (hfMatch) {
    const arxivId = decodeURIComponent(hfMatch[1]);
    return { compositeId: `hf_paper:${arxivId}` };
  }
  // /y/:video_id → youtube:<video_id>
  const youtubeMatch = pathname.match(/^\/y\/([^/]+)$/);
  if (youtubeMatch) {
    const videoId = decodeURIComponent(youtubeMatch[1]);
    return { compositeId: `youtube:${videoId}` };
  }
  // /o/:id → 官方新闻(blog/podcast)。:id 是完整 composite id(blog:<feed>:<hash>),
  // 前缀校验防把裸 /o/ 频道或非法值当 item 深链。
  const oMatch = pathname.match(/^\/o\/([^/]+)$/);
  if (oMatch) {
    const cid = decodeURIComponent(oMatch[1]);
    if (cid.startsWith("blog:") || cid.startsWith("podcast:")) {
      return { compositeId: cid };
    }
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
  // F4: clearSpotlight 必须稳定，否则 Feed.tsx 里依赖了它的 useEffect 会
  // 因为每次 DrawerProvider re-render 都拿到新函数引用而重跑（之前 bug 就是这个 —
  // 重跑后第二次起 filterChangeIgnoreRef 已是 false，clearSpotlight 真被调，
  // 立刻把刚 fetchItem 设上去的 spotlight 清掉，导致 feed 顶部假写失效）。
  const clearSpotlight = useCallback(() => setSpotlightItem(null), []);
  const navigate = useNavigate();
  const location = useLocation();
  // 抽屉下钻深度：存在 history state 里，浏览器前进/后退天然带着走。
  // 驱动顶栏 ←/✕ 切换 + 覆盖层不插 spotlight。
  const depth = (location.state as { drawerDepth?: number } | null)?.drawerDepth ?? 0;

  // Refresh/enrich work uses this ref as its stale guard. Read-only detail
  // loading has its own entry-scoped controller below.
  const activeIdRef = useRef<string | null>(null);
  const detailLoaderRef = useRef<DetailLoader<ItemDetailResponse> | null>(null);
  if (!detailLoaderRef.current) {
    detailLoaderRef.current = createDetailLoader(fetchItem);
  }

  const startDetailLoad = useCallback((id: string, addToSpotlight: boolean) => {
    activeIdRef.current = id;
    return detailLoaderRef.current!.enter(id, {
      onSuccess: (_loadedId, { item, siblings, siblings_has_more, metrics_history }) => {
        setState({ item, siblings, siblings_has_more, metrics_history, loading: false, error: null });
        if (addToSpotlight) setSpotlightItem(item);
      },
      onError: (loadedId, err: unknown) => {
        setState((current) => {
          // DetailLoader already rejects stale tokens. Keep the id guard here
          // as a second boundary so an old failure can never erase a newer
          // optimistic entry if callback ownership changes in the future.
          if (activeIdRef.current !== loadedId) return current;
          if (err instanceof ItemNotFoundError) {
            return { item: null, siblings: [], loading: false, error: "not_found" };
          }
          // A transport failure is not evidence that the optimistic list DTO
          // disappeared. Keep the usable item and its navigation siblings.
          if (current.item?.id === loadedId) {
            return { ...current, loading: false, error: "network" };
          }
          return { item: null, siblings: [], loading: false, error: "network" };
        });
      },
    });
  }, []);

  // Closing, switching providers, or unmounting must invalidate any response
  // that is still in flight. StrictMode's duplicate effect within one mount is
  // coalesced because the loader entry remains active.
  useEffect(() => () => {
    detailLoaderRef.current?.leave();
    activeIdRef.current = null;
  }, []);

  const openTweet = useCallback(
    (item: Item, siblings: Item[] = []) => {
      // Optimistic open keeps the drawer instant, while the independent
      // read-only request upgrades the list DTO to a full detail item.
      setState({ item, siblings, loading: false, error: null });
      // B2: 流内点击不强插 spotlight（卡片本来就在原位置，关抽屉用户回到原
      // 位置即可）。强插 spotlight 只发生在 URL 直接访问场景（见 URL useEffect）。
      void startDetailLoad(item.id, false).catch(() => {});
      navigate(`/t/${encodeURIComponent(item.source_id)}`);
    },
    [navigate, startDetailLoad],
  );

  const openItem = useCallback(
    (item: Item, siblings: Item[] = []) => {
      // Optimistic open, then always start the full read. refreshItem below is
      // parallel enrichment and never gates this request.
      setState({ item, siblings, loading: false, error: null });
      // B2: 同 openTweet 不强插 spotlight
      void startDetailLoad(item.id, false).catch(() => {});
      const url = homePathForItem(item);
      if (url) navigate(url);
      // Future source: legacy arxiv — 在 homePathForItem 里补 URL 形式。
    },
    [navigate, startDetailLoad],
  );

  // 覆盖式下钻：压栈打开 item（history state drawerDepth +1），顶栏显示「←」。
  // 跟 openItem 一样 optimistic，并立即拉完整详情；覆盖层不向流内插 spotlight。
  const pushItem = useCallback(
    (item: Item) => {
      const url = homePathForItem(item);
      if (!url) return;
      setState({ item, siblings: [], loading: false, error: null });
      void startDetailLoad(item.id, false).catch(() => {});
      navigate(url, { state: { drawerDepth: depth + 1 } });
    },
    [navigate, depth, startDetailLoad],
  );

  const close = useCallback(() => {
    detailLoaderRef.current?.leave();
    activeIdRef.current = null;
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
      detailLoaderRef.current?.leave();
      activeIdRef.current = null;
      setState((current) => (
        current.item || current.loading || current.error
          ? { item: null, siblings: [], loading: false, error: null }
          : current
      ));
      return;
    }

    const { compositeId } = parsed;
    const alreadyEntered = detailLoaderRef.current?.activeId() === compositeId;
    if (!alreadyEntered) setState((s) => ({ ...s, loading: true, error: null }));
    // Direct routes start here. Optimistic opens already started the same entry,
    // so enter() returns that exact promise without a second network request.
    void startDetailLoad(compositeId, depth === 0).catch(() => {});
  // depth 进依赖：back 到不同 depth 的条目时正确重算 spotlight 门控
  }, [location.pathname, depth, startDetailLoad]);

  // itemUpdateBus 订阅：外部（如 TweetCard 译文按钮触发 translate-now）更新某 item
  // 后 dispatch，drawer 内若当前正显示该 item 则同步更新 state.item，保证抽屉视图实时刷新。
  useEffect(() => {
    return subscribeItemUpdate((updated) => {
      setState((prev) => {
        if (!prev.item || prev.item.id !== updated.id) return prev;
        return { ...prev, item: updated };
      });
    });
  }, []);

  // PR6.6 lazy enrich：drawer 上的 item 变化时立即触发 on-demand refresh（X syndication）
  // 用单独的 useEffect 监听 state.item?.id，覆盖三种打开方式：
  // (1) URL 直接访问 → URL useEffect 跑 fetchItem → state 设置
  // (2) openTweet/openItem (点卡片，optimistic) → state 立即设置，同时独立详情读取
  // 两种情况下，state.item 都更新到新 id，这个 useEffect 都会触发
  // worker 端 KV 5min throttle，重复打开不会重复 syndication 调用
  useEffect(() => {
    const id = state.item?.id;
    if (!id) return;
    let cancelled = false;
    // C3: 智能 merge —— fresh 是 enrich 后从 worker 拉的最新版，但
    // 如果某些字段在前端先到（比如 fetchItems 列表 endpoint 缓存了
    // 含 quote_of 完整快照的数据），而 fresh 因数据 race 拿到的是
    // 部分字段，单纯替换会导致 UI "倒退"（嵌套小卡突然消失等）。
    // 用 setState functional form 合并：fresh 字段优先（含 metrics），
    // 但 prev.extra 里 fresh 没填的字段保留（safeguard）。
    // BE 2026-05-19: hf_paper discussion refresh 完成后也走同样 merge 路径,
    // 抽成 applyFresh 闭包共用
    const applyFresh = (fresh: Awaited<ReturnType<typeof fetchItem>>) => {
      // refresh-origin fetchItem is newer than the optimistic entry's initial
      // detail request. Invalidate that older request's success/error callbacks
      // before applying fresh so it cannot roll state back later.
      detailLoaderRef.current?.supersede(fresh.item.id);
      setState((prev) => {
        if (!prev.item) {
          return {
            item: fresh.item,
            siblings: fresh.siblings,
            siblings_has_more: fresh.siblings_has_more,
            metrics_history: fresh.metrics_history,
            loading: false,
            error: null,
          };
        }
        const prevExtra = (prev.item.extra && typeof prev.item.extra === 'object') ? prev.item.extra : {};
        const freshExtra = (fresh.item.extra && typeof fresh.item.extra === 'object') ? fresh.item.extra : {};
        const mergedExtra = { ...prevExtra, ...freshExtra };
        // 但如果 fresh 把某字段显式置为 null/undefined，prev 有值时保留 prev 的
        for (const k of Object.keys(prevExtra)) {
          if ((freshExtra as Record<string, unknown>)[k] == null && (prevExtra as Record<string, unknown>)[k] != null) {
            (mergedExtra as Record<string, unknown>)[k] = (prevExtra as Record<string, unknown>)[k];
          }
        }
        return {
          item: { ...fresh.item, extra: mergedExtra },
          siblings: fresh.siblings,
          siblings_has_more: fresh.siblings_has_more,
          metrics_history: fresh.metrics_history,
          loading: false,
          error: null,
        };
      });
      // B2: 只在已有 spotlight 时刷新（URL 直接访问场景）。流内点击不强插。
      setSpotlightItem((prev) => (prev ? fresh.item : null));
      // 同步 feed 流里那张卡片，避免「抽屉新、feed 老」（6.6.2 / 6.6.3）
      dispatchItemUpdate(fresh.item);
    };

    (async () => {
      try {
        const { refreshItem, refreshHfDiscussion } = await import("../api");
        const r = await refreshItem(id);
        if (cancelled || !r.refreshed) return;
        // 等 worker 写完 D1（~100ms），再拉新数据
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (cancelled || activeIdRef.current !== id) return;
        const fresh = await fetchItem(id);
        if (cancelled || activeIdRef.current !== id) return;
        applyFresh(fresh);

        // BE 2026-05-19: hf_paper 额外异步刷评论(独立 endpoint 15s timeout,
        // 不阻塞 metrics UI)。原 refresh 已 split 砍掉 discussion,改这里
        // fire-and-forget 等 5-10s 返了再 refetch 一次拿评论 + R2 mirror img
        if (r.source_type === 'hf_paper') {
          refreshHfDiscussion(id)
            .then(async (dr) => {
              if (cancelled || !dr.refreshed || activeIdRef.current !== id) return;
              const fresh2 = await fetchItem(id);
              if (cancelled || activeIdRef.current !== id) return;
              applyFresh(fresh2);
            })
            .catch((err) => {
              // 静默,不阻塞 main flow;主 refresh 已经更过 metrics
              console.warn('hf_paper discussion refresh failed', err);
            });
        }
      } catch {
        // 静默失败
      }
    })();
    return () => { cancelled = true; };
  }, [state.item?.id]);

  return (
    <DrawerContext.Provider value={{ state, openTweet, openItem, pushItem, close, depth, spotlightItem, clearSpotlight }}>
      {children}
    </DrawerContext.Provider>
  );
}
