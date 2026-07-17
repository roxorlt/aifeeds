import type { Item } from "../types";

export function homePathForItem(item: Item): string | null {
  switch (item.source_type) {
    case "x_list":
      return `/t/${encodeURIComponent(item.source_id)}`;
    case "github": {
      const [owner, repo, ...rest] = item.source_id.split("/");
      if (!owner || !repo || rest.length > 0) return null;
      return `/g/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    }
    case "product_hunt": {
      const separator = item.source_id.lastIndexOf(":");
      if (separator <= 0 || separator === item.source_id.length - 1) return null;
      const slug = item.source_id.slice(0, separator);
      const date = item.source_id.slice(separator + 1);
      return `/ph/${encodeURIComponent(slug)}/${encodeURIComponent(date)}`;
    }
    case "clawhub":
      return `/c/${encodeURIComponent(item.source_id)}`;
    case "huodongxing":
      return `/e/${encodeURIComponent(item.source_id)}`;
    case "hf_paper":
      return `/h/${encodeURIComponent(item.source_id)}`;
    case "blog":
    case "podcast":
      return `/o/${encodeURIComponent(item.id)}`;
    default:
      return null;
  }
}
