// 频道 tab 黑色 pill 跟手势墨汁动效 — 设计 + 交互 demo 见
// docs/mocks/2026-05-27-channel-tab-ink.html (vanilla HTML/JS preview, v5 版本)
//
// 实现要点:
// - 出场 pill 两阶段 (rect → circle → 0), 入场 pill 两阶段 (0 → circle → rect)
// - 两阶段衔接处用 smoothstep ease 让 derivative = 0 (速度无突变)
// - 关键帧 (0/0.35/0.6/0.65/1) 严格守住, 中间状态加微小 jitter 让形变有机
// - 中间用 SVG path 流体连线连接两端 pill,
//   连线 5 节点 Catmull-Rom + 上下不对称 sin/cos 波 (RAF 持续重绘演变)
// - 整套元素套 SVG goo filter (高斯模糊 + alpha 高对比度) 让连线跟 pill metaball 合并

export const PILL_H = 26;            // 正圆/胶囊基础高度
export const BRIDGE_FULL_HALF = 6;   // 连线主体半高 (高度 12px)

// smoothstep — derivative 在 t=0/1 处 = 0, 用于 phase 衔接的速度连续
export function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// 出场 pill 形状大小 (progress 0..0.6, 之后 = 0)
//   phase 1 (0..0.35): width chip.w → PILL_H (rect → circle), height = PILL_H
//   phase 2 (0.35..0.6): width=height PILL_H → 0 (circle → dot → 消失)
export function computeOutPillSize(progress: number, fromChipWidth: number): { w: number; h: number } {
  if (progress < 0.35) {
    const t = smoothstep(progress / 0.35);
    return { w: fromChipWidth + (PILL_H - fromChipWidth) * t, h: PILL_H };
  }
  if (progress < 0.6) {
    const t = smoothstep((progress - 0.35) / 0.25);
    const d = PILL_H * (1 - t);
    return { w: d, h: d };
  }
  return { w: 0, h: 0 };
}

// 入场 pill 形状大小 (phase 1 从 progress 0 启动 — 跟出场/连线同步)
//   phase 1 (0..0.65): width=height 0 → PILL_H (dot → circle, 慢慢长出)
//   phase 2 (0.65..1):  width PILL_H → chip.w (circle → rect, 扩开), height = PILL_H
export function computeInPillSize(progress: number, toChipWidth: number): { w: number; h: number } {
  if (progress < 0.65) {
    const t = smoothstep(progress / 0.65);
    const d = PILL_H * t;
    return { w: d, h: d };
  }
  const t = smoothstep((progress - 0.65) / 0.35);
  return { w: PILL_H + (toChipWidth - PILL_H) * t, h: PILL_H };
}

// 出场 pill jitter 振幅 — 关键帧 0/0.35/0.6 = 0, 中间 sin 波峰
export function jitterAmpOut(progress: number, ampPeak1 = 0.8, ampPeak2 = 0.5): number {
  if (progress < 0.35) return Math.sin((progress / 0.35) * Math.PI) * ampPeak1;
  if (progress < 0.6) return Math.sin(((progress - 0.35) / 0.25) * Math.PI) * ampPeak2;
  return 0;
}
// 入场 pill jitter 振幅 — 关键帧 0/0.65/1 = 0
export function jitterAmpIn(progress: number, ampPeak1 = 0.7, ampPeak2 = 0.5): number {
  if (progress < 0.65) return Math.sin((progress / 0.65) * Math.PI) * ampPeak1;
  if (progress < 1) return Math.sin(((progress - 0.65) / 0.35) * Math.PI) * ampPeak2;
  return 0;
}

// 流体连线高度 (3 阶段: 渐显 → 稳定 → 渐隐)
export function computeBridgeHalfH(progress: number): number {
  if (progress < 0.18) return BRIDGE_FULL_HALF * (progress / 0.18);
  if (progress < 0.82) return BRIDGE_FULL_HALF;
  return BRIDGE_FULL_HALF * ((1 - progress) / 0.18);
}

interface BridgePathInput {
  xL: number;
  xR: number;
  leftH: number;
  rightH: number;
  halfH: number;
  ymid: number;
  now: number;
}

// 流体连线 SVG path d 字符串
// 5 节点 Catmull-Rom 串接, 上下边独立 sin+cos 组合波 (1200/1500ms 上 / 1700/2100ms 下)
// 端点高度收紧到 ≤ 连线主体, 让 goo filter blur 把 pill 多出的圆球部分 metaball 合并圆润
export function buildBridgePath({ xL, xR, leftH, rightH, halfH, ymid, now }: BridgePathInput): string {
  const bridgeLen = Math.max(0, xR - xL);
  if (bridgeLen <= 0 || halfH <= 0.3) return "";

  const tU = (now / 1200) * 2 * Math.PI;
  const tD = (now / 1700) * 2 * Math.PI + 1.7;
  const tU2 = (now / 1500) * 2 * Math.PI + 0.6;
  const tD2 = (now / 2100) * 2 * Math.PI + 2.3;
  const ampU = halfH * 0.40;
  const ampD = halfH * 0.50;

  const ROOT_MAX = halfH * 2;
  const leftRootH = Math.min(leftH, ROOT_MAX);
  const rightRootH = Math.min(rightH, ROOT_MAX);
  const yLT = ymid - leftRootH / 2;
  const yLB = ymid + leftRootH / 2;
  const yRT = ymid - rightRootH / 2;
  const yRB = ymid + rightRootH / 2;

  const N = 5;
  const peakTop = ymid - halfH;
  const peakBot = ymid + halfH;
  const upNodes: Array<{ x: number; y: number }> = [];
  const dnNodes: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < N; i++) {
    const x = xL + (bridgeLen * i) / (N - 1);
    const phase = i * 0.45;
    const yu = peakTop + Math.sin(tU + phase) * ampU + Math.cos(tU2 + phase * 1.6) * ampU * 0.45;
    const yd = peakBot + Math.sin(tD + phase * 1.2) * ampD + Math.cos(tD2 + phase * 0.8) * ampD * 0.4;
    upNodes.push({ x, y: yu });
    dnNodes.push({ x, y: yd });
  }
  upNodes[0].y = yLT;
  upNodes[N - 1].y = yRT;
  dnNodes[0].y = yLB;
  dnNodes[N - 1].y = yRB;

  const toBezier = (nodes: Array<{ x: number; y: number }>, openWithMove: boolean): string => {
    const segs: string[] = [];
    if (openWithMove) segs.push(`M ${nodes[0].x.toFixed(2)} ${nodes[0].y.toFixed(2)}`);
    for (let i = 0; i < nodes.length - 1; i++) {
      const p0 = nodes[Math.max(i - 1, 0)];
      const p1 = nodes[i];
      const p2 = nodes[i + 1];
      const p3 = nodes[Math.min(i + 2, nodes.length - 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      segs.push(
        `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
      );
    }
    return segs.join(" ");
  };

  const dnNodesReverse = [...dnNodes].reverse();
  return [
    toBezier(upNodes, true),
    `L ${xR.toFixed(2)} ${yRB.toFixed(2)}`,
    toBezier(dnNodesReverse, false),
    "Z",
  ].join(" ");
}
