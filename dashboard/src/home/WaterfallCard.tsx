import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
} from "react";
import { SourceIcon } from "../components/icons";
import { useDrawer } from "../lib/drawerContext";
import { EVENTS, track } from "../lib/telemetry";
import { useImpression } from "../lib/telemetry/impressions";
import type { Item } from "../types";
import {
  createExposureHistory,
  evaluateAndRecordExposure,
  evaluateExposureShadow,
} from "./exposureShadow";
import { homePathForItem } from "./itemPath";
import {
  estimateMasonryHeight,
  masonryRowSpan,
  nonShrinkingMasonrySpan,
} from "./masonry";
import { getWaterfallCardModel } from "./waterfallCardModel";

type Props = Readonly<{
  item: Item;
  siblings: Item[];
  position: number;
}>;

export function WaterfallCard({ item, siblings, position }: Props) {
  const { openItem } = useDrawer();
  const cardRef = useRef<HTMLLIElement>(null);
  const model = getWaterfallCardModel(item);
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
  const recordSignal = (kind: "impression" | "consumed") => {
    const neutral = evaluateExposureShadow(item, createExposureHistory());
    if (typeof window === "undefined") return neutral;
    try {
      return evaluateAndRecordExposure(window.localStorage, item, kind);
    } catch {
      return neutral;
    }
  };
  const impressionRef = useImpression(() => {
    const decision = recordSignal("impression");
    track(EVENTS.ITEM_IMPRESSION, {
      item_id: item.id,
      source: item.source_type,
      family: decision.family,
      view_mode: "waterfall",
      shadow_filter_reason: decision.reason,
      shadow_rule_version: decision.ruleVersion,
      shadow_disposition: decision.disposition,
    });
  });
  const setCardRef = useCallback((node: HTMLLIElement | null) => {
    cardRef.current = node;
    impressionRef(node);
  }, [impressionRef]);

  useEffect(() => {
    const element = cardRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const updateSpan = () => {
      const currentSpan = Number.parseInt(
        element.style.getPropertyValue("--waterfall-row-span"),
        10,
      );
      const nextSpan = nonShrinkingMasonrySpan(
        currentSpan,
        element.getBoundingClientRect().height,
      );
      if (nextSpan !== currentSpan) {
        element.style.setProperty("--waterfall-row-span", String(nextSpan));
      }
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
    ) return;
    recordSignal("consumed");
    track(EVENTS.ITEM_CLICK, {
      item_id: item.id,
      source: item.source_type,
      view_mode: "waterfall",
    });
    if (
      event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    openItem(item, siblings);
  };

  const image = model.image ? (
    <img
      className="waterfall-card__image"
      src={model.image.src}
      width={model.image.width}
      height={model.image.height}
      alt={model.image.alt}
      loading={position < 4 ? "eager" : "lazy"}
      fetchPriority={position < 2 ? "high" : "auto"}
      decoding="async"
    />
  ) : null;
  const accessibleTitle = model.title || model.summary || model.identity;

  return (
    <li
      ref={setCardRef}
      className="waterfall-card"
      data-item-id={item.id}
      data-source={item.source_type}
      style={{
        "--waterfall-row-span": masonryRowSpan(estimatedHeight),
      } as React.CSSProperties}
    >
      <article>
        <a
          className="waterfall-card__link"
          href={path}
          onClick={handleClick}
          aria-label={`${accessibleTitle}，打开详情`}
        >
          {model.mediaPosition === "before_text" ? image : null}
          <div className="waterfall-card__body">
            <header className="waterfall-card__identity">
              <span className="waterfall-card__source-icon" aria-hidden="true">
                <SourceIcon source_type={item.source_type} />
              </span>
              <span className="waterfall-card__identity-copy">
                <strong>{model.identity}</strong>
                {model.secondaryIdentity && <small>{model.secondaryIdentity}</small>}
              </span>
              <time dateTime={item.published_at ?? item.scraped_at}>{model.meta}</time>
            </header>
            {model.title && <h2>{model.title}</h2>}
            {model.summary && <p>{model.summary}</p>}
            {model.mediaPosition === "after_text" ? image : null}
            {model.metrics.length > 0 && (
              <footer className="waterfall-card__metrics" aria-label="内容指标">
                {model.metrics.map((metric) => (
                  <span key={`${metric.label}:${metric.value}`}>
                    <b>{metric.label}</b>
                    {metric.value}
                  </span>
                ))}
              </footer>
            )}
          </div>
        </a>
      </article>
    </li>
  );
}
