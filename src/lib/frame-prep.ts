import type { Frame } from "@/lib/fingertip-fallback";

/**
 * Prepares camera frames for the hand detector:
 *  - auto brightness/contrast lift when the room is dim,
 *  - optional zoom-out (grey padding) so a hand held very close still looks
 *    "normal sized" to the model.
 * Runs entirely on the local canvas; nothing leaves the device.
 */
export const DETECT_SCALES = [1, 0.55, 0.35] as const;

export class FramePrep {
  readonly feed = document.createElement("canvas");
  private readonly small = document.createElement("canvas");
  private readonly feedCtx = this.feed.getContext("2d", { willReadFrequently: false })!;
  private readonly smallCtx = this.small.getContext("2d", { willReadFrequently: true })!;
  private gain = 1;
  private frame = 0;
  private readonly canFilter = "filter" in this.feedCtx;

  constructor() {
    this.small.width = 160;
    this.small.height = 120;
  }

  /** Current brightness multiplier (1 = no boost). */
  get brightnessGain() { return this.gain; }

  private updateGain(video: HTMLVideoElement) {
    this.frame += 1;
    if (this.frame % 8 !== 1) return;
    const w = 32;
    const h = 24;
    this.smallCtx.filter = "none";
    this.smallCtx.drawImage(video, 0, 0, w, h);
    const d = this.smallCtx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114;
    const avg = sum / (w * h);
    const target = Math.min(3, Math.max(1, 118 / Math.max(avg, 8)));
    // Smooth so the boost doesn't pump from frame to frame.
    this.gain += (target - this.gain) * 0.35;
  }

  private filterString() {
    if (this.gain < 1.08) return "none";
    return `brightness(${this.gain.toFixed(2)}) contrast(${(1 + Math.min(0.3, (this.gain - 1) * 0.18)).toFixed(2)})`;
  }

  /** Returns the canvas to hand to the detector at the given zoom-out scale. */
  prepare(video: HTMLVideoElement, scale: number): HTMLCanvasElement {
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const w = Math.min(640, vw);
    const h = Math.round((w * vh) / vw);
    if (this.feed.width !== w || this.feed.height !== h) {
      this.feed.width = w;
      this.feed.height = h;
    }
    this.updateGain(video);
    const ctx = this.feedCtx;
    ctx.save();
    ctx.filter = "none";
    if (scale < 1) {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, w, h);
    }
    if (this.canFilter) ctx.filter = this.filterString();
    const sw = w * scale;
    const sh = h * scale;
    ctx.drawImage(video, (w - sw) / 2, (h - sh) / 2, sw, sh);
    ctx.restore();
    return this.feed;
  }

  /** Small, brightness-corrected full-frame copy for the fingertip fallback. */
  sample(video: HTMLVideoElement): Frame {
    const ctx = this.smallCtx;
    ctx.save();
    ctx.filter = this.canFilter ? this.filterString() : "none";
    ctx.drawImage(video, 0, 0, this.small.width, this.small.height);
    ctx.restore();
    return ctx.getImageData(0, 0, this.small.width, this.small.height);
  }
}
