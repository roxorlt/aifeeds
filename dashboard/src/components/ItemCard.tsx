import type { Item } from "../types";
import {
  LAZY_MEDIA_LOAD_POLICY,
  type MediaLoadPolicy,
} from "../lib/mediaPriority";
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
// （全页面媒体预算）设计成可选，Feed 传入、SearchPage 不传时正常降级。
//
// 注意：thread 折叠 / video coordinator 等状态不在这里 —— 单条卡片通过
// VideoColumnProvider（context）自取，thread 分组（ThreadCard）由调用方
// （Feed）在 row.kind 层面处理，本组件只负责「单条 item → 卡片」的分派。

export interface ItemCardProps {
  item: Item;
  /** Feed 显式分配；SearchPage 等调用方不传时默认 lazy/auto。 */
  mediaPolicy?: MediaLoadPolicy;
  /**
   * 单条 X 卡片是否隐藏 thread banner。Feed 的流中 thread 已由 ThreadCard 单独
   * 渲染，流里的单条推文一律隐藏 banner，故默认 true。仅对 TweetCard（默认分支）
   * 生效。
   */
  hideThreadBanner?: boolean;
}

export function ItemCard({
  item,
  mediaPolicy = LAZY_MEDIA_LOAD_POLICY,
  hideThreadBanner = true,
}: ItemCardProps) {
  switch (item.source_type) {
    case "github":
      return <GithubCard item={item} mediaPolicy={mediaPolicy} />;
    case "product_hunt":
      return <PhCard item={item} mediaPolicy={mediaPolicy} />;
    case "clawhub":
      return <ClawhubCard item={item} mediaPolicy={mediaPolicy} />;
    case "huodongxing":
      return <HuodongxingCard item={item} mediaPolicy={mediaPolicy} />;
    case "hf_paper":
      return <HfPaperCard item={item} mediaPolicy={mediaPolicy} />;
    case "blog":
      return <BlogCard item={item} mediaPolicy={mediaPolicy} />;
    case "podcast":
      return <PodcastCard item={item} mediaPolicy={mediaPolicy} />;
    default:
      return (
        <TweetCard
          item={item}
          hideThreadBanner={hideThreadBanner}
          mediaPolicy={mediaPolicy}
        />
      );
  }
}
