import { describe, expect, it } from "vitest";
import { findFingertip } from "@/lib/fingertip-fallback";

function frame(w: number, h: number, skin: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const [r, g, b] = skin(x, y) ? [205, 150, 125] : [170, 175, 185];
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe("fingertip fallback", () => {
  it("finds the top of a finger entering from the bottom", () => {
    const tip = findFingertip(frame(160, 120, (x, y) => x > 65 && x < 90 && y > 30));
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeCloseTo(77.5 / 160, 1);
    expect(tip!.y).toBeLessThan(0.3);
  });
  it("ignores a wide blob that doesn't reach the bottom (e.g. a face)", () => {
    expect(findFingertip(frame(160, 120, (x, y) => x > 40 && x < 120 && y > 10 && y < 80))).toBeNull();
  });
  it("returns null when there is no skin", () => {
    expect(findFingertip(frame(160, 120, () => false))).toBeNull();
  });
});
