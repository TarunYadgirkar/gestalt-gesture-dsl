# SPEC — Gestalt: Declarative Gesture Recognition for Hand-Tracked Spatial Interfaces

Status: living document. Section numbers are stable references for tests.

## 0. Goal

Two coupled deliverables:

1. **Recognizer** — a declarative DSL (YAML) for defining hand gestures, a compiler
   that turns each definition into an explicit, inspectable temporal state machine,
   and a runtime that consumes a stream of MediaPipe Hands landmark frames and emits
   typed gesture events with confidence and timing.
2. **Eval harness** — record/replay of landmark sessions with ground-truth labels,
   per-gesture metrics (precision, recall, false-positive rate/min, onset latency),
   a regression mode that diffs against a committed baseline, and an HTML timeline
   report (predicted vs ground truth).

Plus a browser demo (webcam + MediaPipe) for manual sanity checking.

## 1. Landmark schema (input)

Mirrors MediaPipe Hands.

```
Landmark = { x: number, y: number, z: number }   // x,y normalized [0,1]; z ~ relative depth
HandSample = {
  handedness: 'Left' | 'Right',
  score: number,            // handedness/tracking confidence [0,1]
  landmarks: Landmark[21],  // MediaPipe 21-point topology
}
Frame = { t: number, hands: HandSample[] }        // t in ms, monotonic
```

Landmark indices (MediaPipe): 0 wrist; 1-4 thumb CMC/MCP/IP/TIP; 5-8 index MCP/PIP/DIP/TIP;
9-12 middle; 13-16 ring; 17-20 pinky.

Named points (aliases): `wrist`, `thumb_tip`(4), `index_tip`(8), `middle_tip`(12),
`ring_tip`(16), `pinky_tip`(20), `index_mcp`(5), `middle_mcp`(9), `pinky_mcp`(17),
and derived `palm_center` = centroid of {0,5,9,13,17}.

Coordinate note: MediaPipe image coords are y-down. "up" in gesture space = -y.

## 2. DSL (gesture definition)

A gesture is a YAML document. Grammar (validated by a schema; see §2.5):

```yaml
name: string                 # unique gesture id
hands: 1 | 2                 # required tracked hand count
priority: number             # resolver tiebreak, higher wins (default 0)
description: string?

points:                      # optional custom named points (index or centroid)
  <alias>: <int> | [<int>...]

predicates:                  # named boolean conditions over one frame
  <name>:
    <predicate>              # see §2.1

states:                      # temporal state machine; first is initial
  - id: string
    initial: bool?           # default: first state is initial
    accept: bool?            # entering an accept state emits the gesture's 'update'/lifecycle
    emit: EmitSpec?          # event emitted on ENTERING this state
    capture: {<key>: <expr>}? # snapshot a scalar into machine memory on entry
    transitions:
      - when: <predicate-ref-or-inline>
        to: string           # target state id
        min_hold_ms: number? # guard must hold continuously this long (dwell)
        emit: EmitSpec?      # emitted when this transition fires
        reason: string?      # label for the inspector / cancellation docs
```

### 2.1 Predicate types

Leaf predicates evaluate against the current frame (+ prev frame for velocity):

```
{ distance: { a: point, b: point, lt|lte|gt|gte: number } }
{ angle:    { at: point, from: point, to: point, lt|gt: number } }   # degrees
{ curl:     { finger: thumb|index|middle|ring|pinky, gt|lt: number } } # 0=straight..1=fist
{ speed:    { point: point, axis: x|y|z|planar?, gt|lt: number } }   # normalized units / second
{ expr:     { value: "<expr>", gt|lt: number } }      # §2.4 expression vs a threshold
{ tracked:  { hand: any|h0|h1 } }                     # is the referenced hand present
```

`speed` defaults to `axis: planar` (magnitude in xy). With an explicit axis the value is
**signed**, so `{ axis: z, lt: -0.8 }` means "moving toward the camera fast".

`expr` is what makes ratio/delta conditions expressible without new predicate kinds —
e.g. `abs(span / capture.anchor_span - 1) > 0.1` for scale.

Two-hand references: a point may be prefixed `h0.` / `h1.` (role slots) e.g. `h0.index_tip`.
Cross-hand derived: `span` = distance(h0.palm_center, h1.palm_center);
`pair_angle` = angle of the h0→h1 palm_center vector (degrees, atan2, y-up).

### 2.2 Composition

```
{ all: [ <predicate>... ] }   # AND
{ any: [ <predicate>... ] }   # OR
{ not: <predicate> }
"<name>"                       # reference to a named predicate
```

### 2.3 Hysteresis

Any leaf threshold predicate may declare a paired exit threshold:

```
{ distance: { a: thumb_tip, b: index_tip, lt: 0.05, exit: 0.08 } }
```

Semantics: while the predicate is currently FALSE it uses the primary threshold to
become TRUE (tight, `lt: 0.05`); while currently TRUE it uses `exit` to become FALSE
(loose, `0.08`). State is per (machine, predicate instance). Prevents boundary flicker.

### 2.4 EmitSpec

```
EmitSpec = {
  phase: 'start'|'update'|'end'|'cancel',
  data?: { <key>: <expr> }   # scalars computed at emit time (may read captures)
}
```

`<expr>` mini-language — infix arithmetic (`+ - * /`, parens, numbers) over:

| term | meaning |
|---|---|
| `x(p)` `y(p)` `z(p)` | coordinate of point `p` |
| `dx(p)` `dy(p)` `dz(p)` | per-frame delta of `p` (0 on the first frame) |
| `distance(a,b)` | 3D distance between two points |
| `curl(finger)` | finger curl 0..1 |
| `speed(p)` | planar speed of `p`, units/s |
| `span` | distance(h0.palm_center, h1.palm_center) — 2-hand only |
| `pair_angle` | atan2 angle of the h0→h1 palm vector, degrees, y-up — 2-hand only |
| `capture.<key>` | scalar snapshotted on state entry |
| `abs(e)` `adiff(a,b)` | absolute value; signed angle difference wrapped to (-180,180] |

Enough to express scale factor, rotation delta, and drag delta.

### 2.5 Validation

DSL parsed and validated by a schema (zod). Unknown keys, bad point names, missing
target states, and non-numeric thresholds are hard errors with a path.

## 3. Compiler → state machine

`compile(def) -> CompiledMachine`:

```
CompiledMachine = {
  name, hands, priority,
  initial: stateId,
  states: Map<id, { id, accept, emit, capture, transitions: CompiledTransition[] }>,
  points: resolved alias table,
  predicates: resolved predicate table,
}
```

`CompiledTransition = { when: PredicateFn, to, minHoldMs, emit, reason }`.

**Inspectable**: `machine.describe()` returns a plain JSON tree (states, transitions,
guard descriptions, thresholds). `machine.toDSL()` re-serializes to an equivalent
definition (round-trip, §7 test). Deterministic ordering.

## 4. Runtime

```
const rec = new Recognizer([compiled...], options?)
const events: GestureEvent[] = rec.push(frame)   // advance all machines by one frame
rec.trace(name)                                   // inspect why: transition log
```

`GestureEvent = { gesture, phase, t, confidence, hands: HandId[], data?, latencyMs? }`.

Per-frame algorithm:
1. **Hand identity** — assign stable `HandId`s by nearest-wrist continuity to the
   previous frame (Hungarian-lite greedy), NOT by trusting the raw Left/Right label
   frame-to-frame. Handedness label kept as a hint only. Resolves label flips (§6).
2. **Instancing & role binding** — a `hands: 1` definition gets one machine *instance
   per tracked hand* (so a pinch is recognized on either hand independently); a
   `hands: 2` definition gets one instance bound to both. Role slots h0/h1 bind in
   ascending HandId order. Once an instance is mid-gesture (past its initial state),
   its binding is sticky until it resets.
3. **Dropout / leaving frame** — if a bound hand is missing this frame, start a grace
   timer (`options.dropoutGraceMs`, default 200). Within grace: machine holds state,
   guards that need the missing hand evaluate false but do not cancel. Beyond grace:
   emit `cancel` (reason `tracking_lost`) and reset the machine.
4. **Step machines** — evaluate transitions of each machine's current state in order;
   first satisfied guard (respecting `min_hold_ms` dwell timers and hysteresis) fires.
   A transition whose `to` equals the current state is a **self-transition**: it emits
   but does NOT re-run the state's `capture` (so anchors survive `update` ticks).
5. **Resolve competition** (§5) — filter simultaneously-firing gestures that claim
   overlapping hands.
6. Collect emitted events, stamp `latencyMs` when the machine records a true onset.

**Confidence**: `clamp01(mean(handScore) * marginFactor)` where `marginFactor` grows
with how far inside its threshold each firing predicate sits (0.5 at the boundary → 1.0
deep inside). Exact formula in code, covered by a unit test.

## 5. Competing gestures (deterministic resolution)

Two machine instances **compete** when their claimed `HandId` sets intersect. Resolution
runs every frame, over the instances that want to emit a `start` this frame:

1. **Fresh vs fresh** — pick the winner by, in order: (a) higher `priority`,
   (b) higher `confidence`, (c) lexicographically smaller `name`. Total order, no ties,
   no wall-clock, no RNG. Losers roll back to their pre-fire state and emit nothing.
2. **Fresh vs active** — an already-started gesture holds its claim, *unless* the
   newcomer has **strictly higher `priority`**. Then the newcomer **preempts**: the
   active gesture is reset and emits `cancel` with
   `reason: 'preempted_by:<winner>'`, and the newcomer starts on the same frame.
   Equal or lower priority ⇒ the newcomer is suppressed while the incumbent stays active.
3. A preempted gesture may re-arm later; it is not permanently locked out.

Rule 2 is what makes escalation work: a `pinch` (priority 10) that starts to move is
superseded by `pinch-drag` (priority 20) rather than blocking it forever, and both
one-hand pinches are superseded by `two-hand-scale` (priority 30) when the second hand
joins. The `cancel` event tells a consumer to undo any effect the pinch already applied.

Shipped priorities: two-hand-scale/rotate 30 > pinch-drag 20 > dwell-select/palm-push 15
> pinch 10 > swipe 5.

Documented and asserted (§11 competing).

## 6. Robustness requirements

- **Tracking dropout mid-gesture**: brief gaps (≤ grace) tolerated without cancel;
  longer gaps cancel cleanly with a `cancel` event, never a spurious `end`.
- **Hands leaving frame**: treated as dropout for the affected hand.
- **Left/right flips**: stable ids via spatial continuity; a single-frame label swap
  must not cancel or duplicate a gesture.
- **Determinism**: identical frame input ⇒ identical event output (no wall-clock, no RNG
  in the runtime path).

## 7. Eval harness

### 7.1 Record/replay format (`*.session.json`)

```
Session = {
  meta: { name, fps?, schema: 'gestalt/v1', createdBy },
  frames: Frame[],
  labels: GroundTruth[],   // { gesture, hands?, onset: t|frame, offset: t|frame }
}
```

`recordSession`, `loadSession`, `saveSession`. Replay = feed frames through a Recognizer.

### 7.2 Metrics

Match predicted `start` events to GT intervals: a prediction is a true positive if its
`t` falls within `[onset - preTol, offset + postTol]` of an unmatched GT of the same
gesture (greedy nearest). Per gesture:

- `precision = TP / (TP + FP)`
- `recall = TP / (TP + FN)`
- `fpPerMin = FP / (durationMs / 60000)`
- `latencyMs` = median(matchedPredEvent.t − GT.onset) over TPs (may be negative if early)

### 7.3 Regression mode

`runRegression(fixtures, baseline)` → report + pass/fail. Fails if, for any gesture:
recall drops > `tol.recall` (default 0.05), OR precision drops > `tol.precision` (0.05),
OR fpPerMin rises > `tol.fpPerMin` (0.5), OR median latency rises > `tol.latencyMs` (50).
`baseline.json` is committed; `--update-baseline` rewrites it.

### 7.4 HTML report

Self-contained HTML: per-session timeline lanes (GT vs predicted, color-coded TP/FP/FN),
plus the metrics tables and the regression verdict. No external assets.

## 8. Synthetic data (for tests)

`poser.ts` builds a plausible 21-landmark hand for a named pose (`open`, `pinch`, `fist`,
`point`, `palm_forward`) at a given center/scale/rotation, with linear pose interpolation.
`sequences.ts` composes labeled sessions for each gesture with **exact known onset frames**,
and **adversarial near-miss** sessions (pinch that doesn't close; drag too slow; etc.).

## 9. Gestures shipped (v1)

pinch, pinch-drag, two-hand-scale, two-hand-rotate, dwell-select, palm-push, swipe.

## 10. Out of scope (v1)

- Real ML/model training; we consume MediaPipe output, we don't produce it.
- 3D world-space calibration; we operate in normalized image space (+ z hint).
- Multi-user / >2 hands.
- Gesture *authoring* GUI (DSL is hand-written YAML).
- Persisting runtime state across process restarts.
- Mobile/native runtime (browser + Node only).

## 11. Acceptance tests (authored before implementation)

- **Detection**: each shipped gesture, synthetic positive session, fires the correct
  event within a per-gesture latency budget of its true onset.
- **Negatives**: adversarial near-miss sessions produce zero fires for the target gesture.
- **Dropout**: randomly drop 10% of frames; positive still detected, no spurious cancel
  storms; behavior graceful and deterministic given a fixed seed.
- **Competing**: a frame that satisfies two gestures resolves per §5, deterministically.
- **Round-trip**: def → compile → toDSL → re-parse → re-compile produces an identical
  `describe()` and identical event output on a fixture stream.
