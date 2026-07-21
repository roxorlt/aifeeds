# 瀑布流临近底部自动分页设计

## 目标

瀑布流用户接近当前列表底部时自动加载下一页，不要求点击“加载更多”。现有按钮继续保留为
无 `IntersectionObserver`、离线、请求失败和辅助技术用户的兜底入口。

## 方案比较

1. `IntersectionObserver` + 末端哨兵（采用）：浏览器只在哨兵进入预加载区域时通知，PC 和移动端
   共用同一逻辑，避免高频 scroll 计算。
2. scroll listener + 距离计算：可精确控制距离，但每次滚动都要读取布局，容易与现有瀑布流测量和
   移动端 `#root` 滚动容器相互影响。
3. 删除按钮、只保留无限滚动：界面最简，但网络失败、API 不可用和键盘操作时缺少明确恢复入口。

## 交互与数据流

- `WaterfallHome` 在分页区域挂一个稳定哨兵，使用 `getIntersectionRoot()`：移动端观察 `#root`，
  PC 观察 viewport。
- 订阅 `767px` 响应式断点；设备旋转或窗口跨断点时销毁旧观察器，并按新的滚动根重建。
- 观察器在 hydration 后立即启用；如果首屏内容不足、哨兵本来就在临近区域，也应直接补足下一页，
  不能依赖一次实际上不会发生的 scroll 事件。
- 哨兵进入距视口约 `600px` 的区域时调用现有 `fetchHomeFeedPage()`，每页仍为 24 条。
- 同步 ref 在 React 状态提交前就锁住在途请求，防止同一批 observer 回调发出重复请求。
- 成功后按现有 ID 去重并推进 cursor；如果追加后哨兵仍在预加载区，允许继续填充到离开临近区域。
- 页面隐藏或浏览器离线时不自动发请求；恢复可见或重新上线后重新检查哨兵。

## 错误与可访问性

- 自动请求失败后暂停自动重试，按钮文案变为“重试加载”，避免弱网下形成请求循环。
- 手动重试成功后重新启用自动观察。
- 加载中按钮保持 disabled 和“正在加载…”；`aria-live` 继续播报失败状态。
- `IntersectionObserver` 不可用时不改变现有按钮行为。

## 验证

- Playwright：初始 12 张卡；滚动分页区域进入临近范围后自动变为 20 张，且只发出一个分页 GET。
- Playwright：按钮在自动触发前仍可见，分页后 Drawer 深链交互保持不变。
- 契约测试：移动端使用项目滚动根、存在有界 root margin、失败后不自动重试、保留手动按钮。
- 完整 Dashboard 单测、lint、SSR build 和五设备 waterfall 浏览器矩阵。

## 发布结果

- PR #206 合入 `main`，merge commit `cf0223e11c51eec4e7fa98051494b603d815cae6`。
- 本地：368/368 单测、lint、SSR build、55/55 五设备 Playwright。
- staging：25/25 五设备远程矩阵，包含自动分页和移动/PC observer 根切换。
- production：GitHub Actions run `29685573287` 成功；桌面 Chromium、移动 WebKit 均从 24 张
  自动追加至 48 张，各新增 1 次分页 GET；移动 `#root` → PC viewport 重绑定通过。
