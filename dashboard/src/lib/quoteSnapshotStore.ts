// PR3 quote snapshot modal store
//
// 嵌套引用小卡(QuotedTweet)点击不再跳 X,改成打开站内 modal 展示 quote 完整
// 内容(数据从 extra.retweet_of.quote_of / extra.quote_of 已有 snapshot 取,
// 不调 API)。
//
// 设计:
// - 全局只有一个 modal,store 持当前打开的 QuoteOf snapshot
// - 关闭 = quote 置 null,modal unmount
// - 不持 URL 同步(snapshot 没独立 deeplink — quote 推文可能不在 items 表)
// - 跟 DrawerProvider 独立,避免污染 main drawer 路由逻辑
//
// 后续若决定演进到方案 A (每条 quote 入库独立 item),可以把 modal 切换成
// "命中 items 表 → 跳 /t/{id} 走 TweetDrawer / 未命中 → 走本 modal" 双轨。

import { create } from 'zustand';
import type { QuoteOf } from '../types';

interface QuoteSnapshotStore {
  quote: QuoteOf | null;
  open: (q: QuoteOf) => void;
  close: () => void;
}

export const useQuoteSnapshotStore = create<QuoteSnapshotStore>((set) => ({
  quote: null,
  open: (q) => set({ quote: q }),
  close: () => set({ quote: null }),
}));
