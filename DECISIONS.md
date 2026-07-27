# DECISIONS

Ambiguities resolved autonomously. Bias: pick the option that is easier to test.

## D1 — Language & stack: TypeScript (strict) + Node + Vite
Both halves + the browser demo share one language. Recognizer/harness run in Node
(Vitest); demo runs in browser via Vite. TS strict per global prefs.

## D2 — Package manager: npm (not pnpm)
Global pref is pnpm, but `pnpm` is broken on this machine (corepack + node 20.20.0:
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). npm 10.8.2 works. Not spending the autonomy
budget fixing corepack. Switchable later.

## D3 — Test runner: Vitest
TS-native, fast, same config for unit + acceptance. Runs the harness in-process.

## D4 — DSL format: YAML defining an explicit state machine (not a flat rule list)
The task demands temporal sequencing, holds, hysteresis, cancellation and
inspectability. A state-machine-shaped DSL maps 1:1 onto the compiled artifact, so the
compiler is a transliteration and the inspector is trivial. Flat "rules" would need an
implicit machine anyway — worse to inspect.

## D5 — Hysteresis as paired thresholds on a leaf predicate (`lt` + `exit`)
Rather than a separate global smoothing layer. Keeps hysteresis local to the condition
that needs it, per-machine stateful, and visible in `describe()`. Easy to unit-test:
sweep a value across the band and assert the latch.

## D6 — Hand identity by spatial continuity, handedness label as hint only
MediaPipe's Left/Right label flips frame-to-frame under fast motion/occlusion. Tracking
identity by nearest previous wrist gives stable ids and directly satisfies the
"left/right assignment flips" robustness requirement. Greedy nearest-neighbor (2 hands
max — full Hungarian unnecessary).

## D7 — Dropout handled by a grace timer, not immediate cancel
Brief tracking gaps are common and shouldn't kill an in-progress gesture. Grace window
(default 200ms) holds machine state; exceeding it emits `cancel(reason=tracking_lost)`.
Distinguishes a real gesture end from a tracking hiccup — the FP/robustness axis that
matters.

## D8 — Competition resolver: active-holds-claim, then priority > confidence > name
Deterministic and documented (SPEC §5). Name tiebreak guarantees total order with no
wall-clock/RNG, so the "deterministic resolution" test is exact.

## D9 — Determinism: no wall-clock, no RNG in the runtime
All time comes from `frame.t`. Synthetic data + dropout use a seeded PRNG. Makes every
acceptance test reproducible and the round-trip test meaningful.

## D10 — Confidence = mean(handScore) × marginFactor(threshold depth)
A gesture squarely inside its thresholds is more confident than one at the boundary.
Simple, monotonic, unit-testable. Not a learned score (out of scope, §10).

## D11 — Session format: single JSON file with frames + labels embedded
One artifact per fixture is easier to commit, diff, and load than split frame/label
files. JSONL considered; rejected because fixtures are small and JSON round-trips with
the type layer for free.

## D12 — Build directly, don't delegate to Codex subagent
Global prefs suggest delegating mechanical execution. This is a from-scratch,
tightly-coupled system where the type surface is the contract; keeping it in one head
avoids interface drift. Revisit for bulk-mechanical phases (e.g. many fixtures).

## D13 — Browser demo uses @mediapipe/tasks-vision (HandLandmarker)
Current MediaPipe web API (supersedes legacy @mediapipe/hands). Loaded in the demo only;
the core library has zero MediaPipe dependency (it just consumes the frame schema), so
Node tests never touch it.

## D14 — Repo location: /Users/tarunyadgirkar/Claude/gestalt
cwd already holds the user's projects. Memory notes a ~/TarunsCode convention, but that
tree isn't present here and cwd is where the session launched. Self-contained git repo.
