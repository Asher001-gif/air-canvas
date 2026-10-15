# Air Canvas

Air Draw: final idea (v2)

What it is: a browser-only, laptop-first prototype. The webcam shows your mirrored live video, and a hand-tracking model running in the page follows one hand. There’s no backend, and nothing is uploaded.

Controls: three normal on-screen buttons (Draw, Free, Clear) that you click with the mouse. Everything else is done with your hand. If your hand isn’t in the camera view, nothing happens.

Draw mode

Extending your index finger draws a stroke under your fingertip. Folding it ends the stroke.

Strokes are white with a soft glow, at medium thickness.

Light smoothing keeps lines clean without feeling laggy.

If tracking drops briefly, the stroke bridges the gap for about 150 ms, then ends.

Free mode

Nothing draws. The whole drawing acts as one 2D object.

Pinch thumb and index finger anywhere on the drawing to grab it. It follows your hand while you hold the pinch.

Releasing while moving throws it. It keeps its velocity, slows with friction, and bounces off the screen edges until it settles.

No rotation and no scaling for now.

Other behavior

Clear wipes everything instantly, with no undo.

If the camera is denied or missing, a clear message appears with a retry button. Its website and make sure elements load on every chrome browser almost like on chrome 109 too TRy.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/79463b02-a1a6-4a29-af00-f7957d8f56d5).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
