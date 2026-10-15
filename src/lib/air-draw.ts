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

export const TRACKING_GRACE_MS = 150;

export function indexFingerIsExtended(landmarks: Point[]) {
  const wrist = landmarks[0];
  const tip = landmarks[8];
  const middleJoint = landmarks[6];
  if (!wrist || !tip || !middleJoint) return false;
  // Orientation-independent: an extended index fingertip is clearly farther from
  // the wrist than its middle joint; a folded one is closer to the palm.
  const tipDistance = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
  const jointDistance = Math.hypot(middleJoint.x - wrist.x, middleJoint.y - wrist.y);
  return tipDistance > jointDistance * 1.12;
}

export function isPinching(landmarks: Point[]) {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  if (!thumbTip || !indexTip) return false;
  return Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y) < 0.065;
}

export function isWithinTrackingGrace(lastSeenAt: number, now: number) {
  return now - lastSeenAt <= TRACKING_GRACE_MS;
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