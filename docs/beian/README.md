# ai-feeds.cc 备案资料

> 长期参考文件，未来 footer / 微信开放平台 / 短信签名 / 其他合规场景反复用。
> 讨论过程见 [`../memo/2026-05-04-icp-备案讨论备忘录.md`](../memo/2026-05-04-icp-备案讨论备忘录.md)。
>
> ⚠️ 仅适用于 **ai-feeds.cc**（腾讯云轻量服务器，82.156.0.68）。`ai-feeds.com`（Cloudflare）境外节点不需要备案，**不要把这套 footer 放到 dashboard/ 上**。

## 备案号（下证日期：2026-05-13）

| 类别 | 编号 | 主管机关 | 查询链接 |
|------|------|---------|---------|
| ICP 备案 | **京ICP备2025123594号-2** | 工信部 | https://beian.miit.gov.cn/#/Integrated/index |
| 公安联网备案 | **京公网安备11010802048455号** | 公安部 | https://beian.mps.gov.cn/#/query/webSearch?code=11010802048455 |

- 备案主体：科赞源信（企业名，备案后台 + 短信签名用）
- 网站对外品牌：AI源信（footer / 页面 logo / title 用）
- 公安备案 30 个工作日硬截止：**约 2026-06-24 前必须把公安备案号 + 图标贴上 footer**（不贴会被取消备案）

## Footer 标准格式

公安部官方要求：**图标在前，编号在右；公安在左，ICP 在右**（参考北京政府备案 footer 排版）。完整 footer 标准片段（工信部 + 公安双备案），可直接放 `<footer>` 底部：

```html
<div class="beian">
  <a href="https://beian.mps.gov.cn/#/query/webSearch?code=11010802048455" rel="noreferrer" target="_blank">
    <img src="/assets/gongan-icon.png" alt="公安备案图标" width="14" height="16" style="vertical-align: middle; margin-right: 4px;">
    京公网安备11010802048455号
  </a>
  <a href="https://beian.miit.gov.cn/#/Integrated/index" rel="noreferrer" target="_blank">京ICP备2025123594号-2</a>
</div>
```

样式建议（footer 已有 grayscale 文字时直接继承）：

```css
.beian { display: flex; gap: 16px; align-items: center; justify-content: center; font-size: 12px; color: #999; }
.beian a { color: inherit; text-decoration: none; }
.beian a:hover { text-decoration: underline; }
```

## 资源文件

公安图标 `gongan-icon.png`（36×40 PNG）的版本化副本在 [`../../cc-site/assets/gongan-icon.png`](../../cc-site/assets/gongan-icon.png)，跟 5 个静态页一起部署到 `/www/wwwroot/ai-feeds.cc/assets/gongan-icon.png`。

## 部署流程

`.cc` 站点源文件已纳入仓库 [`../../cc-site/`](../../cc-site/) 目录。改完跑：

```bash
cd cc-site/ && ./deploy.sh
```

脚本会 scp + chown + chmod 一气呵成 + 跑 curl smoke 检查。

详细工作流见 [`../../cc-site/README.md`](../../cc-site/README.md)。
