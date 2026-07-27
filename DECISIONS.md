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

## D15 — Competition allows preemption by strictly-higher priority
Original §5 draft said "active gesture always holds its claim". That deadlocks the most
important real case: a `pinch` fires the instant the fingers close, so it is always
already active by the time the hand starts moving — `pinch-drag` could never fire. Fixed
by letting a strictly-higher-priority newcomer preempt the incumbent, which emits
`cancel(reason='preempted_by:<winner>')`. Still fully deterministic (priority is static,
strictly-greater is antisymmetric so no cycles). This is also the honest UX: the consumer
gets told to undo the pinch effect. Alternative considered — requiring a pinch to be
*still* for 100ms before firing — was rejected: it makes every pinch laggy to remove a
conflict that preemption models better.

## D16 — `hands: 1` gestures instantiate per tracked hand
A one-hand definition with two hands on screen must recognize independently on each.
The runtime keeps a machine instance per HandId for 1-hand definitions, and a single
instance for 2-hand ones. Consequence: in the two-hand fixtures `pinch` legitimately
fires on both hands before the two-hand gesture preempts it — so those fixtures carry
honest `pinch` ground-truth labels rather than being treated as false positives.

## D17 — `expr` predicate instead of bespoke ratio/delta predicate kinds
Scale needs `span / anchor_span`, rotate needs `angle_delta`. Rather than one predicate
kind per gesture family, there is a single `expr` predicate comparing a mini-language
expression to a threshold. Keeps the DSL small and lets new gestures be added without
touching the compiler.

## D18 — Preemption escalates one rung at a time; tests updated to assert the ladder
Running the real runtime showed two pinched hands moving apart produce
`pinch → pinch-drag → two-hand-scale`, each hop preempting by strictly higher priority
(10 → 20 → 30). My acceptance test had assumed a single hop (pinch preempted directly
by two-hand-scale). The runtime is right and the assumption was wrong: on each hand in
isolation a pinch and then a drag genuinely occur. Tests were **strengthened**, not
weakened — they now assert every rung of the ladder, that each displaced gesture is
told which gesture superseded it, and that no displaced gesture also reports a clean
`end`. The two-hand fixtures carry honest `pinch` and `pinch-drag` ground-truth labels
for the same reason.

## D19 — Equal priority resolves on confidence before name
SPEC §5 rule 1 orders by priority, then confidence, then name. A test had assumed
scale-vs-rotate was decided by name, but their confidences differ (different threshold
depths), so confidence decides — as specified. Rather than relax the rule, the test now
asserts what is actually guaranteed (exactly one winner, silent loser, identical result
on every run) and a **new** test covers the name rule properly, using two definitions
that differ only in name so their confidences are bit-identical.

## D14 — Repo location: /Users/tarunyadgirkar/Claude/gestalt
cwd already holds the user's projects. Memory notes a ~/TarunsCode convention, but that
tree isn't present here and cwd is where the session launched. Self-contained git repo.
