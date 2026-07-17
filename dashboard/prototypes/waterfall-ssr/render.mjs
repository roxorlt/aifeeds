import { INITIAL_ITEMS, SOURCE_ORDER } from "./fixtures.mjs";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function renderLogo() {
  return `<svg aria-hidden="true" class="brand-mark" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="9" fill="#ff8a00"/>
    <path d="M8 10.5h16M8 16h12M8 21.5h9" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="2.6"/>
  </svg>`;
}

function renderSwitchButton(mode, target) {
  const active = mode === target;
  const label = target === "classic" ? "经典" : "瀑布";
  return `<button type="button" data-select-view="${target}" aria-pressed="${active}"${active ? " class=\"is-active\"" : ""}>${label}</button>`;
}

function renderHeader(mode) {
  return `<header class="appbar">
    <a class="brand" href="/" aria-label="AI-Feeds 首页">
      ${renderLogo()}
      <span><strong>AI-Feeds</strong><small>专注 AI 领域信息聚合</small></span>
    </a>
    <div class="appbar-actions">
      <nav class="view-switch view-switch--desktop" aria-label="首页视图">
        ${renderSwitchButton(mode, "classic")}
        ${renderSwitchButton(mode, "waterfall")}
      </nav>
      <button class="icon-button" type="button" aria-label="搜索">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
      </button>
      <button class="account-button" type="button" aria-label="账户">R</button>
      <details class="view-menu view-menu--mobile">
        <summary>视图</summary>
        <div role="group" aria-label="首页视图">
          ${renderSwitchButton(mode, "classic")}
          ${renderSwitchButton(mode, "waterfall")}
        </div>
      </details>
    </div>
  </header>`;
}

function renderImage(image) {
  if (!image) return "";
  return `<figure class="card-media"><img src="${escapeHtml(image.src)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(image.alt)}" decoding="async"></figure>`;
}

function renderCard(item) {
  return `<article class="feed-card" data-source="${escapeHtml(item.source)}">
    <div class="card-kicker"><span>${escapeHtml(item.sourceLabel)}</span><time>${escapeHtml(item.meta)}</time></div>
    <h3>${escapeHtml(item.title)}</h3>
    <p>${escapeHtml(item.summary)}</p>
    ${renderImage(item.image)}
    <footer><span>${escapeHtml(item.tag ?? "AI")}</span><span>${escapeHtml(item.metric ?? "")}</span></footer>
  </article>`;
}

function renderClassic(items) {
  const populated = SOURCE_ORDER
    .map((label) => [label, items.filter((item) => item.sourceLabel === label)])
    .filter(([, sourceItems]) => sourceItems.length > 0);
  return `<main id="content" data-rendered="server" data-layout="classic" tabindex="-1">
    <div class="classic-intro"><p>按来源浏览</p><span>每列独立更新</span></div>
    <div class="classic-grid">
      ${populated.map(([label, sourceItems]) => `<section class="source-column" aria-labelledby="source-${escapeHtml(sourceItems[0].source)}">
        <header><h2 id="source-${escapeHtml(sourceItems[0].source)}">${escapeHtml(label)}</h2><span>${sourceItems.length} 条</span></header>
        ${sourceItems.map(renderCard).join("")}
      </section>`).join("")}
    </div>
  </main>`;
}

function renderWaterfall(items) {
  return `<main id="content" data-rendered="server" data-layout="waterfall" tabindex="-1">
    <div class="waterfall-intro">
      <div><p>今日 AI 动态</p><h1>一个连续的信息流</h1></div>
      <span>综合时间、热度与信息密度</span>
    </div>
    <section class="waterfall-grid" aria-label="AI 动态瀑布流">
      ${items.map(renderCard).join("")}
    </section>
  </main>`;
}

export function renderDocument({ mode = "classic", items = INITIAL_ITEMS } = {}) {
  if (!new Set(["classic", "waterfall"]).has(mode)) throw new Error("invalid view mode");
  const initialData = { view_mode: mode, generated_at: "2026-07-17T00:00:00.000Z", items };
  const content = mode === "waterfall" ? renderWaterfall(items) : renderClassic(items);
  return `<!doctype html>
<html lang="zh-CN" data-view-mode="${mode}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#fafafa">
  <title>AI-Feeds · ${mode === "classic" ? "经典版" : "瀑布版"} SSR 原型</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a class="skip-link" href="#content">跳到内容</a>
  ${renderHeader(mode)}
  <div class="prototype-note" role="note"><strong>本地原型</strong><span>首屏卡片来自服务器 HTML，当前生产不受影响。</span></div>
  ${content}
  <p class="switch-status" role="status" aria-live="polite"></p>
  <script id="aifeeds-initial-data" type="application/json">${safeJson(initialData)}</script>
  <script type="module" src="/client.mjs"></script>
</body>
</html>`;
}
