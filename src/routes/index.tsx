import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Aperture, Camera, Check, Hand, LoaderCircle, LockKeyhole, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  containsPoint,
  indexFingerIsExtended,
  isPinching,
  isWithinTrackingGrace,
  moveDrawing,
  stepFlyingOffset,
  type DrawingBounds,
  type FlyingOffset,
  type Point,
  TRACKING_GRACE_MS,
} from "@/lib/air-draw";

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
type Stroke = { points: Point[] };
type HandsController = { send: (input: { image: HTMLVideoElement }) => Promise<void>; close: () => Promise<void> };

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedTrackerPromise: Promise<any> | null = null;
let sharedResultsHandler: ((landmarks: Point[] | undefined) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSharedTracker(): Promise<any> {
  if (!sharedTrackerPromise) {
    sharedTrackerPromise = (async () => {
      const Hands = await loadHandsConstructor();
      const tracker = new Hands({ locateFile: (file: string) => `/mediapipe/hands/${file}` });
      tracker.setOptions({ maxNumHands: 1, modelComplexity: 0, selfieMode: false, minDetectionConfidence: 0.62, minTrackingConfidence: 0.58 });
      tracker.onResults((results: TrackerResults) => sharedResultsHandler?.(results.multiHandLandmarks?.[0]));
      await tracker.initialize();
      return tracker;
    })().catch((err) => { sharedTrackerPromise = null; throw err; });
  }
  return sharedTrackerPromise;
}

const EMPTY_OFFSET: FlyingOffset = { x: 0, y: 0, vx: 0, vy: 0 };

function AirDraw() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<HandsController | null>(null);
  const frameRef = useRef<number | null>(null);
  const modeRef = useRef<Mode>("draw");
  const strokesRef = useRef<Stroke[]>([]);
  const offsetRef = useRef<FlyingOffset>({ ...EMPTY_OFFSET });
  const drawingRef = useRef(false);
  const lastSeenRef = useRef(0);
  const lastPointRef = useRef<Point | null>(null);
  const filteredPointRef = useRef<Point | null>(null);
  const lastFrameTimeRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const inFlightRef = useRef(false);
  const dragRef = useRef<{ point: Point; time: number; vx: number; vy: number } | null>(null);
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
    context.lineWidth = 4;
    context.strokeStyle = "#f7f8f5";
    context.shadowColor = "rgba(238, 255, 246, 0.72)";
    context.shadowBlur = 14;
    for (const stroke of strokesRef.current) {
      const points = stroke.points;
      if (!points.length) continue;
      context.beginPath();
      context.moveTo(points[0]!.x, points[0]!.y);
      if (points.length === 1) {
        context.lineTo(points[0]!.x + 0.1, points[0]!.y + 0.1);
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
  }, []);

  const getDrawingBounds = useCallback((): DrawingBounds | null => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokesRef.current) {
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

  const handleLandmarks = useCallback((landmarks: Point[] | undefined) => {
    const now = performance.now();
    if (!landmarks || landmarks.length < 21) {
      setHandVisible(false);
      if (drawingRef.current && !isWithinTrackingGrace(lastSeenRef.current, now)) {
        drawingRef.current = false;
        lastPointRef.current = null;
      }
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
    const point = { x: (1 - tip.x) * rect.width, y: tip.y * rect.height };

    if (modeRef.current === "draw") {
      const extended = indexFingerIsExtended(landmarks);
      if (!extended) {
        drawingRef.current = false;
        lastPointRef.current = null;
        filteredPointRef.current = null;
        return;
      }
      if (!drawingRef.current || !isWithinTrackingGrace(lastSeenRef.current, now)) {
        strokesRef.current.push({ points: [point] });
        drawingRef.current = true;
        filteredPointRef.current = point;
        setStrokeCount(strokesRef.current.length);
      } else {
        const previous = filteredPointRef.current ?? point;
        const filtered = { x: previous.x + (point.x - previous.x) * 0.38, y: previous.y + (point.y - previous.y) * 0.38 };
        const stroke = strokesRef.current[strokesRef.current.length - 1];
        if (stroke && Math.hypot(filtered.x - previous.x, filtered.y - previous.y) > 0.8) {
          stroke.points.push(filtered);
        }
        filteredPointRef.current = filtered;
      }
      lastSeenRef.current = now;
      lastPointRef.current = point;
      return;
    }

    drawingRef.current = false;
    lastPointRef.current = null;
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

  const startCamera = useCallback(async () => {
    setStatus("starting");
    setMessage("");
    setHandVisible(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser can’t access a camera. Open Air Draw in a current version of Chrome over a secure connection.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
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
      sharedResultsHandler = (landmarks) => handleLandmarks(landmarks);
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
          void activeTracker.send({ image: liveVideo }).catch(() => {
            setMessage("Hand tracking paused. Retry to reconnect the camera.");
            setStatus("error");
          }).finally(() => { inFlightRef.current = false; });
        }
        frameRef.current = requestAnimationFrame(animate);
      };
      frameRef.current = requestAnimationFrame(animate);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus("error");
      const name = error instanceof Error ? error.name : "";
      setMessage(name === "NotAllowedError" || name === "PermissionDeniedError"
        ? "Camera access is off. Allow camera access in Chrome, then try again."
        : name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No camera was found. Connect a camera, then try again."
          : error instanceof Error
            ? error.message
            : "Air Draw couldn’t start. Check your camera and try again.");
    }
  }, [drawCanvas, getDrawingBounds, handleLandmarks]);

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
    drawingRef.current = false;
    lastPointRef.current = null;
    filteredPointRef.current = null;
    dragRef.current = null;
    offsetRef.current = { ...offsetRef.current, vx: 0, vy: 0 };
  };

  const clearCanvas = () => {
    strokesRef.current = [];
    offsetRef.current = { ...EMPTY_OFFSET };
    drawingRef.current = false;
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
          {status === "ready" && <div className="stage-caption"><span className="caption-signal" />{handVisible ? "Tracking your hand" : "Waiting for your hand"}</div>}
          <div className="stage-index">{String(strokeCount).padStart(2, "0")} <span>STROKES</span></div>
        </div>

        <div className="control-row">
          <div className="mode-controls" aria-label="Drawing mode">
            <Button variant={mode === "draw" ? "default" : "ghost"} className={`mode-button ${mode === "draw" ? "mode-active" : ""}`} onClick={() => chooseMode("draw")} aria-pressed={mode === "draw"}><Sparkles size={16} />Draw</Button>
            <Button variant={mode === "free" ? "default" : "ghost"} className={`mode-button ${mode === "free" ? "mode-active" : ""}`} onClick={() => chooseMode("free")} aria-pressed={mode === "free"}><Hand size={16} />Free</Button>
            <span className="control-divider" />
            <Button variant="ghost" className="mode-button clear-button" onClick={clearCanvas}><Trash2 size={16} />Clear</Button>
          </div>
          <div className="mode-hint">{mode === "draw" ? <><span>INDEX</span> finger up to draw · fold to finish</> : <><span>PINCH</span> a stroke to grab · release to throw</>}</div>
        </div>

        <div className="studio-footer"><div className="footer-rule" /><p><Check size={13} /> Nothing is recorded or uploaded.</p><div className="footer-rule" /></div>
      </section>
      <footer className="bottom-note"><span>A SMALL SPACE TO MAKE SOMETHING</span><span>NO SAVING · NO SHARING · JUST PLAY</span></footer>
    </main>
  );
}