# 每日精选 API（`/api/digest/daily`）调用说明

> 给下游调用方（含 AI agent）的对外接口文档。2026-06-01 上 prod（commit `6246e28`）。
> 运维登记见 [`operations.md`](operations.md) §「订阅推送子系统」。

## 鉴权 key

key 为了安全，从本地 `/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env` 文件里读 `DIGEST_API_KEY` 字段的值。读取命令：

```bash
grep '^DIGEST_API_KEY=' /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env | cut -d= -f2
```

> staging 环境同理，key 在 `.secrets/aifeeds-staging.env`，接口域名换成 `staging-api.ai-feeds.com`。

## 接口

- **地址**：`GET https://api.ai-feeds.com/api/digest/daily`
- **鉴权**：请求头带 `Authorization: Bearer <上面读到的 key>`。没带或带错一律返回 `401`。
- **作用**：返回「此刻往前 24 小时」的 AI 资讯精选，按 5 个来源分组（热门产品 `ph` / 开源项目 `gh` / 论文 `hf-paper` / 龙虾技能 `clawhub` / 动态 `x`）。**实时计算，不是历史某天的存档。**

## 查询参数（都可选）

| 参数 | 取值 | 默认 | 说明 |
|------|------|------|------|
| `density` | `normal` / `curated` / `both` | `both` | `normal`=默认档（每源条数多）；`curated`=AI 精选档（更少更精，慢约 8 秒）；`both`=两档都返回 |
| `sources` | 逗号分隔，如 `ph,gh` | 全部 5 源 | 只取指定来源 |
| `verbose` | `1` | 不带 | 带 `1` 时每条额外附 `raw` 原始字段（标题原文、完整正文、媒体、metrics、extra 等），用于调试 |

## 调用示例

**curl**：

```bash
KEY=$(grep '^DIGEST_API_KEY=' /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env | cut -d= -f2)

curl -H "Authorization: Bearer $KEY" \
  "https://api.ai-feeds.com/api/digest/daily?density=normal"
```

**Python**：

```python
import subprocess, requests

key = subprocess.check_output(
    "grep '^DIGEST_API_KEY=' /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env | cut -d= -f2",
    shell=True, text=True).strip()

r = requests.get(
    "https://api.ai-feeds.com/api/digest/daily",
    headers={"Authorization": f"Bearer {key}"},
    params={"density": "normal"},   # 或 "curated" / "both"
    timeout=30,                      # curated 档约需 8 秒，超时给够
)
r.raise_for_status()
data = r.json()
```

## 返回 JSON 结构

```jsonc
{
  "meta": {
    "mode": "realtime",
    "generated_at": "2026-06-01 19:19:58 (BJT)",
    "density": "normal",
    "source_order": ["ph", "gh", "hf-paper", "clawhub", "x"],
    "source_labels": { "ph": "热门产品", "gh": "开源项目", "hf-paper": "论文", "clawhub": "龙虾技能", "x": "动态" }
  },
  "sections": {
    "normal": [                       // density=curated 时这里是 "curated"；both 时两个都有
      {
        "source": "gh",
        "source_label": "开源项目",
        "count": 5,
        "items": [
          {
            "rank": 1,                                   // 该来源内的热度排名，1 最热
            "item_id": "github:nesquena/hermes-webui",
            "source": "gh",
            "title": "hermes-webui",                     // 标题（中文，产品名/项目名保留英文）
            "summary": "……",                            // 简介，已截断到约 180 字
            "summary_full": "……",                       // 完整简介（不截断，适合详情页）
            "url": "https://github.com/nesquena/hermes-webui",  // 原文外链
            "deep_link": "/g/nesquena/hermes-webui",     // aifeeds 站内详情路径，拼 https://ai-feeds.com 前缀即完整链接
            "author": "nesquena",
            "cover": "https://avatars.githubusercontent.com/nesquena"  // 封面图 URL，无图时为 null
          }
        ]
      }
    ]
  }
}
```

## 注意事项

1. 遍历顺序按 `meta.source_order`；每个 source 段里 `items` 已按 `rank` 升序（1 最热）。
2. `cover` 可能为 `null`（动态 `x` 和龙虾技能 `clawhub` 没有合适封面时留空），渲染时要判空。
3. `deep_link` 是站内相对路径：要跳 aifeeds 详情页就拼成 `https://ai-feeds.com` + `deep_link`；要跳原文用 `url`。
4. 论文（`hf-paper`）这一段有时为空（数据时间窗原因），属正常，按「该源无内容」处理即可。
5. 同样参数 **15 分钟内返回缓存**（响应头 `X-Cache: HIT` 表示命中）。高频重复调用不会拿到更新数据、也不重复消耗算力——定时取（每天几次）即可。
6. `density=curated` 或 `both` 会触发 AI 实时精选，单次响应约 8 秒，**请求超时给到 30 秒以上**。

## 设计说明（维护者向）

- 实现：`worker/src/digest/daily-api.ts`（handler）+ `worker/src/digest/render.ts`（渲染纯函数：rank / cover / 中文 title-summary）。
- 选品复用 `selection.ts`（normal 纯 SQL 热度排序）+ `llm-curate.ts`（curated 走 DeepSeek）。
- 缓存走 `AUTH_KV`，key 形如 `digestapi:v1:<density>:<sources>:<15min窗口>`，TTL 900s；`verbose` 不缓存。
- cover 取值规则：`ph`=媒体 logo（R2 路径拼 `API_BASE`）/ `gh`=`avatars.githubusercontent.com/{owner}` / `hf-paper`=社交缩略图 / `x`=推文附图（无图 null，不用头像）/ `clawhub`=null（不用头像）。
