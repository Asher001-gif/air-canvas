/**
 * Close-up fallback for when MediaPipe can't see a palm (finger right in front
 * of the lens, only a fingertip in frame). It looks for the skin-coloured blob
 * that enters from the bottom edge and returns its topmost point.
 *
 * It is deliberately conservative so a face or a skin-toned wall is not mistaken
 * for a finger: the blob must reach the bottom edge, be a sensible size and be
 * narrow at the top.
 */
export type Frame = { data: ArrayLike<number>; width: number; height: number };
export type Tip = { x: number; y: number };

export function isSkin(r: number, g: number, b: number) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 30 || y > 250) return false;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  return cr > 133 && cr < 180 && cb > 77 && cb < 130 && r > g && r > b * 0.9;
}

export function findFingertip(frame: Frame, minArea = 0.02, maxTopWidth = 0.32): Tip | null {
  const { data, width: w, height: h } = frame;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    mask[i] = isSkin(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!) ? 1 : 0;
  }
  // Close small holes/specks: keep a pixel only if it has skin neighbours.
  const clean = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const n = mask[i - 1]! + mask[i + 1]! + mask[i - w]! + mask[i + w]!;
      clean[i] = (mask[i] && n >= 2) || n === 4 ? 1 : 0;
    }
  }

  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let best: { pixels: number[] } | null = null;
  for (let start = 0; start < w * h; start += 1) {
    if (!clean[start] || seen[start]) continue;
    const pixels: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && clean[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && clean[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && clean[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && clean[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (!best || pixels.length > best.pixels.length) best = { pixels };
  }
  if (!best || best.pixels.length < minArea * w * h) return null;

  let minY = h;
  let maxY = 0;
  for (const i of best.pixels) {
    const y = Math.floor(i / w);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // A hand entering from below touches the bottom edge; a face usually doesn't.
  if (maxY < h - 3) return null;

  const bandEnd = minY + Math.max(2, Math.round((maxY - minY) * 0.18));
  let sumX = 0;
  let count = 0;
  let lo = w;
  let hi = 0;
  for (const i of best.pixels) {
    const x = i % w;
    const y = (i - x) / w;
    if (y <= bandEnd) { sumX += x; count += 1; if (x < lo) lo = x; if (x > hi) hi = x; }
  }
  if (!count || (hi - lo + 1) / w > maxTopWidth) return null;
  return { x: sumX / count / w, y: (minY + 1) / h };
}
