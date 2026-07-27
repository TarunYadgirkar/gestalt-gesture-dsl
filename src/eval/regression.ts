import type { EvalTolerances, GestureMetrics, RegressionResult, RegressionRow } from '../types.js';

export const DEFAULT_TOLERANCES: EvalTolerances = {
  recall: 0.05,
  precision: 0.05,
  fpPerMin: 0.5,
  latencyMs: 50,
};

// Direction of "worse" per metric: recall/precision falling, fp-rate and latency rising.
const CHECKS = [
  { metric: 'recall' as const, worseWhen: 'lower' as const, tol: (t: EvalTolerances) => t.recall },
  { metric: 'precision' as const, worseWhen: 'lower' as const, tol: (t: EvalTolerances) => t.precision },
  { metric: 'fpPerMin' as const, worseWhen: 'higher' as const, tol: (t: EvalTolerances) => t.fpPerMin },
  { metric: 'latencyMs' as const, worseWhen: 'higher' as const, tol: (t: EvalTolerances) => t.latencyMs },
];

export function compareToBaseline(
  current: GestureMetrics[],
  baseline: GestureMetrics[],
  tolerances: EvalTolerances = DEFAULT_TOLERANCES,
): RegressionResult {
  const currentBy = new Map(current.map((m) => [m.gesture, m]));
  const rows: RegressionRow[] = [];

  for (const base of baseline) {
    const cur = currentBy.get(base.gesture);

    // A gesture that vanished from the run is the loudest possible regression:
    // scoring it as "no change" would let a deleted definition pass silently.
    if (!cur) {
      rows.push({
        gesture: base.gesture, metric: 'recall',
        baseline: base.recall, current: 0, delta: -base.recall, regressed: true,
      });
      continue;
    }

    for (const check of CHECKS) {
      const b = base[check.metric];
      const c = cur[check.metric];
      if (typeof b !== 'number' || typeof c !== 'number') continue; // latency null: nothing to compare
      const delta = c - b;
      const tol = check.tol(tolerances);
      const regressed = check.worseWhen === 'lower' ? delta < -tol : delta > tol;
      rows.push({ gesture: base.gesture, metric: check.metric, baseline: b, current: c, delta, regressed });
    }
  }

  return { pass: !rows.some((r) => r.regressed), rows, current, baseline };
}

export const formatRegression = (r: RegressionResult): string => {
  const lines = [r.pass ? 'PASS — no gesture regressed beyond tolerance' : 'FAIL — regressions detected'];
  for (const row of r.rows.filter((x) => x.regressed)) {
    lines.push(
      `  ${row.gesture}.${row.metric}: ${row.baseline.toFixed(3)} -> ${row.current.toFixed(3)} (${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(3)})`,
    );
  }
  return lines.join('\n');
};
