# C 端性能灰度验收记录模板

> 本模板只记录证据，不授权部署、DNS、D1、Pages、证书或 nginx 变更。每个外部动作仍按
> `docs/operations.md` 的对应门禁单独审批。

## 1. 变更身份与回滚

| 项 | 值 |
|---|---|
| 日期 / owner | |
| Dashboard commit / Pages deployment | |
| Worker version | |
| D1 migration 与 apply 记录 | |
| nginx config checksum / backup | |
| R2 variant version | |
| 灰度 cohort / 流量比例 | |
| 精确回滚 Dashboard / Worker / nginx / migration | |

## 2. 样本口径

分别填写 desktop/mobile、cold/warm SW、CN/非 CN、网络档位；owner、synthetic、bot 与异常导航必须
单列，不混入 all-clean。每个主 cohort 至少观察 48 小时且有 ≥100 个独立 LCP，才可判断目标是否
达到。

| cohort | 会话数 | LCP 样本 | 清洗规则 | 版本覆盖率 |
|---|---:|---:|---|---:|
| desktop cold | | | | |
| desktop warm SW | | | | |
| mobile cold | | | | |
| mobile warm SW | | | | |

## 3. 端到端时序与字节

| 指标 | baseline P50/P75/P95 | candidate P50/P75/P95 | 目标 / 结论 |
|---|---|---|---|
| FCP | | | |
| LCP | | | desktop all-clean P75 ≤3.5s；warm ≤2.5s |
| feed_ready | | | cold P75 ≤2.5s；warm ≤1.5s |
| API dns / connect / tls / ttfb / total | | | |
| Worker D1 / map / json | | | |
| nginx connect / header / response | | | |
| LCP 前 list transfer | | | desktop ≤250KiB；mobile ≤100KiB |
| GitHub 30 list gzip | | | ≤80KiB |
| high-priority images | | | ≤1 |
| LCP 前 below-fold list | | | 0 |

附五项目（desktop Chromium 1440×900、tablet Chromium 820×1180、iPhone Chromium 与 WebKit
390×844、Android Chromium 412×915）的 waterfall、trace、截图/HAR 链接；记录
400/800 图片实际尺寸/字节、DPR 1/2/3 清晰度与 CLS，另附 X 视频和播客音频 Range=206 证据。

## 4. 功能与隔离矩阵

- [ ] 匿名首页 / feed / search / suggestion / 空态 / 429 / 一次失败恢复
- [ ] 既有 Cookie、邮件验证码登录、logout；SMS 保持既定 disabled 响应
- [ ] favorite / subscription / feedback / share / 二维码
- [ ] `/t` `/g` `/ph` `/c` `/e` `/h` `/o` 与 settings/feedback 等 SPA 深链
- [ ] `/daily` `/i` robots / sitemap / llms / hashed assets 未被同源 API route 吞掉
- [ ] Drawer 拉到完整 README / deep_analysis / body，list DTO 不携带全文
- [ ] 两 Origin、两 filter、cursor、pinned、匿名/登录响应无缓存串数据
- [ ] PC 下方行滚动前无 list/media；移动 active tab 可用且真实触摸横滑正常
- [ ] saveData 不注入字体、不后台预取；字体/图片 Resource Timing 可见

## 5. 停止线与结论

任一项触发立即停止放量并执行预登记回滚：错误率增加 >0.5pp、任一主 cohort LCP 恶化 >10%、
移动 active feed 空白、登录/Cookie 回归、个性化缓存串数据、视频/音频 Range 退化、request-id/
Server-Timing 无法 join，或某地域被整体均值掩盖而显著变差。

最终决定：`继续灰度 / 全量 / 回滚 / 延长观察`。记录判断人、时间、证据链接和下一次检查点。
