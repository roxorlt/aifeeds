// 性能指标接入：web-vitals 库捕获 LCP/INP/CLS/TTFB
// 设计：10% 采样上报（量大了再调）

import { onLCP, onINP, onCLS, onTTFB, type Metric } from 'web-vitals';
import { track } from './index';
import { EVENTS } from './event-types';

const SAMPLE_RATE = 0.1;  // 10%

export function installVitals(): void {
  // 每个 device_id 在初始化时决定是否采样（保持一致性，便于后续分析）
  if (Math.random() >= SAMPLE_RATE) return;

  onLCP(report(EVENTS.PERF_LCP));
  onINP(report(EVENTS.PERF_INP));
  onCLS(report(EVENTS.PERF_CLS));
  onTTFB(report(EVENTS.PERF_TTFB));
}

function report(eventType: string): (metric: Metric) => void {
  return (metric) => {
    track(eventType, {
      value: Math.round(metric.value * 100) / 100,
      rating: metric.rating,
      navigation_type: metric.navigationType,
    });
  };
}
