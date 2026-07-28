# HANDOFF

**Repo:** https://github.com/TarunYadgirkar/gestalt-gesture-dsl
**Live demo:** https://gestalt-pearl.vercel.app

```bash
npm install && npm test
```

147 tests, 7 files, all passing. `npx tsc --noEmit` clean.

---

## What works

### The DSL
YAML gesture definitions validated by a zod schema that rejects unknown keys, dangling
transition targets, unknown landmark names, undefined predicate references, predicate
cycles, missing accept states, and non-numeric thresholds — each with a path in the
message. Seven gestures ship: `pinch`, `pinch-drag`, `two-hand-scale`,
`two-hand-rotate`, `dwell-select`, `palm-push`, `swipe`.

Supports named predicates, `all`/`any`/`not` composition, hysteresis (paired
enter/exit thresholds), `min_hold_ms` dwell guards, state-entry captures, and an
expression mini-language (`abs`, `adiff`, `distance`, `speed`, per-axis deltas, `span`,
`pair_angle`, `capture.*`).

### The compiler
Compiles to an explicit state machine. `describe()` returns the full structure with
guards rendered including their numbers. `toDSL()` reconstructs a definition **from the
compiled structures**, not from a stashed copy of the input, so the round-trip test
actually exercises the compiler. Round-trip is a verified fixed point, and reloaded
machines produce byte-identical events on every fixture.

### The runtime
- Hand identity from spatial continuity; the Left/Right label is a hint only.
- One machine instance per tracked hand for `hands: 1` definitions.
- Dropout grace window; longer gaps emit `cancel` with `reason: 'tracking_lost'`,
  exactly once, never a spurious `end`.
- Competition via snapshot/rollback, with preemption by strictly-higher priority.
  Losers roll back silently and emit nothing.
- Confidence from tracking score scaled by how deep inside its threshold the guard sat.
- `inspect()` for live state + per-transition verdicts; `trace()` for the transition log.
- Fully deterministic: no wall-clock, no RNG.

### The eval harness
Session record/replay, per-gesture precision / recall / FP-per-minute / onset latency
with greedy nearest matching (one prediction cannot satisfy two labels), aggregation
that pools counts rather than averaging rates, baseline regression diffing with
per-metric tolerances, and a self-contained HTML report with SVG timelines.

Current corpus: **34 sessions — 100% precision, 100% recall, 0 FP/min.** The corpus
includes dropout-degraded variants on purpose, so a change that only survives on
pristine input does not pass.

The regression detector is verified non-vacuous: tightening the pinch threshold
produces `FAIL pinch.recall 1.000 -> 0.000` and exit code 1.

### The demo
Instrument panel with two frame sources through one identical pipeline: looping replay
of recorded sessions (no permissions needed) and live webcam via MediaPipe
HandLandmarker. The machine inspector shows each gesture's state chain with the current
state lit and every candidate transition with its live verdict and threshold. Plus a
"What is this?" explainer page.

---

## What is stubbed or deliberately absent

Nothing is stubbed behind a fake interface — there is no `BLOCKED.md` because nothing
had to be worked around. What is *out of scope* by design (SPEC §10):

- **No model training.** The system consumes MediaPipe output; it does not produce it.
- **No 3D world-space calibration.** Everything is normalized image space plus the z
  hint. Thresholds are therefore camera-distance sensitive.
- **Max two hands.** Multi-user is not modeled.
- **No authoring GUI.** Gestures are hand-written YAML.
- **No runtime state persistence** across process restarts.

Known sharp edges:

- **All fixtures are synthetic.** They have exactly known onset frames, which is what
  makes latency measurable — but they are cleaner than real MediaPipe output, which
  jitters. The recorded-session format exists precisely so real captures can be dropped
  in; none have been recorded yet.
- **`palm-push` depends on MediaPipe's z**, which is the least reliable axis. It works
  on synthetic data; expect to retune against real captures.
- **Swipe fires on a single frame crossing the speed floor.** Fine at the 3.6× margin
  the negatives establish, but real jitter may want a two-frame confirmation.
- **Default tolerances are loose relative to corpus size.** With 25 pinch instances,
  losing one is a 0.04 recall drop and passes the 0.05 default. Tighten as the corpus
  grows.

---

## The three highest-value next steps

### 1. Record real webcam sessions and re-tune against them
This is the single biggest gap. Every threshold in `gestures/*.yaml` was tuned against
synthetic geometry. The demo already imports `SessionRecorder`; wiring a record button
that dumps a `.session.json` into `fixtures/` would let the existing harness score real
hands with no other changes. Expect thresholds — especially `palm-push`'s z speed and
`dwell-select`'s stillness — to need widening once real jitter is in the corpus.

### 2. Add a per-gesture threshold sweep to the harness
The harness currently answers "did this change help?" It cannot yet answer "what value
*should* this threshold be?" A sweep that re-scores the corpus across a range for one
declared threshold, and plots precision/recall against it, turns tuning from guesswork
into reading a curve. The DSL already makes thresholds addressable data, so this is
mostly harness work: parameterize one field, recompile, re-score, chart.

### 3. Confidence is the weakest modeled quantity
It is currently `mean(tracking score) × threshold depth`, which is monotonic and
testable but arbitrary. It matters because it is the second tiebreak in competition
resolution — so two equal-priority gestures are separated by a number nobody has
validated. Either calibrate it against labeled data so it means "probability this is
real", or drop it from the resolution order and make the tiebreak purely structural.
The current state is the uncomfortable middle.

---

## Where things live

| Path | What |
|---|---|
| `SPEC.md` | The contract. Section numbers are referenced from code comments and tests. |
| `DECISIONS.md` | Every ambiguity resolved autonomously, with reasoning. 19 entries. |
| `DEPENDENCIES.md` | Every external dependency and why. |
| `PROGRESS.md` | Running log. |
| `gestures/*.yaml` | Gesture definitions — the source of truth, shared by tests and demo. |
| `fixtures/baseline.json` | Committed regression baseline. |
| `test/acceptance/` | detection, negatives, dropout, competition, round-trip. |

## Commands

```bash
npm test
```

```bash
npm run regression
```

```bash
npm run report -- --out report-out/index.html
```

```bash
npm run demo
```
