import { useEffect, useState } from "react";

// 频道切换墨汁动效启用判断 — 任一不达标走"朴素切换"(单 pill 即时位置切换):
//   - 用户开了 prefers-reduced-motion (W3C 标准, iOS/Android/Desktop OS 系统设置)
//   - navigator.deviceMemory < 4 GB (中低端机普遍 2-3 GB)
//   - navigator.hardwareConcurrency < 4 (低端机 2-4 核居多)
// 启动初始 + 监听 prefers-reduced-motion 变化 (用户运行时切系统设置可即时响应)
export function useFancyAnimation(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => evaluateFancyEnabled());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setEnabled(evaluateFancyEnabled());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return enabled;
}

function evaluateFancyEnabled(): boolean {
  if (typeof window === "undefined") return true;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 4) return false;
  if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency < 4) return false;
  return true;
}
