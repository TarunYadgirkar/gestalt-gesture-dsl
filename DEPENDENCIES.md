# DEPENDENCIES

Every external thing pulled in, what it is, why.

## Runtime (core library — must stay lean)
- **zod** — schema validation for the DSL. Turns malformed YAML into typed errors with
  paths. Core has no other runtime deps (no MediaPipe, no DOM) so it runs anywhere.

## Dev / harness
- **typescript** — language, strict mode.
- **vitest** — test runner for unit + acceptance suites.
- **js-yaml** — parse the YAML gesture DSL (and dump for round-trip).
- **@types/js-yaml**, **@types/node** — types.
- **tsx** — run TS CLIs (regression runner, report generator) without a build step.

## Browser demo only (isolated in demo/, not imported by core or tests)
- **vite** — dev server + bundler for the demo page.
- **@mediapipe/tasks-vision** — HandLandmarker model + webcam inference in the browser.
  Pulled at demo runtime; model weights fetched from the MediaPipe CDN by the browser.

## Not pulled / considered and rejected
- pnpm — broken on this machine (see DECISIONS D2); using npm.
- @mediapipe/hands (legacy) — superseded by tasks-vision (D13).
- A charting lib for the HTML report — hand-rolled inline SVG instead (self-contained,
  zero deps, matches "no external assets" requirement).
