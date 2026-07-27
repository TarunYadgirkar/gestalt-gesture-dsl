# PROGRESS

Updated continuously. Assume the reader is catching up cold.

## Done
- Planning docs: SPEC.md, DECISIONS.md, DEPENDENCIES.md.
- Git repo + scaffold (package.json, tsconfig, vitest, deps installed).
- Type contract: src/types.ts, src/landmarks.ts (geometry + named points).
- **Task #1 DONE**: synthetic generator (poser + sequences) with 7 positive
  fixtures (exact onset labels) + 6 adversarial negatives + seeded dropout.
  Sanity test green: 13/13 (test/synthetic.test.ts).

## In progress
- Task #2: authoring acceptance suite. DSL grammar locked (see gestures/*.yaml
  design in this file's Notes). Next: write 7 gesture YAMLs + public API stubs +
  acceptance tests (detection/negatives/dropout/competing/roundtrip), watch RED.

## Next (ordered per autonomy contract)
1. Scaffold + install deps.
2. Public API type surface (src/index.ts + types) — signatures only, throwing.
3. Synthetic data generator (needed to author tests).
4. Acceptance test suite (MUST fail): detection, negatives, dropout, competing, round-trip.
5. Implement: landmarks/geometry → DSL parse/validate → compile → machine step →
   runtime (identity, dropout, resolver) → until acceptance green.
6. Eval harness: session format → metrics → regression → HTML report.
7. Browser demo (Vite + MediaPipe).
8. README.md + HANDOFF.md.

## Blocked
- (none)

## Notes
- npm not pnpm (D2). Determinism enforced: no wall-clock/RNG in runtime (D9).
