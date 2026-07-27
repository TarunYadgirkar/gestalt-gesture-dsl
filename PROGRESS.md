# PROGRESS

Updated continuously. Assume the reader is catching up cold.

## Done
- Planning docs: SPEC.md, DECISIONS.md, DEPENDENCIES.md.
- Git repo initialized at /Users/tarunyadgirkar/Claude/gestalt.

## In progress
- Project scaffold (package.json, tsconfig, vitest).

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
