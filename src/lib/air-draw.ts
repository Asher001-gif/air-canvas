export type Point = { x: number; y: number };

export type FlyingOffset = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export type DrawingBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

// How long a stroke stays "open" while tracking is lost (blur, dim light, hand
// too close). If the fingertip comes back inside this window the line simply
// continues, so brief dropouts never break a stroke.
export const TRACKING_GRACE_MS = 500;
// The pen only lifts after the finger has looked folded for this many ms, so a
// single bad frame can't chop a line into dots.
export const PEN_UP_DEBOUNCE_MS = 120;

export type BrushSize = "thin" | "medium" | "thick";
export const BRUSH_WIDTHS: Record<BrushSize, number> = { thin: 2.5, medium: 5, thick: 12 };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * True while the index fingertip is out and usable for drawing.
 *
 * Open-palm hands count too (all fingers spread is still "index extended"), so
 * the pen only lifts when the index is clearly curled. Two scale-free ratios
 * are used so it works at any distance from the camera:
 *   - tip vs. middle joint, measured from the wrist
 *   - tip vs. middle joint, measured from the knuckle (robust when the wrist is
 *     cut off by the frame edge because the hand is close)
 * `wasExtended` adds hysteresis: it is harder to start than to keep drawing.
 */
export function indexFingerIsExtended(landmarks: Point[], wasExtended = false) {
  const wrist = landmarks[0];
  const mcp = landmarks[5];
  const pip = landmarks[6];
  const tip = landmarks[8];
  if (!wrist || !mcp || !pip || !tip) return false;
  const fromWrist = dist(tip, wrist) / Math.max(dist(pip, wrist), 1e-6);
  const fromKnuckle = dist(tip, mcp) / Math.max(dist(pip, mcp), 1e-6);
  return wasExtended
    ? fromWrist > 0.95 && fromKnuckle > 0.85
    : fromWrist > 1.12 && fromKnuckle > 1.2;
}

/** Remaps landmarks from a zoomed-out (padded) detector frame back to the full video frame. */
export function unscaleLandmarks(landmarks: Point[], scale: number): Point[] {
  if (scale === 1) return landmarks;
  return landmarks.map((p) => ({ x: (p.x - 0.5) / scale + 0.5, y: (p.y - 0.5) / scale + 0.5 }));
}

/** Builds a minimal "pointing finger" hand around a lone fingertip (used by the close-up fallback). */
export function syntheticPointingHand(tip: Point): Point[] {
  const far = { x: tip.x, y: tip.y + 0.6 };
  const hand: Point[] = Array.from({ length: 21 }, () => ({ ...far }));
  hand[0] = far;
  hand[5] = { x: tip.x, y: tip.y + 0.3 };
  hand[6] = { x: tip.x, y: tip.y + 0.15 };
  hand[8] = { ...tip };
  return hand;
}

/**
 * One Euro filter: heavy smoothing when the finger is slow (kills jitter and
 * blur noise) and almost none when it moves fast (no lag, no cut corners).
 */
export class OneEuroPoint {
  private prev: Point | null = null;
  private dprev: Point = { x: 0, y: 0 };
  private lastT = 0;
  constructor(private minCutoff = 1.4, private beta = 0.012, private dCutoff = 1) {}
  reset() { this.prev = null; this.dprev = { x: 0, y: 0 }; }
  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(p: Point, tMs: number): Point {
    if (!this.prev) { this.prev = p; this.lastT = tMs; return p; }
    const dt = Math.max((tMs - this.lastT) / 1000, 1 / 120);
    this.lastT = tMs;
    const ad = this.alpha(this.dCutoff, dt);
    const dx = (p.x - this.prev.x) / dt;
    const dy = (p.y - this.prev.y) / dt;
    this.dprev = { x: this.dprev.x + ad * (dx - this.dprev.x), y: this.dprev.y + ad * (dy - this.dprev.y) };
    const speed = Math.hypot(this.dprev.x, this.dprev.y);
    const a = this.alpha(this.minCutoff + this.beta * speed, dt);
    this.prev = { x: this.prev.x + a * (p.x - this.prev.x), y: this.prev.y + a * (p.y - this.prev.y) };
    return this.prev;
  }
}

/** Adds evenly spaced points between two samples so fast strokes never leave gaps. */
export function bridgePoints(from: Point, to: Point, maxStep = 6): Point[] {
  const d = dist(from, to);
  if (d <= maxStep) return [to];
  const n = Math.ceil(d / maxStep);
  return Array.from({ length: n }, (_, i) => ({
    x: from.x + ((to.x - from.x) * (i + 1)) / n,
    y: from.y + ((to.y - from.y) * (i + 1)) / n,
  }));
}

export function isPinching(landmarks: Point[]) {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  if (!thumbTip || !indexTip) return false;
  return Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y) < 0.065;
}

export function isWithinTrackingGrace(lastSeenAt: number, now: number, graceMs = TRACKING_GRACE_MS) {
  return now - lastSeenAt <= graceMs;
}

export function containsPoint(bounds: DrawingBounds, point: Point, padding = 24) {
  return (
    point.x >= bounds.minX - padding &&
    point.x <= bounds.maxX + padding &&
    point.y >= bounds.minY - padding &&
    point.y <= bounds.maxY + padding
  );
}

export function moveDrawing(offset: FlyingOffset, dx: number, dy: number): FlyingOffset {
  return { ...offset, x: offset.x + dx, y: offset.y + dy };
}

export function stepFlyingOffset(
  offset: FlyingOffset,
  bounds: DrawingBounds,
  width: number,
  height: number,
  seconds: number,
): FlyingOffset {
  if (seconds <= 0) return offset;
  const duration = Math.min(seconds, 0.05);
  let x = offset.x + offset.vx * duration;
  let y = offset.y + offset.vy * duration;
  let vx = offset.vx * Math.exp(-1.8 * duration);
  let vy = offset.vy * Math.exp(-1.8 * duration);

  const left = -bounds.minX;
  const right = width - bounds.maxX;
  const top = -bounds.minY;
  const bottom = height - bounds.maxY;

  if (x < left) {
    x = left;
    vx = Math.abs(vx) * 0.72;
  } else if (x > right) {
    x = right;
    vx = -Math.abs(vx) * 0.72;
  }
  if (y < top) {
    y = top;
    vy = Math.abs(vy) * 0.72;
  } else if (y > bottom) {
    y = bottom;
    vy = -Math.abs(vy) * 0.72;
  }

  if (Math.hypot(vx, vy) < 7) {
    vx = 0;
    vy = 0;
  }
  return { x, y, vx, vy };
}

export type Stroke = { points: Point[]; width: number; startedAt: number };

/**
 * Turns a stream of fingertip samples into continuous strokes.
 *
 * It measures how fast results actually arrive and scales its timeouts to that,
 * so a slow computer (few results per second) doesn't chop every line into dots:
 *  - dropouts shorter than `grace` are bridged (the line just continues),
 *  - the pen only lifts after the finger looks folded for `debounce`,
 *  - a speck made of one or two points in a split second is discarded as noise.
 */
export class StrokeRecorder {
  strokes: Stroke[] = [];
  drawing = false;
  private lastSeen = 0;
  private foldedSince = 0;
  private lastResult = 0;
  private interval = 33;
  private smoother = new OneEuroPoint();

  /** Call once per detector result (hand or no hand) to learn the real frame rate. */
  tick(now: number) {
    if (this.lastResult) {
      const dt = Math.min(now - this.lastResult, 1500);
      if (dt > 0) this.interval += (dt - this.interval) * 0.2;
    }
    this.lastResult = now;
  }

  get grace() { return Math.max(TRACKING_GRACE_MS, this.interval * 3.5); }
  get debounce() { return Math.max(PEN_UP_DEBOUNCE_MS, this.interval * 2.2); }
  /** Average ms between detector results. */
  get frameInterval() { return this.interval; }

  /** A frame where the fingertip is tracked. Returns true if a new stroke began. */
  track(point: Point, extended: boolean, width: number, now: number): boolean {
    if (!extended) {
      if (!this.drawing) return false;
      if (!this.foldedSince) this.foldedSince = now;
      if (now - this.foldedSince >= this.debounce) this.end(now);
      return false;
    }
    this.foldedSince = 0;
    if (!this.drawing || !isWithinTrackingGrace(this.lastSeen, now, this.grace)) {
      if (this.drawing) this.end(now);
      this.smoother.reset();
      const first = this.smoother.filter(point, now);
      this.strokes.push({ points: [first], width, startedAt: now });
      this.drawing = true;
      this.lastSeen = now;
      return true;
    }
    const filtered = this.smoother.filter(point, now);
    const stroke = this.strokes[this.strokes.length - 1]!;
    const previous = stroke.points[stroke.points.length - 1] ?? filtered;
    if (dist(filtered, previous) > 0.8) stroke.points.push(...bridgePoints(previous, filtered));
    this.lastSeen = now;
    return false;
  }

  /** A frame where nothing was tracked. Ends the stroke once the grace period runs out. */
  lost(now: number) {
    if (this.drawing && !isWithinTrackingGrace(this.lastSeen, now, this.grace)) this.end(now);
  }

  end(now: number) {
    const stroke = this.strokes[this.strokes.length - 1];
    if (this.drawing && stroke && stroke.points.length < 3 && this.lastSeen - stroke.startedAt < 250) this.strokes.pop();
    this.drawing = false;
    this.foldedSince = 0;
    this.smoother.reset();
  }

  clear() {
    this.strokes.length = 0;
    this.drawing = false;
    this.foldedSince = 0;
    this.smoother.reset();
  }
}
