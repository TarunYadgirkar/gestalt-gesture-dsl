# PROGRESS

## Status: complete

All six planned phases done, in the order the autonomy contract required.

- **Repo:** https://github.com/TarunYadgirkar/gestalt-gesture-dsl
- **Live demo:** https://gestalt-pearl.vercel.app
- **147 tests green · typecheck clean · corpus 100% precision/recall, 0 FP/min**

## Done

1. **Planning** — SPEC.md (numbered, referenced from code), DECISIONS.md (19 entries),
   DEPENDENCIES.md.
2. **Synthetic generator** — poser + sequence builders. 7 positives with exact onset
   frames, 6 adversarial negatives, seeded deterministic dropout.
3. **Acceptance suite authored first and watched fail** (27 RED), then driven green.
4. **DSL + compiler** — zod schema, expression language, predicate compiler with shared
   hysteresis latches in dependency order, inspectable machine with describe()/toDSL().
5. **Runtime** — spatial hand identity, per-hand instancing, dropout grace,
   snapshot/rollback competition with priority preemption, confidence, trace, inspect.
6. **Eval harness** — record/replay, metrics, regression vs committed baseline, HTML
   report with SVG timelines, CLI.
7. **Demo** — instrument panel with looping replay (no permissions) and live webcam,
   state machine inspector with live guard readouts, explainer page. Deployed.
8. **Docs** — README.md, HANDOFF.md.

## Blocked

None. No BLOCKED.md was needed — nothing had to be stubbed behind a placeholder
interface.

## Things the harness caught (it earned its keep)

- Two mislabeled ground-truth intervals: two-hand fixtures labeled per-hand drag onset
  at t=0 instead of at first motion, and `drag-too-slow` left its genuine pinch
  unlabeled.
- Unrealistic synthetic geometry: full pinches closed to a mathematically exact zero
  gap, which made every distance threshold below open-hand spacing score identically.
  Fixtures that cannot fail cannot tune anything.

## Tests corrected (strengthened, never weakened)

- **D18** — the runtime escalates `pinch → pinch-drag → two-hand-scale` one rung at a
  time; my test had assumed a single hop. The test now asserts every rung.
- **D19** — equal priority resolves on confidence before name, as specified. The test
  had assumed equal confidence. It now asserts what is actually guaranteed, and a new
  test covers the name tiebreak using definitions that differ only in name.

## Next steps

See HANDOFF.md for the three highest-value ones: record real webcam sessions and
re-tune, add a threshold sweep to the harness, and resolve the confidence model.
