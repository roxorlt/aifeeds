// /admin/feedback 用户反馈看板(独立页):
//   - 顶部筛选条:搜索(用户ID/昵称/手机号/邮箱) + 状态(全部/未回复/已回复) + 查询
//   - 列表表格:ID / 时间 / 用户(昵称+identity) / 内容(截 80) / 图片缩略 / 回复数 / 最近回复 / 查看
//   - 分页:上一页/下一页 + 共 N 条
//   - 详情区(列表下方):完整内容 + 原图 + 账号快照 + device_info(<pre> JSON) + 回复线程 + 回复表单
// 数据源(§4.2 契约):GET /api/admin/feedback[?q&status&page&page_size] / GET .../:id /
//   POST .../:id/reply(multipart)。所有用户内容经客户端 esc() 转义;图片 src 仅接受 /r/ 前缀。
// 设计:docs/plans/2026-07-05-user-feedback-design.md §6

import type { Env } from './index';
import { ADMIN_SHARED_CSS, adminNavHtml, requireAuth } from './admin';

// ─── /admin/feedback HTML ───
export async function serveAdminFeedbackHtml(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return new Response(FEEDBACK_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const FEEDBACK_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-feeds admin · 用户反馈</title>
<style>
${ADMIN_SHARED_CSS}
  .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .page-head h1 { margin: 0; }

  .section { background: #11161f; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #d1d5db; }

  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .filters .label { color: #6b7280; font-size: 11px; }
  .filters input[type=text] { background: #0b0e14; border: 1px solid #374151; color: #e6e8eb;
                    font-size: 13px; padding: 6px 10px; border-radius: 4px; font-family: inherit; min-width: 240px; }
  .filters select { background: #0b0e14; border: 1px solid #374151; color: #e6e8eb;
                    font-size: 12px; padding: 5px 8px; border-radius: 4px; font-family: inherit; }
  .filters input:focus, .filters select:focus { outline: none; border-color: #6b7280; }
  .filters .count { color: #9ca3af; font-size: 12px; margin-left: auto; }

  button {
    padding: 6px 14px; border-radius: 6px; border: 1px solid #374151;
    background: #1f2937; color: #e6e8eb; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit;
  }
  button:hover { background: #374151; }
  button:disabled { opacity: .35; cursor: not-allowed; }
  button.primary { background: #1d4ed8; border-color: #1d4ed8; }
  button.primary:hover { background: #2563eb; }

  table.detail { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.detail th { text-align: left; color: #9ca3af; font-weight: 600; padding: 8px 8px;
                    border-bottom: 1px solid #1f2937; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; }
  table.detail td { padding: 8px 8px; border-bottom: 1px solid #1a1f2e; color: #e6e8eb; vertical-align: top; }
  table.detail tr:hover td { background: #161c27; }
  table.detail td.nowrap { white-space: nowrap; }
  table.detail td.content-cell { max-width: 320px; word-break: break-word; }
  .u-name { color: #e6e8eb; font-weight: 500; }
  .u-id { color: #6b7280; font-size: 11px; font-family: ui-monospace, monospace; margin-top: 2px; word-break: break-all; }
  img.thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid #1f2937; display: block; }
  button.link { background: none; border: none; color: #60a5fa; padding: 0; font-size: 12px; cursor: pointer; }
  button.link:hover { color: #93c5fd; text-decoration: underline; background: none; }

  .pager { display: flex; gap: 6px; align-items: center; margin-top: 12px; font-size: 12px; color: #9ca3af; }
  .pager button { padding: 4px 10px; font-size: 12px; }
  .empty { color: #6b7280; font-size: 12px; padding: 12px 0; }

  /* 详情区 */
  #detail { display: none; }
  .d-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .d-head .fid { font-size: 15px; font-weight: 600; color: #e6e8eb; }
  .d-head .fts { font-size: 12px; color: #6b7280; font-family: ui-monospace, monospace; }
  .d-grid { display: grid; grid-template-columns: 96px 1fr; gap: 6px 12px; font-size: 12px; margin-bottom: 14px; }
  .d-grid .k { color: #6b7280; }
  .d-grid .v { color: #e6e8eb; word-break: break-all; font-family: ui-monospace, monospace; }
  .d-block { margin-bottom: 14px; }
  .d-block .blk-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .3px; margin-bottom: 6px; }
  .d-content { white-space: pre-wrap; word-break: break-word; color: #e6e8eb; font-size: 13px; line-height: 1.6;
               background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px; padding: 10px 12px; }
  img.orig { max-width: 400px; width: 100%; border-radius: 6px; border: 1px solid #1f2937; margin-top: 6px; display: block; }
  pre.json { background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px; padding: 12px;
             margin: 0; font-size: 12px; max-height: 320px; overflow: auto; color: #d1d5db; white-space: pre-wrap; word-break: break-word; }

  .reply { background: #0b0e14; border: 1px solid #1f2937; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
  .reply-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 12px; }
  .reply-head .admin { color: #a5b4fc; font-weight: 600; }
  .reply-head .time { color: #6b7280; font-family: ui-monospace, monospace; }
  .reply-content { white-space: pre-wrap; word-break: break-word; color: #e6e8eb; font-size: 13px; line-height: 1.5; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: auto; }
  .chip.read { background: #064e3b; color: #6ee7b7; }
  .chip.unread { background: #78350f; color: #fcd34d; }

  .reply-form { margin-top: 12px; }
  .reply-form textarea { width: 100%; background: #0b0e14; border: 1px solid #374151; color: #e6e8eb;
                         padding: 8px 10px; border-radius: 6px; font-family: inherit; font-size: 13px;
                         min-height: 84px; resize: vertical; line-height: 1.5; box-sizing: border-box; }
  .reply-form textarea:focus { outline: none; border-color: #6b7280; }
  .reply-form .row { display: flex; gap: 10px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .reply-form input[type=file] { font-size: 12px; color: #9ca3af; }
  .msg { font-size: 12px; margin-top: 8px; min-height: 16px; }
  .msg.ok { color: #6ee7b7; }
  .msg.err { color: #fca5a5; }
</style>
</head>
<body>
${adminNavHtml('feedback')}
<main class="container">
  <div class="page-head">
    <h1>用户反馈</h1>
    <span class="meta" id="metaText"></span>
  </div>

  <div class="section">
    <div class="filters">
      <span class="label">搜索</span>
      <input type="text" id="fQ" placeholder="用户ID / 昵称 / 手机号 / 邮箱" />
      <span class="label">状态</span>
      <select id="fStatus">
        <option value="all">全部</option>
        <option value="pending">未回复</option>
        <option value="replied">已回复</option>
      </select>
      <button id="queryBtn">查询</button>
      <span class="count" id="listCount"></span>
    </div>
    <table class="detail" id="listTable">
      <thead>
        <tr>
          <th>ID</th><th>时间</th><th>用户</th><th>内容</th>
          <th>图片</th><th>回复数</th><th>最近回复</th><th>操作</th>
        </tr>
      </thead>
      <tbody id="listBody"><tr><td colspan="8" class="empty">loading…</td></tr></tbody>
    </table>
    <div class="pager">
      <button id="prevBtn">上一页</button>
      <span id="pageInfo">-</span>
      <button id="nextBtn">下一页</button>
    </div>
  </div>

  <div class="section" id="detail">
    <h2>反馈详情</h2>
    <div id="detailBody"></div>
  </div>
</main>
<script>
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
  });
}
async function getJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}
function fmtTs(ms) {
  if (!ms) return '-';
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
// 图片 src 只接受 /r/ 前缀值,其余(含潜在 javascript:/data: 注入)一律丢弃
function safeImg(url) {
  return (typeof url === 'string' && url.slice(0, 3) === '/r/') ? url : null;
}
function jsonPre(obj) {
  if (obj == null) return '<span class="empty">无</span>';
  var text;
  try { text = JSON.stringify(obj, null, 2); } catch (e) { text = String(obj); }
  return '<pre class="json">' + esc(text) + '</pre>';
}

var page = 1;
var PAGE_SIZE = 20;
var lastTotal = 0;
var currentDetailId = null;

async function loadList() {
  var q = document.getElementById('fQ').value.trim();
  var status = document.getElementById('fStatus').value;
  var params = new URLSearchParams({ q: q, status: status, page: String(page), page_size: String(PAGE_SIZE) });
  var body = document.getElementById('listBody');
  var data;
  try {
    data = await getJson('/api/admin/feedback?' + params.toString());
  } catch (e) {
    body.innerHTML = '<tr><td colspan="8" class="empty">加载失败: ' + esc(e.message) + '</td></tr>';
    return;
  }
  lastTotal = data.total || 0;
  var items = data.items || [];
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">无反馈数据</td></tr>';
  } else {
    body.innerHTML = items.map(function (it) {
      var content = it.content == null ? '' : String(it.content);
      var short = content.length > 80 ? content.slice(0, 80) + '…' : content;
      var img = safeImg(it.image_url);
      var imgCell = img
        ? '<a href="' + esc(img) + '" target="_blank" rel="noopener"><img class="thumb" src="' + esc(img) + '"></a>'
        : '-';
      var identity = it.identity || it.user_id || '';
      return '<tr>' +
        '<td>' + esc(it.id) + '</td>' +
        '<td class="nowrap">' + fmtTs(it.created_at) + '</td>' +
        '<td><div class="u-name">' + esc(it.display_name || '(无昵称)') + '</div>' +
          '<div class="u-id">' + esc(identity) + '</div></td>' +
        '<td class="content-cell">' + esc(short) + '</td>' +
        '<td>' + imgCell + '</td>' +
        '<td>' + esc(it.reply_count || 0) + '</td>' +
        '<td class="nowrap">' + fmtTs(it.last_reply_at) + '</td>' +
        '<td><button class="link" onclick="showDetail(' + Number(it.id) + ')">查看</button></td>' +
        '</tr>';
    }).join('');
  }
  document.getElementById('listCount').textContent = '共 ' + lastTotal + ' 条';
  var start = lastTotal === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  var end = Math.min(page * PAGE_SIZE, lastTotal);
  document.getElementById('pageInfo').textContent = start + '-' + end + ' / ' + lastTotal;
  document.getElementById('prevBtn').disabled = page <= 1;
  document.getElementById('nextBtn').disabled = end >= lastTotal;
}

async function showDetail(id) {
  currentDetailId = id;
  var box = document.getElementById('detail');
  box.style.display = 'block';
  var bodyEl = document.getElementById('detailBody');
  bodyEl.innerHTML = '<div class="empty">加载中…</div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  var data;
  try {
    data = await getJson('/api/admin/feedback/' + encodeURIComponent(id));
  } catch (e) {
    bodyEl.innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + '</div>';
    return;
  }
  renderDetail(data.feedback || {}, data.replies || []);
}

function renderDetail(f, replies) {
  var img = safeImg(f.image_url);
  var imgHtml = img
    ? '<div class="d-block"><div class="blk-label">图片</div>' +
      '<a href="' + esc(img) + '" target="_blank" rel="noopener"><img class="orig" src="' + esc(img) + '"></a></div>'
    : '';

  var repHtml = replies.length
    ? replies.map(function (r) {
        var rimg = safeImg(r.image_url);
        var rimgHtml = rimg
          ? '<a href="' + esc(rimg) + '" target="_blank" rel="noopener"><img class="orig" src="' + esc(rimg) + '"></a>'
          : '';
        var readChip = r.read_at
          ? '<span class="chip read">用户已读 ' + fmtTs(r.read_at) + '</span>'
          : '<span class="chip unread">用户未读</span>';
        return '<div class="reply">' +
          '<div class="reply-head"><span class="admin">' + esc(r.admin_email || '(admin)') + '</span>' +
            '<span class="time">' + fmtTs(r.created_at) + '</span>' + readChip + '</div>' +
          '<div class="reply-content">' + esc(r.content) + '</div>' + rimgHtml +
          '</div>';
      }).join('')
    : '<div class="empty">暂无回复</div>';

  var html =
    '<div class="d-head"><span class="fid">反馈 #' + esc(f.id) + '</span>' +
      '<span class="fts">' + fmtTs(f.created_at) + '</span></div>' +
    '<div class="d-grid">' +
      '<span class="k">用户 ID</span><span class="v">' + esc(f.user_id || '-') + '</span>' +
      '<span class="k">昵称</span><span class="v">' + esc(f.display_name || '-') + '</span>' +
      '<span class="k">identity</span><span class="v">' + esc(f.identity || '-') + '</span>' +
      '<span class="k">IP</span><span class="v">' + esc(f.ip || '-') + '</span>' +
      '<span class="k">UA</span><span class="v">' + esc(f.ua || '-') + '</span>' +
    '</div>' +
    '<div class="d-block"><div class="blk-label">反馈内容</div>' +
      '<div class="d-content">' + esc(f.content || '') + '</div></div>' +
    imgHtml +
    '<div class="d-block"><div class="blk-label">账号快照 (account_info)</div>' + jsonPre(f.account_info) + '</div>' +
    '<div class="d-block"><div class="blk-label">设备信息 (device_info)</div>' + jsonPre(f.device_info) + '</div>' +
    '<div class="d-block"><div class="blk-label">回复线程 (' + replies.length + ')</div>' + repHtml + '</div>' +
    '<div class="reply-form">' +
      '<div class="blk-label">回复用户</div>' +
      '<textarea id="replyText" maxlength="5000" placeholder="输入回复内容(≤5000 字)"></textarea>' +
      '<div class="row">' +
        '<input type="file" id="replyImage" accept="image/jpeg,image/png,image/webp,image/gif">' +
        '<button class="primary" id="replyBtn" onclick="submitReply()">回复用户</button>' +
      '</div>' +
      '<div class="msg" id="replyMsg"></div>' +
    '</div>';

  document.getElementById('detailBody').innerHTML = html;
}

async function submitReply() {
  var id = currentDetailId;
  if (!id) return;
  var text = document.getElementById('replyText').value.trim();
  var msg = document.getElementById('replyMsg');
  var btn = document.getElementById('replyBtn');
  if (!text) { msg.textContent = '回复内容不能为空'; msg.className = 'msg err'; return; }
  var fd = new FormData();
  fd.append('content', text);
  var fileEl = document.getElementById('replyImage');
  if (fileEl.files && fileEl.files[0]) fd.append('image', fileEl.files[0]);
  msg.textContent = '提交中…'; msg.className = 'msg';
  btn.disabled = true;
  try {
    // multipart:FormData 交给浏览器自动带 boundary,不手动设 Content-Type
    var r = await fetch('/api/admin/feedback/' + encodeURIComponent(id) + '/reply', {
      method: 'POST', credentials: 'include', body: fd,
    });
    var j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      msg.textContent = '回复失败: ' + esc(j.error || r.status);
      msg.className = 'msg err';
      btn.disabled = false;
      return;
    }
    msg.textContent = '回复成功';
    msg.className = 'msg ok';
    await showDetail(id); // 刷新详情(含新回复)
    await loadList();     // 刷新列表(回复数 / 最近回复)
  } catch (e) {
    msg.textContent = '回复失败: ' + esc(e.message || e);
    msg.className = 'msg err';
    btn.disabled = false;
  }
}

document.getElementById('queryBtn').addEventListener('click', function () { page = 1; loadList(); });
document.getElementById('fStatus').addEventListener('change', function () { page = 1; loadList(); });
document.getElementById('fQ').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { page = 1; loadList(); }
});
document.getElementById('prevBtn').addEventListener('click', function () { if (page > 1) { page -= 1; loadList(); } });
document.getElementById('nextBtn').addEventListener('click', function () { page += 1; loadList(); });

function setMeta() {
  document.getElementById('metaText').textContent =
    location.host + ' · ' + new Date().toLocaleString('zh-CN', { hour12: false });
}
setMeta();
setInterval(setMeta, 30000);
loadList();
</script>
</body>
</html>`;
