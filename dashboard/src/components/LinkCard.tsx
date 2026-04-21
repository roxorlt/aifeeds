import { useState } from "react";
import type { LinkCard as LinkCardType } from "../types";
import { proxyImg } from "../lib/utils";

interface Props {
  card: LinkCardType;
}

export function LinkCard({ card }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const title = card.title_translated || card.title;
  const description = card.description_translated || card.description;
  const href = card.url || undefined;
  const domainLabel = card.display_url || card.domain || "";

  if (!title && !description && !card.image_url) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="mt-2.5 block overflow-hidden rounded-2xl border border-neutral-200 bg-white transition-colors hover:bg-neutral-50"
    >
      {card.image_url && !imageFailed && (
        <img
          src={proxyImg(card.image_url)}
          alt=""
          loading="lazy"
          className="aspect-[1.91/1] w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className="p-3">
        {domainLabel && (
          <div className="mb-0.5 truncate text-[12px] text-neutral-500">
            {domainLabel}
          </div>
        )}
        {title && (
          <div className="line-clamp-2 text-[14px] font-medium text-neutral-900">
            {title}
          </div>
        )}
        {description && (
          <div className="mt-0.5 line-clamp-2 text-[13px] leading-[1.45] text-neutral-600">
            {description}
          </div>
        )}
      </div>
    </a>
  );
}
