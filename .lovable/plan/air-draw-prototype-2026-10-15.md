# Air Draw prototype

## Goal
Build a private, laptop-first browser drawing app with on-device hand tracking, no backend, and a dependable Chrome 109-era compatibility path.

## Work
- Replace `/` with the Air Draw experience and its app-specific page metadata; establish a dark, restrained camera-workspace design system.
- Add a browser-only camera/tracking workspace: mirrored live preview, drawing canvas, mouse-operated Draw/Free/Clear controls, and clear permission/device/model failure states with retry.
- Use pinned MediaPipe Hands assets served by the app (rather than a third-party runtime CDN) and load camera/tracking code only after hydration and a user action; camera frames remain in the browser.
- Implement smoothed index-finger drawing, a 150 ms tracking grace period, pinch-to-drag in Free mode, and friction/edge-bounce throwing without rotation or scaling.
- Add focused tests for the gesture and motion rules; check the preview, build log, current Chromium behavior, and Chrome 109-era API/syntax compatibility where the available browser permits.

## Technical notes
- Keep all camera and ML inference in browser-only effects/event handlers; do not add Cloud, persistence, upload, or server code.
- Isolate pure drawing/physics rules from the UI so they can be tested without camera hardware.
- Chrome 109 compatibility can be targeted through conservative APIs and pinned local model assets, but cannot be claimed as tested unless that browser binary is available.
