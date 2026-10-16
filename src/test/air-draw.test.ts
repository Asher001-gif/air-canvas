import { describe, expect, it } from "vitest";
import {
  OneEuroPoint,
  StrokeRecorder,
  bridgePoints,
  syntheticPointingHand,
  unscaleLandmarks,
  containsPoint,
  indexFingerIsExtended,
  isPinching,
  isWithinTrackingGrace,
  moveDrawing,
  stepFlyingOffset,
} from "@/lib/air-draw";

describe("Air Draw gesture rules", () => {
  it("keeps a stroke open for 500 milliseconds of lost tracking", () => {
    expect(isWithinTrackingGrace(1000, 1500)).toBe(true);
    expect(isWithinTrackingGrace(1000, 1501)).toBe(false);
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

describe("Air Draw robust tracking helpers", () => {
  it("still counts an open hand (all fingers spread) as drawing", () => {
    const l = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9 }));
    l[0] = { x: 0.5, y: 0.95 };
    l[5] = { x: 0.5, y: 0.6 };
    l[6] = { x: 0.5, y: 0.5 };
    l[8] = { x: 0.5, y: 0.3 };
    expect(indexFingerIsExtended(l)).toBe(true);
  });

  it("has hysteresis: borderline poses keep drawing but do not start drawing", () => {
    const l = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9 }));
    l[0] = { x: 0.5, y: 0.95 };
    l[5] = { x: 0.5, y: 0.6 };
    l[6] = { x: 0.5, y: 0.5 };
    l[8] = { x: 0.5, y: 0.45 };
    expect(indexFingerIsExtended(l, false)).toBe(false);
    expect(indexFingerIsExtended(l, true)).toBe(true);
  });

  it("maps landmarks from a zoomed-out frame back to full-frame coordinates", () => {
    const [p] = unscaleLandmarks([{ x: 0.5 + 0.1, y: 0.5 }], 0.5);
    expect(p!.x).toBeCloseTo(0.7);
    expect(p!.y).toBeCloseTo(0.5);
    expect(unscaleLandmarks([{ x: 0.2, y: 0.3 }], 1)).toEqual([{ x: 0.2, y: 0.3 }]);
  });

  it("a lone fingertip becomes a hand that reads as pointing", () => {
    const hand = syntheticPointingHand({ x: 0.5, y: 0.2 });
    expect(hand).toHaveLength(21);
    expect(indexFingerIsExtended(hand)).toBe(true);
    expect(isPinching(hand)).toBe(false);
  });

  it("fills gaps between far-apart samples with evenly spaced points", () => {
    const pts = bridgePoints({ x: 0, y: 0 }, { x: 60, y: 0 }, 6);
    expect(pts).toHaveLength(10);
    expect(pts[pts.length - 1]).toEqual({ x: 60, y: 0 });
    expect(bridgePoints({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([{ x: 3, y: 0 }]);
  });

  it("smooths jitter when slow but follows fast motion closely", () => {
    const slow = new OneEuroPoint();
    slow.filter({ x: 100, y: 100 }, 0);
    const jitter = slow.filter({ x: 104, y: 100 }, 33);
    expect(jitter.x).toBeLessThan(103);
    const fast = new OneEuroPoint();
    let p = fast.filter({ x: 0, y: 0 }, 0);
    for (let i = 1; i <= 10; i += 1) p = fast.filter({ x: i * 60, y: 0 }, i * 33);
    expect(600 - p.x).toBeLessThan(120);
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
      { x: 0, y: 0, vx: 1500, vy: 0 },
      { minX: 20, minY: 30, maxX: 140, maxY: 160 },
      200,
      200,
      0.05,
    );
    expect(next.x).toBe(60);
    expect(next.vx).toBeLessThan(0);
    expect(Math.abs(next.vx)).toBeLessThan(1500);
  });
});

describe("StrokeRecorder keeps lines continuous", () => {
  const sweep = (rec: StrokeRecorder, fps: number, seconds: number, hook?: (i: number) => "ok" | "fold" | "lost") => {
    const dt = 1000 / fps;
    const n = Math.round(seconds * fps);
    for (let i = 0; i < n; i += 1) {
      const now = 1000 + i * dt;
      rec.tick(now);
      const state = hook?.(i) ?? "ok";
      const point = { x: 100 + i * (400 / n), y: 200 + Math.sin(i / 6) * 40 };
      if (state === "lost") rec.lost(now);
      else rec.track(point, state === "ok", 5, now);
    }
  };

  it("draws one long stroke at normal frame rates", () => {
    const rec = new StrokeRecorder();
    sweep(rec, 30, 2);
    expect(rec.strokes).toHaveLength(1);
    expect(rec.strokes[0]!.points.length).toBeGreaterThan(40);
  });

  it("does not break the line on random single-frame flicker (folded or lost)", () => {
    const rec = new StrokeRecorder();
    sweep(rec, 30, 3, (i) => (i % 9 === 4 ? "fold" : i % 13 === 6 ? "lost" : "ok"));
    expect(rec.strokes).toHaveLength(1);
  });

  it("bridges a 300 ms tracking dropout without starting a new stroke", () => {
    const rec = new StrokeRecorder();
    sweep(rec, 30, 2, (i) => (i >= 20 && i < 29 ? "lost" : "ok"));
    expect(rec.strokes).toHaveLength(1);
  });

  it("adapts to a slow computer: 3 results per second still gives one line, not dots", () => {
    const rec = new StrokeRecorder();
    sweep(rec, 3, 6);
    expect(rec.strokes).toHaveLength(1);
    expect(rec.frameInterval).toBeGreaterThan(200);
  });

  it("lifts the pen after the finger has stayed folded, then starts a new stroke", () => {
    const rec = new StrokeRecorder();
    sweep(rec, 30, 2, (i) => (i >= 30 && i < 45 ? "fold" : "ok"));
    expect(rec.strokes).toHaveLength(2);
  });

  it("ends the stroke when tracking is lost for longer than the grace period", () => {
    const rec = new StrokeRecorder();
    sweep(rec, 30, 2, (i) => (i >= 30 ? "lost" : "ok"));
    expect(rec.drawing).toBe(false);
    expect(rec.strokes).toHaveLength(1);
  });

  it("discards a one-frame speck but keeps a deliberate long press as a dot", () => {
    const speck = new StrokeRecorder();
    speck.tick(1000);
    speck.track({ x: 5, y: 5 }, true, 5, 1000);
    speck.lost(1100);
    speck.lost(1700);
    expect(speck.strokes).toHaveLength(0);

    const dot = new StrokeRecorder();
    for (let t = 1000; t <= 1400; t += 33) { dot.tick(t); dot.track({ x: 5, y: 5 }, true, 5, t); }
    dot.end(1500);
    expect(dot.strokes).toHaveLength(1);
  });

  it("fills in points between far-apart fast samples", () => {
    const rec = new StrokeRecorder();
    rec.tick(1000); rec.track({ x: 0, y: 0 }, true, 5, 1000);
    rec.tick(1033); rec.track({ x: 120, y: 0 }, true, 5, 1033);
    const pts = rec.strokes[0]!.points;
    const maxGap = Math.max(...pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y)));
    expect(maxGap).toBeLessThanOrEqual(6.01);
  });
});
