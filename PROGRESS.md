# PROGRESS

Updated continuously. Assume the reader is catching up cold.

## Done
- Planning docs: SPEC.md, DECISIONS.md, DEPENDENCIES.md.
- Git repo + scaffold. Pushed to https://github.com/TarunYadgirkar/gestalt-gesture-dsl
- **Synthetic generator** — poser (21-landmark MediaPipe poses) + sequence builders:
  7 positive fixtures with exact onset labels, 6 adversarial negatives, seeded dropout.
- **Acceptance suite authored first, watched fail** (27 RED), then driven green.
- **DSL + compiler** — zod-validated YAML grammar, recursive-descent expression
  language, predicate compiler with shared hysteresis latches in dependency order,
  `compile()` producing an inspectable machine with `describe()` / `toDSL()`.
- **Runtime recognizer** — spatial hand identity, per-hand instancing, dropout grace
  with `tracking_lost`, snapshot/rollback competition with priority preemption,
  confidence from threshold depth, transition trace.
- **Eval harness** — session record/replay, precision/recall/FP-per-min/latency,
  baseline regression diffing, self-contained HTML report with SVG timelines, CLI.

**145 tests green. Typecheck clean. Corpus: 34 sessions, 100% precision and recall,
0 FP/min.**

## In progress
- Task #6: browser demo. Scope expanded per user request — not just a webcam canvas
  but a properly designed multi-page site: live gesture events, a visual state-machine
  inspector, and a "what is this" explainer page. Then deploy to Vercel.

## Next
1. Demo: webcam + MediaPipe HandLandmarker, live event feed, state machine inspector.
2. Explainer page (what the system is, how the DSL works, why it fires).
3. Deploy to Vercel.
4. README.md + HANDOFF.md.

## Blocked
- (none)

## Notes
- npm not pnpm (D2). Determinism enforced: no wall-clock/RNG in runtime (D9).
- Regression detector verified non-vacuous: tightening the pinch threshold produces
  `FAIL pinch.recall 1.000 -> 0.000`, exit code 1.
- Two ground-truth labeling bugs and one unrealistic-geometry bug were found *by the
  harness*, which is the harness earning its keep.
