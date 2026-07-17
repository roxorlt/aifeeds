import {
  useEffect,
  useRef,
  type MouseEvent,
} from "react";
import { useDrawer } from "../lib/drawerContext";
import type { Item } from "../types";
import { getHomeCardModel } from "./homeData";
import { homePathForItem } from "./itemPath";
import {
  estimateMasonryHeight,
  masonryRowSpan,
} from "./masonry";

type Props = Readonly<{
  item: Item;
  siblings: Item[];
  position: number;
}>;

export function WaterfallCard({ item, siblings, position }: Props) {
  const { openItem } = useDrawer();
  const cardRef = useRef<HTMLLIElement>(null);
  const model = getHomeCardModel(item);
  const path = homePathForItem(item) ?? "/";
  const aspectRatio = model.image ? model.image.width / model.image.height : null;
  const estimatedHeight = estimateMasonryHeight(
    {
      ...item,
      title: model.title,
      content: model.summary,
      content_translated: null,
    },
    aspectRatio ? { aspectRatio } : null,
  );

  useEffect(() => {
    const element = cardRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const updateSpan = () => {
      element.style.setProperty("--waterfall-row-span", String(
        masonryRowSpan(element.getBoundingClientRect().height),
      ));
    };
    updateSpan();
    const observer = new ResizeObserver(updateSpan);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    openItem(item, siblings);
  };

  return (
    <li
      ref={cardRef}
      className="waterfall-card"
      data-source={item.source_type}
      style={{
        "--waterfall-row-span": masonryRowSpan(estimatedHeight),
      } as React.CSSProperties}
    >
      <article>
        <header className="waterfall-card__meta">
          <span>{model.sourceLabel}</span>
          <time dateTime={item.published_at ?? item.scraped_at}>{model.meta}</time>
        </header>
        <a
          className="waterfall-card__link"
          href={path}
          onClick={handleClick}
          aria-label={`${model.title}，打开详情`}
        >
          <h2>{model.title}</h2>
          {model.summary && <p>{model.summary}</p>}
          {model.image && (
            <img
              src={model.image.src}
              width={model.image.width}
              height={model.image.height}
              alt={model.image.alt}
              loading={position < 4 ? "eager" : "lazy"}
              fetchPriority={position < 2 ? "high" : "auto"}
              decoding="async"
            />
          )}
        </a>
      </article>
    </li>
  );
}
