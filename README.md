# Gestalt

Declarative gesture recognition for hand-tracked spatial interfaces, plus the eval
harness that makes it tunable.

Gestures are written as YAML, compiled into explicit temporal state machines you can
inspect while they run, and measured against labeled sessions so you can tell whether a
threshold change actually helped.

```yaml
name: pinch
hands: 1
priority: 10

predicates:
  pinched:
    distance: { a: thumb_tip, b: index_tip, lt: 0.05, exit: 0.075 }

states:
  - id: idle
    transitions:
      - when: pinched
        to: closed
        reason: thumb and index tips closed
        emit: { phase: start }

  - id: closed
    accept: true
    transitions:
      - when: { not: pinched }
        to: idle
        reason: fingers separated past the release threshold
        emit: { phase: end }
```

## Setup

Requires Node 20+.

```bash
npm install
```

```bash
npm test
```

## Usage

### Recognize gestures

```ts
import { loadGestureLibrary, Recognizer } from './src/index.js';

const recognizer = new Recognizer(loadGestureLibrary());

for (const frame of frames) {           // frames are MediaPipe Hands landmark frames
  for (const event of recognizer.push(frame)) {
    console.log(event.gesture, event.phase, event.confidence, event.data);
  }
}
```

A `GestureEvent` carries `gesture`, `phase` (`start` / `update` / `end` / `cancel`),
`t`, `confidence`, the `hands` it consumed, any `data` the definition emits, and a
`reason` on cancellation.

Frames follow the MediaPipe Hands schema:

```ts
type Frame = {
  t: number;                            // ms, monotonic
  hands: {
    handedness: 'Left' | 'Right';       // a hint only — identity is spatial
    score: number;
    landmarks: { x: number; y: number; z: number }[];  // 21 points
  }[];
};
```

### Inspect why it fired

```ts
recognizer.inspect();   // current state + every candidate transition with its verdict
recognizer.trace('pinch');  // transition log: from, to, the guard that fired, why
```

`inspect()` renders guards with their thresholds intact, e.g.
`pinched[distance(thumb_tip,index_tip) lt 0.05 (release 0.075)] → closed`.

### Evaluate and catch regressions

```bash
npm run eval
```

```bash
npm run regression
```

```bash
npm run report -- --out report-out/index.html
```

`regression` scores the whole fixture corpus against `fixtures/baseline.json` and exits
non-zero if any gesture degrades beyond tolerance. Re-baseline deliberately:

```bash
npm run regression -- --update-baseline
```

### Run the demo

```bash
npm run demo
```

Opens an instrument panel at `localhost:5178`: viewport, live state machines, and an
event tape. Replay a recorded session with no permissions, or use your webcam.

## Writing a gesture

Definitions live in `gestures/*.yaml` and are picked up automatically.

| Field | Purpose |
|---|---|
| `hands` | `1` instantiates the machine per tracked hand; `2` binds one instance to both |
| `priority` | Higher wins competition, and strictly-higher preempts an active gesture |
| `predicates` | Named conditions, evaluated once per frame in dependency order |
| `states` | The machine. First state is initial unless one sets `initial: true` |
| `accept` | Marks the state that means "this gesture is happening" |

Predicates: `distance`, `angle`, `curl`, `speed` (optionally per-axis and signed),
`expr`, `tracked`, composed with `all` / `any` / `not`.

Transitions take `when`, `to`, an optional `min_hold_ms` dwell, an `emit`, and a
`reason` string that shows up in the trace.

**Hysteresis.** Any threshold may declare `exit`. The primary threshold latches the
condition on; the looser `exit` value releases it. Without this, a hand resting on the
boundary emits a burst of start/end events.

**Captures.** A state may `capture` scalars on entry; later expressions read them as
`capture.<key>`. This is how scale anchors its span and rotate anchors its bearing. A
self-transition deliberately does not re-capture, so `update` ticks keep their anchor.

## How competition resolves

Two machines compete when they claim overlapping hands.

1. Among gestures firing on the same frame: highest `priority`, then highest
   `confidence`, then lexicographically smallest `name`. Losers roll back silently.
2. A newcomer with **strictly higher** priority preempts an active gesture: the
   incumbent is cancelled with `reason: 'preempted_by:<winner>'` and the winner starts
   on the same frame. Equal or lower priority is suppressed.

Shipped priorities: two-hand-scale/rotate 30 > pinch-drag 20 > dwell-select/palm-push 15
> pinch 10 > swipe 5. So a pinch that starts moving escalates to a drag, and two pinched
hands moving apart escalate to a two-hand gesture, each step telling the previous
gesture to undo itself.

## When tracking fails

- **Dropped frames** — brief gaps are held through a grace window (200ms default).
- **Lost tracking** — a longer gap emits `cancel` with `reason: 'tracking_lost'`, never
  a clean `end`, because the gesture did not end.
- **Handedness flips** — identity comes from spatial continuity, not the model's
  Left/Right label. A single-frame swap changes nothing.
- **Determinism** — no wall-clock and no RNG in the runtime. Identical input always
  produces identical events.

## Layout

```
gestures/          gesture definitions (YAML) — the source of truth
src/
  dsl/             schema, parser, expression language, compiler
  runtime/         hand tracker, machine instances, recognizer
  eval/            session I/O, metrics, regression, HTML report
  synthetic/       poser and sequence builders for fixtures
  cli/             eval CLI
test/
  acceptance/      detection, negatives, dropout, competition, round-trip
demo/              browser demo (Vite + MediaPipe)
fixtures/          committed regression baseline
```

The core library depends only on `zod` and `js-yaml` — no DOM, no MediaPipe — so the
same compiled machines run in Node tests and in the browser.

## License

MIT
