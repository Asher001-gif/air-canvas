import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Aperture, Camera, Check, Hand, LoaderCircle, LockKeyhole, RotateCcw, Sparkles, Sun, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  BRUSH_WIDTHS,
  StrokeRecorder,
  containsPoint,
  indexFingerIsExtended,
  isPinching,
  moveDrawing,
  stepFlyingOffset,
  syntheticPointingHand,
  unscaleLandmarks,
  type BrushSize,
  type DrawingBounds,
  type FlyingOffset,
  type Point,
} from "@/lib/air-draw";
import { findFingertip } from "@/lib/fingertip-fallback";
import { DETECT_SCALES, FramePrep } from "@/lib/frame-prep";

// MediaPipe Hands is a classic (non-ES-module) script that attaches `Hands` to
// `window`. Importing it as a module gives an undefined export once bundled
// ("u is not a constructor"), so load the self-hosted script and read the global.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handsScriptPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadHandsConstructor(): Promise<new (config: { locateFile: (file: string) => string }) => any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (window as any).Hands;
  if (typeof existing === "function") return Promise.resolve(existing);
  if (!handsScriptPromise) {
    handsScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/mediapipe/hands/hands.js";
      script.async = true;
      script.onload = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctor = (window as any).Hands;
        if (typeof ctor === "function") resolve(ctor);
        else reject(new Error("Hand tracking failed to load. Please refresh and try again."));
      };
      script.onerror = () => reject(new Error("Hand tracking files could not be loaded. Please refresh and try again."));
      document.head.appendChild(script);
    }).catch((err) => { handsScriptPromise = null; throw err; });
  }
  return handsScriptPromise;
}


type Mode = "draw" | "free";
type Status = "idle" | "starting" | "ready" | "error";
type HandsController = { send: (input: { image: HTMLVideoElement | HTMLCanvasElement }) => Promise<void>; close: () => Promise<void> };

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Air Draw — Draw in the air" },
      { name: "description", content: "A private, browser-only hand-tracking drawing studio. Your camera stays on your device." },
      { property: "og:title", content: "Air Draw — Draw in the air" },
      { property: "og:description", content: "Draw and toss glowing strokes with your hand. Your camera stays on your device." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AirDraw,
});


type TrackerResults = { multiHandLandmarks?: Point[][] };
type AirDrawWindow = Window & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __airDrawTracker?: Promise<any> | null;
  __airDrawEngineBroken?: boolean;
};
let sharedResultsHandler: ((hands: Point[][]) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSharedTracker(): Promise<any> {
  const w = window as AirDrawWindow;
  if (!w.__airDrawTracker) {
    w.__airDrawTracker = (async () => {
      const Hands = await loadHandsConstructor();
      const tracker = new Hands({ locateFile: (file: string) => `/mediapipe/hands/${file}` });
      // One hand only: half the compute (lower lag) and no second "ghost" hand to jump to.
      // Confidence 0.5 rejects faces, sleeves and other things that merely look hand-like,
      // which is what made the tracker point somewhere other than the real fingertip.
      tracker.setOptions({ maxNumHands: 1, modelComplexity: 0, selfieMode: false, minDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
      tracker.onResults((results: TrackerResults) => sharedResultsHandler?.(results.multiHandLandmarks ?? []));
      await tracker.initialize();
      return tracker;
    })().catch((err) => { w.__airDrawTracker = null; w.__airDrawEngineBroken = true; throw err; });
  }
  return w.__airDrawTracker;
}

const EMPTY_OFFSET: FlyingOffset = { x: 0, y: 0, vx: 0, vy: 0 };

function AirDraw() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<HandsController | null>(null);
  const frameRef = useRef<number | null>(null);
  const modeRef = useRef<Mode>("draw");
  const recorderRef = useRef(new StrokeRecorder());
  const offsetRef = useRef<FlyingOffset>({ ...EMPTY_OFFSET });
  const lastFrameTimeRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const inFlightRef = useRef(false);
  const cursorRef = useRef<{ point: Point; drawing: boolean } | null>(null);
  const dragRef = useRef<{ point: Point; time: number; vx: number; vy: number } | null>(null);
  const prepRef = useRef<FramePrep | null>(null);
  const scaleIdxRef = useRef(0);
  const missRef = useRef(0);
  const lastTipNormRef = useRef<Point | null>(null);
  const motionRef = useRef<{ point: Point; time: number; vx: number; vy: number } | null>(null);
  const brushRef = useRef<BrushSize>("medium");
  const assistRef = useRef(false);
  const lowLightRef = useRef(false);
  const slowResultsRef = useRef(0);
  const complexityRef = useRef<0 | 1>(0);
  const fastResultsRef = useRef(0);
  const triedFullRef = useRef(false);
  const fpsStampRef = useRef(0);
  const debugPointsRef = useRef<Point[] | null>(null);
  const showTrackRef = useRef(true);
  const [showTrack, setShowTrack] = useState(true);
  const [fps, setFps] = useState(0);
  const [brush, setBrush] = useState<BrushSize>("medium");
  const [assist, setAssist] = useState(false);
  const [lowLight, setLowLight] = useState(false);
  const [mode, setMode] = useState<Mode>("draw");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [handVisible, setHandVisible] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.save();
    context.translate(offsetRef.current.x, offsetRef.current.y);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#f7f8f5";
    context.shadowColor = "rgba(238, 255, 246, 0.72)";
    for (const stroke of recorderRef.current.strokes) {
      const points = stroke.points;
      if (!points.length) continue;
      context.lineWidth = stroke.width;
      context.shadowBlur = 8 + stroke.width * 0.9;
      context.beginPath();
      context.moveTo(points[0]!.x, points[0]!.y);
      if (points.length === 1) {
        context.lineTo(points[0]!.x + 0.1, points[0]!.y + 0.1); // dot: round cap gives it the brush width
      } else {
        for (let index = 1; index < points.length; index += 1) {
          const previous = points[index - 1]!;
          const current = points[index]!;
          if (index < points.length - 1) {
            const next = points[index + 1]!;
            context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
          } else {
            context.lineTo(current.x, current.y);
          }
          if (previous === current) continue;
        }
      }
      context.stroke();
    }
    context.restore();
    const dots = debugPointsRef.current;
    if (dots && showTrackRef.current) {
      context.save();
      context.shadowBlur = 0;
      dots.forEach((p, i) => {
        context.fillStyle = i === 8 ? "#ff4d6d" : "rgba(125,255,178,0.85)";
        context.beginPath();
        context.arc(p.x, p.y, i === 8 ? 4 : 2.2, 0, Math.PI * 2);
        context.fill();
      });
      context.restore();
    }
    const cursor = cursorRef.current;
    if (cursor) {
      context.save();
      context.shadowBlur = 0;
      context.lineWidth = 2;
      context.strokeStyle = cursor.drawing ? "#7dffb2" : "rgba(255,255,255,0.75)";
      context.beginPath();
      context.arc(cursor.point.x, cursor.point.y, cursor.drawing ? 7 : 10, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }, []);

  const getDrawingBounds = useCallback((): DrawingBounds | null => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of recorderRef.current.strokes) {
      for (const point of stroke.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }, []);

  const handleLandmarks = useCallback((landmarks: Point[] | undefined, real = true) => {
    const now = performance.now();
    if (!landmarks || landmarks.length < 21) {
      cursorRef.current = null;
      motionRef.current = null;
      debugPointsRef.current = null;
      setHandVisible(false);
      recorderRef.current.lost(now);
      setStrokeCount(recorderRef.current.strokes.length);
      if (dragRef.current) {
        dragRef.current = null;
        return;
      }
      return;
    }

    setHandVisible(true);
    const tip = landmarks[8];
    if (!tip) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // The <video> uses object-fit: cover and is mirrored with CSS, so map the
    // fingertip through the same crop + flip to land exactly under your finger.
    const video = videoRef.current;
    const vw = video?.videoWidth || 0;
    const vh = video?.videoHeight || 0;
    const toScreen = (p: Point): Point => {
      if (vw && vh && rect.width && rect.height) {
        const scale = Math.max(rect.width / vw, rect.height / vh);
        const shownW = vw * scale;
        const shownH = vh * scale;
        const offsetX = (rect.width - shownW) / 2;
        const offsetY = (rect.height - shownH) / 2;
        return { x: rect.width - (p.x * shownW + offsetX), y: p.y * shownH + offsetY };
      }
      return { x: (1 - p.x) * rect.width, y: p.y * rect.height };
    };
    let point = toScreen(tip);
    debugPointsRef.current = real ? landmarks.map(toScreen) : null;
    // Latency compensation: the camera frame is ~60-100 ms old by the time the detector
    // answers, so the raw fingertip trails a moving finger. Push the point forward along
    // the finger's smoothed velocity by roughly that delay (clamped so it can't overshoot).
    const prevMotion = motionRef.current;
    let vx = 0;
    let vy = 0;
    if (prevMotion && now - prevMotion.time < 150) {
      const dt = Math.max((now - prevMotion.time) / 1000, 0.001);
      vx = prevMotion.vx + 0.5 * ((point.x - prevMotion.point.x) / dt - prevMotion.vx);
      vy = prevMotion.vy + 0.5 * ((point.y - prevMotion.point.y) / dt - prevMotion.vy);
    }
    motionRef.current = { point, time: now, vx, vy };
    // Only extrapolate when results arrive quickly; with slow results the guess is too wild.
    const interval = recorderRef.current.frameInterval;
    const lead = interval < 70 ? Math.min(0.06, interval / 1000 + 0.03) : 0;
    const lx = Math.max(-45, Math.min(45, vx * lead));
    const ly = Math.max(-45, Math.min(45, vy * lead));
    if (Math.hypot(lx, ly) > 1.5) point = { x: point.x + lx, y: point.y + ly };
    cursorRef.current = { point, drawing: false };

    if (modeRef.current === "draw") {
      const recorder = recorderRef.current;
      const extended = indexFingerIsExtended(landmarks, recorder.drawing);
      recorder.track(point, extended, BRUSH_WIDTHS[brushRef.current], now);
      setStrokeCount(recorder.strokes.length);
      if (cursorRef.current) cursorRef.current.drawing = extended && recorder.drawing;
      return;
    }

    recorderRef.current.end(now);
    const bounds = getDrawingBounds();
    const pinching = isPinching(landmarks);
    if (pinching && !dragRef.current && bounds && containsPoint(bounds, { x: point.x - offsetRef.current.x, y: point.y - offsetRef.current.y })) {
      offsetRef.current = { ...offsetRef.current, vx: 0, vy: 0 };
      dragRef.current = { point, time: now, vx: 0, vy: 0 };
    } else if (pinching && dragRef.current) {
      const previous = dragRef.current;
      const elapsed = Math.max((now - previous.time) / 1000, 0.001);
      const dx = point.x - previous.point.x;
      const dy = point.y - previous.point.y;
      offsetRef.current = moveDrawing(offsetRef.current, dx, dy);
      dragRef.current = { point, time: now, vx: dx / elapsed, vy: dy / elapsed };
    } else if (!pinching && dragRef.current) {
      offsetRef.current = { ...offsetRef.current, vx: dragRef.current.vx, vy: dragRef.current.vy };
      dragRef.current = null;
    }
  }, [getDrawingBounds]);

  // Receives every detector result: picks the hand to follow, undoes the zoom-out
  // used for close hands, and falls back to a fingertip-only finder when the
  // detector can't see a palm.
  const handleHands = useCallback((hands: Point[][]) => {
    recorderRef.current.tick(performance.now());
    // Adaptive model size: start on the fast lite model; if the computer keeps up (30+ fps),
    // try the more accurate one; if that turns sluggish, drop back to lite.
    const interval = recorderRef.current.frameInterval;
    slowResultsRef.current = interval > 90 ? slowResultsRef.current + 1 : 0;
    fastResultsRef.current = interval < 40 ? fastResultsRef.current + 1 : 0;
    const switchComplexity = (c: 0 | 1) => {
      complexityRef.current = c;
      slowResultsRef.current = 0;
      fastResultsRef.current = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (trackerRef.current as any)?.setOptions?.({ modelComplexity: c });
    };
    if (complexityRef.current === 1 && slowResultsRef.current >= 20) switchComplexity(0);
    else if (complexityRef.current === 0 && !triedFullRef.current && fastResultsRef.current >= 150) { triedFullRef.current = true; switchComplexity(1); }
    const nowMs = performance.now();
    if (nowMs - fpsStampRef.current > 500) { fpsStampRef.current = nowMs; setFps(Math.round(1000 / Math.max(interval, 1))); }
    const scale = DETECT_SCALES[scaleIdxRef.current] ?? 1;
    if (hands.length) {
      missRef.current = 0;
      const mapped = hands.map((hand) => unscaleLandmarks(hand, scale));
      const ref = lastTipNormRef.current;
      let chosen = mapped[0]!;
      if (ref && mapped.length > 1) {
        const gap = (hand: Point[]) => Math.hypot((hand[8]?.x ?? 9) - ref.x, (hand[8]?.y ?? 9) - ref.y);
        chosen = mapped.reduce((a, b) => (gap(a) <= gap(b) ? a : b));
      }
      lastTipNormRef.current = chosen[8] ?? null;
      if (scale < 1) {
        const xs = chosen.map((p) => p.x);
        const ys = chosen.map((p) => p.y);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (span < 0.4) scaleIdxRef.current = 0; // hand moved back: return to full-res detection
      }
      handleLandmarks(chosen);
      return;
    }
    missRef.current += 1;
    if (missRef.current > 12) lastTipNormRef.current = null;
    // Lost for a couple of frames: retry zoomed out (a hand very close to the lens looks too big to the model).
    if (missRef.current >= 2) scaleIdxRef.current = (scaleIdxRef.current + 1) % DETECT_SCALES.length;
    const video = videoRef.current;
    if (assistRef.current && modeRef.current === "draw" && missRef.current >= 3 && video && prepRef.current) {
      const tip = findFingertip(prepRef.current.sample(video));
      const lastTip = lastTipNormRef.current;
      const nearLast = !tip || !lastTip || Math.hypot(tip.x - lastTip.x, tip.y - lastTip.y) < 0.3;
      if (tip && nearLast) {
        handleLandmarks(syntheticPointingHand(tip), false);
        return;
      }
    }
    handleLandmarks(undefined);
  }, [handleLandmarks]);

  const startCamera = useCallback(async () => {
    // The MediaPipe engine can't recover from a crash inside one page load, so reload.
    if ((window as AirDrawWindow).__airDrawEngineBroken) { window.location.reload(); return; }
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    inFlightRef.current = false;
    setStatus("starting");
    setMessage("");
    setHandVisible(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser can’t access a camera. Open Air Draw in a current version of Chrome over a secure connection.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30 } },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("The camera preview could not be opened. Please try again.");
      video.srcObject = stream;
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2) resolve();
        else {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error("The camera preview could not be opened. Please try again."));
        }
      });
      await video.play();

      // Create the MediaPipe tracker only once per page. Its WASM runtime lives in
      // a global `Module`; creating or closing a second instance makes it abort with
      // "Module.arguments has been replaced with plain arguments_".
      const tracker = await getSharedTracker();
      sharedResultsHandler = (hands) => handleHands(hands);
      prepRef.current = new FramePrep();
      scaleIdxRef.current = 0;
      missRef.current = 0;
      trackerRef.current = tracker;
      setStatus("ready");

      const animate = (time: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (modeRef.current === "free" && !dragRef.current) {
          const bounds = getDrawingBounds();
          if (bounds && (offsetRef.current.vx || offsetRef.current.vy)) {
            const delta = lastFrameTimeRef.current ? (time - lastFrameTimeRef.current) / 1000 : 0;
            offsetRef.current = stepFlyingOffset(offsetRef.current, bounds, canvas.clientWidth, canvas.clientHeight, delta);
          }
        }
        lastFrameTimeRef.current = time;
        drawCanvas();
        const liveVideo = videoRef.current;
        const activeTracker = trackerRef.current;
        if (liveVideo && activeTracker && liveVideo.readyState >= 2 && liveVideo.currentTime !== lastVideoTimeRef.current && !inFlightRef.current) {
          lastVideoTimeRef.current = liveVideo.currentTime;
          inFlightRef.current = true;
          const prep = prepRef.current ?? (prepRef.current = new FramePrep());
          const detectScale = DETECT_SCALES[scaleIdxRef.current] ?? 1;
          const feed = prep.passthrough(liveVideo, detectScale) ?? prep.prepare(liveVideo, detectScale, true);
          const boosted = prep.brightnessGain > 1.3;
          if (boosted !== lowLightRef.current) { lowLightRef.current = boosted; setLowLight(boosted); }
          void activeTracker.send({ image: feed }).catch((err: unknown) => {
            console.error("[air-draw] hand tracking failed", err);
            (window as AirDrawWindow).__airDrawEngineBroken = true;
            if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            const detail = err instanceof Error ? err.message : String(err);
            setMessage(`Hand tracking stopped (${detail.slice(0, 120)}). Press Retry to reload and reconnect the camera.`);
            setStatus("error");
          }).finally(() => { inFlightRef.current = false; });
        }
        frameRef.current = requestAnimationFrame(animate);
      };
      frameRef.current = requestAnimationFrame(animate);
    } catch (error) {
      console.error("[air-draw] start failed", error);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus("error");
      const name = error instanceof Error ? error.name : "";
      setMessage(name === "NotReadableError" || name === "TrackStartError"
        ? "The camera is being used by another app or tab. Close it, then try again."
        : name === "NotAllowedError" || name === "PermissionDeniedError"
        ? "Camera access is off. Allow camera access in Chrome, then try again."
        : name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No camera was found. Connect a camera, then try again."
          : error instanceof Error
            ? error.message
            : "Air Draw couldn’t start. Check your camera and try again.");
    }
  }, [drawCanvas, getDrawingBounds, handleHands]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawCanvas());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawCanvas]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    sharedResultsHandler = null;
    trackerRef.current = null;
  }, []);

  const chooseMode = (next: Mode) => {
    modeRef.current = next;
    setMode(next);
    recorderRef.current.end(performance.now());
    dragRef.current = null;
    offsetRef.current = { ...offsetRef.current, vx: 0, vy: 0 };
  };

  const clearCanvas = () => {
    recorderRef.current.clear();
    offsetRef.current = { ...EMPTY_OFFSET };
    dragRef.current = null;
    setStrokeCount(0);
    drawCanvas();
  };

  const statusLabel = status === "ready" ? (handVisible ? "Hand detected" : "Show one hand") : status === "starting" ? "Starting camera" : "Camera is off";

  return (
    <main className="air-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Air Draw home"><span className="brand-mark"><Aperture size={19} strokeWidth={1.8} /></span><span>air draw</span></a>
        <div className="privacy-note"><LockKeyhole size={14} /><span>Private by design · video stays on this device</span></div>
        <div className="topbar-version">BROWSER STUDIO <span>01</span></div>
      </header>

      <section className="studio" aria-label="Air Draw studio">
        <div className="studio-heading">
          <div>
            <p className="eyebrow"><span className="eyebrow-dot" /> LIVE CANVAS</p>
            <h1>Make a little <em>magic.</em></h1>
            <p className="studio-subtitle">Move your hand. Leave a trace.</p>
          </div>
          <div className={`status-pill status-${status}`}><span className="status-dot" />{statusLabel}</div>
        </div>

        <div className={`draw-stage ${status === "ready" ? "is-live" : ""}`}>
          <video ref={videoRef} className="camera-video" autoPlay playsInline muted aria-label="Mirrored live camera preview" />
          <canvas ref={canvasRef} className="drawing-canvas" aria-label="Air drawing canvas" />
          {status !== "ready" && <div className="stage-empty">
            <div className="camera-orbit"><div className="orbit-ring orbit-ring-one" /><div className="orbit-ring orbit-ring-two" /><div className="camera-glyph"><Camera size={26} strokeWidth={1.45} /></div><span className="orbit-star orbit-star-a">✳</span><span className="orbit-star orbit-star-b">·</span></div>
            <h2>{status === "error" ? "Let’s try that again." : "Your canvas is waiting."}</h2>
            <p>{status === "error" ? message : "Allow camera access to begin drawing."}</p>
            <Button className="start-button" onClick={() => void startCamera()} disabled={status === "starting"}>
              {status === "starting" ? <LoaderCircle className="spin-icon" size={17} /> : status === "error" ? <RotateCcw size={16} /> : <Camera size={16} />}
              {status === "starting" ? "Opening camera…" : status === "error" ? "Retry camera" : "Start drawing"}
            </Button>
          </div>}
          {status === "ready" && <div className="stage-caption"><span className="caption-signal" />{handVisible ? "Tracking your hand" : "Waiting for your hand"} · {fps} fps{lowLight ? " · low-light boost on" : ""}</div>}
          <div className="stage-index">{String(strokeCount).padStart(2, "0")} <span>STROKES</span></div>
        </div>

        <div className="control-row">
          <div className="mode-controls" aria-label="Drawing mode">
            <Button variant={mode === "draw" ? "default" : "ghost"} className={`mode-button ${mode === "draw" ? "mode-active" : ""}`} onClick={() => chooseMode("draw")} aria-pressed={mode === "draw"}><Sparkles size={16} />Draw</Button>
            <Button variant={mode === "free" ? "default" : "ghost"} className={`mode-button ${mode === "free" ? "mode-active" : ""}`} onClick={() => chooseMode("free")} aria-pressed={mode === "free"}><Hand size={16} />Free</Button>
            <span className="control-divider" />
            {(["thin", "medium", "thick"] as BrushSize[]).map((size) => (
              <Button key={size} variant="ghost" className={`mode-button brush-button ${brush === size ? "mode-active" : ""}`} onClick={() => { brushRef.current = size; setBrush(size); }} aria-pressed={brush === size} aria-label={`${size} brush`}>
                <span className="brush-swatch" style={{ height: BRUSH_WIDTHS[size] }} />{size}
              </Button>
            ))}
            <span className="control-divider" />
            <Button variant="ghost" className={`mode-button ${assist ? "mode-active" : ""}`} onClick={() => { assistRef.current = !assist; setAssist(!assist); }} aria-pressed={assist} title="Track a lone fingertip when your whole hand is too close for the camera"><Sun size={16} />Close-up assist</Button>
            <span className="control-divider" />
            <Button variant="ghost" className={`mode-button ${showTrack ? "mode-active" : ""}`} onClick={() => { showTrackRef.current = !showTrack; setShowTrack(!showTrack); }} aria-pressed={showTrack} title="Show the dots the tracker sees on your hand"><Hand size={16} />Show tracking</Button>
            <span className="control-divider" />
            <Button variant="ghost" className="mode-button clear-button" onClick={clearCanvas}><Trash2 size={16} />Clear</Button>
          </div>
          <div className="mode-hint">{mode === "draw" ? <><span>INDEX</span> fingertip draws, even with an open hand · curl it to lift</> : <><span>PINCH</span> a stroke to grab · release to throw</>}</div>
        </div>

        <div className="studio-footer"><div className="footer-rule" /><p><Check size={13} /> Nothing is recorded or uploaded.</p><div className="footer-rule" /></div>
      </section>
      <footer className="bottom-note"><span>A SMALL SPACE TO MAKE SOMETHING</span><span>NO SAVING · NO SHARING · JUST PLAY</span></footer>
    </main>
  );
}