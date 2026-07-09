import { describe, test, expect } from 'vitest';
import { passesFeedImageQualityGate } from './media-r2';

// ═══════════════ 封面质量门：不可 probe 格式兜底（Task B，2026-07-09）═══════════════
// 事实（真实样本实测，见 PR body）：probeImageDimensions 只能读 PNG/JPEG/GIF；
// webp/avif/ico 均读不出尺寸 → 落到「>8KB 即通过」的字节兜底。
//   - webp/avif 大图（真实 hero 45KB/13KB）靠字节兜底通过 —— 正确，不能动。
//   - 48×48 favicon.ico（9.6KB）也靠字节兜底通过 —— 误留（prod 实测 7 条）。
// 修法（窄）：magic bytes 认出 ICO/CUR 容器直接拒（图标绝非合法封面/hero），
//   webp/avif 仍走字节兜底不受影响，避免误杀现代博客大量使用的 webp 封面。

// 造 buffer：head 放 magic bytes，其余用非零噪声填到 total 字节（模拟真实文件体积）。
function craft(head: number[], total: number): ArrayBuffer {
  const u = new Uint8Array(Math.max(total, head.length));
  u.set(head);
  for (let i = head.length; i < u.length; i++) u[i] = (i * 31 + 7) & 0xff;
  return u.buffer;
}

// ICO：00 00 01 00 | count(LE, 2B) | ICONDIRENTRY(width,height,...)
function icoBuf(width: number, height: number, count = 1, total = 9000): ArrayBuffer {
  return craft(
    [0x00, 0x00, 0x01, 0x00, count & 0xff, (count >> 8) & 0xff, width & 0xff, height & 0xff, 0, 0, 1, 0, 32, 0],
    total,
  );
}
// WEBP：'RIFF' size(4) 'WEBP' 'VP8 '
function webpBuf(total: number): ArrayBuffer {
  return craft([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], total);
}
// AVIF：box size(4, BE) 'ftyp' 'avif'。boxSize 可注入对抗值。
function avifBuf(total: number, boxSize = [0x00, 0x00, 0x00, 0x1c]): ArrayBuffer {
  return craft([...boxSize, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], total);
}
// PNG：8B 签名 | IHDR len(13) 'IHDR' width(BE) height(BE) ...（probePngDimensions 读 offset16/20）
function pngBuf(width: number, height: number, total: number): ArrayBuffer {
  return craft(
    [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
      (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
      8, 2, 0, 0, 0,
    ],
    total,
  );
}

describe('passesFeedImageQualityGate — ICO 兜底误留修复（Task B）', () => {
  test('48×48 favicon.ico（>8KB）→ 拒（修前靠字节兜底误留）', () => {
    expect(passesFeedImageQualityGate(icoBuf(48, 48, 1, 9662))).toBe(false);
  });

  test('多尺寸 favicon.ico（16/32/48，>8KB）→ 拒', () => {
    expect(passesFeedImageQualityGate(icoBuf(16, 16, 3, 15086))).toBe(false);
  });

  test('小 ico（<8KB）→ 拒（字节兜底本就拒，magic 层也拒，双保险）', () => {
    expect(passesFeedImageQualityGate(icoBuf(48, 48, 1, 4000))).toBe(false);
  });

  // ── 回归锁：webp/avif 不受影响，仍走字节兜底（不误杀现代博客封面）──
  test('webp 大图（>8KB）→ 通过（字节兜底，行为不变）', () => {
    expect(passesFeedImageQualityGate(webpBuf(45970))).toBe(true);
  });

  test('webp 小图（<8KB icon/spacer）→ 拒（字节兜底，行为不变）', () => {
    expect(passesFeedImageQualityGate(webpBuf(84))).toBe(false);
  });

  test('avif 大图（>8KB）→ 通过（字节兜底，行为不变）', () => {
    expect(passesFeedImageQualityGate(avifBuf(13367))).toBe(true);
  });

  // ── 对抗：AVIF box size 恰为 0x00000100 → 前 4 字节 00 00 01 00 与 ICO 头撞，
  //    但 offset4 是 'ftyp'（count 读出 0x7466≫255）→ 不误判为 ICO，仍走字节兜底通过。──
  test('对抗 AVIF（box size=0x100，头与 ICO 撞）→ 不误判、仍通过', () => {
    expect(passesFeedImageQualityGate(avifBuf(20000, [0x00, 0x00, 0x01, 0x00]))).toBe(true);
  });

  // ── 回归锁：可 probe 的 PNG/JPEG 走原尺寸门，不受 ICO 分支影响 ──
  test('PNG 400×300（够字节密度）→ 通过（probe 尺寸门，行为不变）', () => {
    expect(passesFeedImageQualityGate(pngBuf(400, 300, 8000))).toBe(true);
  });

  test('PNG 120×120（maxDim<300）→ 拒（probe 尺寸门，行为不变）', () => {
    expect(passesFeedImageQualityGate(pngBuf(120, 120, 9000))).toBe(false);
  });
});
