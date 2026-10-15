import { describe, expect, it } from "vitest";
import {
  containsPoint,
  indexFingerIsExtended,
  isPinching,
  isWithinTrackingGrace,
  moveDrawing,
  stepFlyingOffset,
} from "@/lib/air-draw";

describe("Air Draw gesture rules", () => {
  it("ends the tracking grace period after 150 milliseconds", () => {
    expect(isWithinTrackingGrace(1000, 1150)).toBe(true);
    expect(isWithinTrackingGrace(1000, 1151)).toBe(false);
  });

  it("draws only while the index tip is extended above its middle joint", () => {
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    landmarks[8] = { x: 0.5, y: 0.2 };
    landmarks[6] = { x: 0.5, y: 0.4 };
    expect(indexFingerIsExtended(landmarks)).toBe(true);
    landmarks[8] = { x: 0.5, y: 0.48 };
    expect(indexFingerIsExtended(landmarks)).toBe(false);
  });

  it("recognizes a thumb-index pinch under 0.065 normalized units", () => {
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    landmarks[4] = { x: 0.51, y: 0.5 };
    landmarks[8] = { x: 0.55, y: 0.5 };
    expect(isPinching(landmarks)).toBe(true);
    landmarks[8] = { x: 0.6, y: 0.5 };
    expect(isPinching(landmarks)).toBe(false);
  });
});

describe("Air Draw free movement", () => {
  it("grabs only points inside the drawing with a small edge margin", () => {
    const bounds = { minX: 20, minY: 30, maxX: 140, maxY: 160 };
    expect(containsPoint(bounds, { x: 12, y: 36 })).toBe(true);
    expect(containsPoint(bounds, { x: 200, y: 36 })).toBe(false);
  });

  it("moves strokes without changing their scale or rotation", () => {
    expect(moveDrawing({ x: 2, y: 3, vx: 0, vy: 0 }, 5, -4)).toEqual({ x: 7, y: -1, vx: 0, vy: 0 });
  });

  it("bounces at screen edges and damps the throw", () => {
    const next = stepFlyingOffset(
      { x: 0, y: 0, vx: 500, vy: 0 },
      { minX: 20, minY: 30, maxX: 140, maxY: 160 },
      200,
      200,
      0.05,
    );
    expect(next.x).toBe(60);
    expect(next.vx).toBeLessThan(0);
    expect(Math.abs(next.vx)).toBeLessThan(500);
  });
});