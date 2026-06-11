// 性能指标接入：web-vitals 库捕获 LCP/FCP/INP/CLS/TTFB,挂到 telemetry queue
//
// PM 2026-05-19 反馈"骨架屏卡几分钟",2026-05-20 决定接通 RUM 性能埋点辅助定位。
// 采样率初期 100%(等数据量够大再降)。每条 metric 附 device meta(connection /
// saveData / deviceMemory / hardwareConcurrency),让 admin 能按网络/设备切片分位:
//   - 4G vs slow-2g/3g/4g 各分位的 LCP/TTFB
//   - saveData=true(用户主动省流模式)是否更慢
//   - deviceMemory <= 2GB 老机型 vs 8GB 旗舰 INP 差异
// 用这些维度能精准定位"是哪个用户群体卡"

import { onLCP, onINP, onCLS, onTTFB, onFCP, type Metric } from 'web-vitals';
import { track } from './index';
import { EVENTS } from './event-types';

const SAMPLE_RATE = 1.0;  // 初期 100%,数据足后调回 0.1

// 浏览器 ext: navigator.connection / .deviceMemory / .hardwareConcurrency
// 不在 TS lib.dom 标准里,需要手 cast
interface ConnectionInfo {
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}
interface NavigatorPerf {
  connection?: ConnectionInfo;
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

function deviceMeta(): Record<string, unknown> {
  const nav = navigator as Navigator & NavigatorPerf;
  const c = nav.connection;
  const ua = navigator.userAgent;
  return {
    // 网络（⚠️ iOS 微信 WKWebView 无 navigator.connection → 这几项 undefined,
    // admin 切片时 nettype=NULL 要单独归一桶,不能丢）
    nettype: c?.effectiveType,
    downlink_mbps: c?.downlink,
    rtt_ms: c?.rtt,
    save_data: c?.saveData,
    // 设备
    device_memory_gb: nav.deviceMemory,
    cpu_cores: nav.hardwareConcurrency,
    // viewport
    viewport_w: window.innerWidth,
    viewport_h: window.innerHeight,
    dpr: window.devicePixelRatio,
    // 客户端识别 —— 让 admin 能把"国内微信"人群单独切出来看慢在哪
    is_wechat: /micromessenger/i.test(ua),
    is_ios: /iphone|ipad|ipod/i.test(ua),
    is_android: /android/i.test(ua),
    // 大陆 hint(非 ground truth): 时区 = Asia/Shanghai
    mainland_hint: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Shanghai';
      } catch {
        return undefined;
      }
    })(),
  };
}

export function installVitals(): void {
  if (Math.random() >= SAMPLE_RATE) return;
  onLCP(report(EVENTS.PERF_LCP));
  onINP(report(EVENTS.PERF_INP));
  onCLS(report(EVENTS.PERF_CLS));
  onTTFB(report(EVENTS.PERF_TTFB));
  onFCP(report(EVENTS.PERF_FCP));
}

// perf_nav: PerformanceNavigationTiming 全相位拆解(dns/tcp/tls/ttfb/下载/dcl/load)。
// web-vitals 的 TTFB 只有一个数,这里把"页面打开"拆成各阶段,才能区分国内慢的三种成因:
//   - 海外 POP 路由(dns+tls+ttfb 高) vs 大字体/JS 下载(response/transfer 高) vs
//     手机解析慢(responseEnd→FCP 的差)。
// ⚠️ 必须在 load 事件后读,否则 loadEventEnd=0。iOS15+/现代 X5 支持 L2 NavTiming;
// 老 Android X5 退化到 performance.timing(此处不再读,缺就略过,不影响主信号)。
export function installNavTiming(): void {
  if (Math.random() >= SAMPLE_RATE) return;
  const emit = () => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!n || n.loadEventEnd <= 0) return; // 未就绪 / 不支持
    const r = (x: number) => Math.max(0, Math.round(x));
    track(EVENTS.PERF_NAV, {
      dns: r(n.domainLookupEnd - n.domainLookupStart),
      tcp: r(n.connectEnd - n.connectStart),
      tls: n.secureConnectionStart > 0 ? r(n.connectEnd - n.secureConnectionStart) : 0,
      ttfb: r(n.responseStart - n.startTime),
      request: r(n.responseStart - n.requestStart),
      response: r(n.responseEnd - n.responseStart), // 下载耗时(对 webfont/JS 体积敏感)
      dom_interactive: r(n.domInteractive - n.startTime),
      dcl: r(n.domContentLoadedEventEnd - n.startTime),
      load: r(n.loadEventEnd - n.startTime),
      transfer_kb: r((n.transferSize || 0) / 1024),
      encoded_kb: r((n.encodedBodySize || 0) / 1024),
      nav_type: n.type, // navigate | reload | back_forward —— 量化"第二次更快"(bfcache/磁盘缓存)
      // SW 壳缓存命中(2026-06-11):1 = 本次导航由 Service Worker 直接回壳(回访秒开),
      // 0 = 走网络(新用户首开/SW 未装)。用来在面板上区分"秒开人群"和"冷连接人群"。
      sw: navigator.serviceWorker?.controller ? 1 : 0,
      ...deviceMeta(),
    });
  };
  if (document.readyState === 'complete') setTimeout(emit, 0);
  else window.addEventListener('load', () => setTimeout(emit, 0), { once: true });
}

// perf_img: 封面图(经 /img 代理)的加载耗时。图多,按 IMG_SAMPLE 采样控制事件量。
// Resource Timing 观察 /img? 资源,取 responseEnd-startTime;transferSize===0 表示
// 浏览器缓存命中(看重复浏览的缓存效果)。VPS 边缘缓存的 HIT/MISS 客户端看不到
// (CORS 不暴露响应头),但 dur 直接反映真实加载快慢 —— 用来量化"切 tab 封面图慢"。
const IMG_SAMPLE = 0.25;
export function installImgTiming(): void {
  if (Math.random() >= SAMPLE_RATE) return;
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if (!e.name.includes('/img?')) continue;
        if (Math.random() >= IMG_SAMPLE) continue;
        const dur = Math.round(e.responseEnd - e.startTime);
        if (dur <= 0) continue;
        const wMatch = e.name.match(/[?&]w=(\d+)/);
        track(EVENTS.PERF_IMG, {
          dur,
          kb: Math.round((e.transferSize || 0) / 1024),
          cached: e.transferSize === 0 && e.decodedBodySize > 0,
          w: wMatch ? Number(wMatch[1]) : undefined,
          ...deviceMeta(),
        });
      }
    });
    obs.observe({ type: 'resource', buffered: true });
  } catch {
    /* resource timing 不支持 → 略过 */
  }
}

function report(eventType: string): (metric: Metric) => void {
  // device meta 只在 install 时算一次(connection.effectiveType 用户网络切换
  // 时会变,但成本极低这里偷懒不监听 change);如需精准捕获 install 后切换可
  // 改成每次 callback 内重算 deviceMeta()
  const meta = deviceMeta();
  return (metric) => {
    track(eventType, {
      value: Math.round(metric.value * 100) / 100,
      rating: metric.rating,
      navigation_type: metric.navigationType,
      ...meta,
    });
  };
}
