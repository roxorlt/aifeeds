import type { Item } from "../types";
import { TweetCard } from "./TweetCard";
import { GithubCard } from "./GithubCard";
import { PhCard } from "./PhCard";
import { ClawhubCard } from "./ClawhubCard";
import { HuodongxingCard } from "./HuodongxingCard";
import { HfPaperCard } from "./HfPaperCard";
import { BlogCard } from "./BlogCard";
import { PodcastCard } from "./PodcastCard";

// 公共卡片分派组件（Task 9 从 Feed.tsx 的 switch 抽出，纯重构，props 与原
// switch 逐分支对齐）。按 item.source_type 选对应卡片；Feed 特有的注入属性
// （eager 首屏 LCP 优化）设计成可选，Feed 传入、SearchPage 不传时正常降级。
//
// 注意：thread 折叠 / video coordinator 等状态不在这里 —— 单条卡片通过
// VideoColumnProvider（context）自取，thread 分组（ThreadCard）由调用方
// （Feed）在 row.kind 层面处理，本组件只负责「单条 item → 卡片」的分派。

export interface ItemCardProps {
  item: Item;
  /**
   * Feed 首屏前 3 张卡传 true：封面图 eager + fetchPriority=high，不参与 lazy
   * 排队（LCP 优化）。SearchPage 等调用方不传 → 默认 lazy 加载。
   */
  eager?: boolean;
  /**
   * 单条 X 卡片是否隐藏 thread banner。Feed 的流中 thread 已由 ThreadCard 单独
   * 渲染，流里的单条推文一律隐藏 banner，故默认 true。仅对 TweetCard（默认分支）
   * 生效。
   */
  hideThreadBanner?: boolean;
}

export function ItemCard({ item, eager, hideThreadBanner = true }: ItemCardProps) {
  switch (item.source_type) {
    case "github":
      return <GithubCard item={item} eager={eager} />;
    case "product_hunt":
      return <PhCard item={item} eager={eager} />;
    case "clawhub":
      return <ClawhubCard item={item} />;
    case "huodongxing":
      return <HuodongxingCard item={item} eager={eager} />;
    case "hf_paper":
      return <HfPaperCard item={item} eager={eager} />;
    case "blog":
      return <BlogCard item={item} eager={eager} />;
    case "podcast":
      return <PodcastCard item={item} eager={eager} />;
    default:
      return <TweetCard item={item} hideThreadBanner={hideThreadBanner} eager={eager} />;
  }
}
