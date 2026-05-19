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
  return {
    // 网络
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
