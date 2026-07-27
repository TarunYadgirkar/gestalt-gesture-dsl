import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BASELINE_PATH, evalCorpus } from '../src/eval/fixtures.js';
import {
  scoreSession,
  aggregate,
  compareToBaseline,
  DEFAULT_TOLERANCES,
  renderReport,
  saveSession,
  loadSession,
} from '../src/eval/index.js';
import { loadGestureLibrary } from '../src/index.js';
import { positiveFixtures, negativeFixtures } from '../src/synthetic/sequences.js';
import type { GestureMetrics, Session } from '../src/types.js';

const machines = loadGestureLibrary();

const metricFor = (rows: GestureMetrics[], g: string): GestureMetrics =>
  rows.find((r) => r.gesture === g)!;

describe('record/replay round-trip', () => {
  it('a session survives save -> load unchanged', () => {
    const s = positiveFixtures()[0]!.session;
    expect(loadSession(saveSession(s))).toEqual(s);
  });

  it('rejects a session with the wrong schema tag', () => {
    const bad = JSON.stringify({ meta: { name: 'x', schema: 'nope' }, frames: [], labels: [] });
    expect(() => loadSession(bad)).toThrow(/schema/i);
  });

  it('replaying a loaded session reproduces the original events exactly', () => {
    const s = positiveFixtures().find((f) => f.target === 'pinch-drag')!.session;
    const a = scoreSession(machines, s);
    const b = scoreSession(machines, loadSession(saveSession(s)));
    expect(b.metrics).toEqual(a.metrics);
  });
});

describe('metrics', () => {
  it('scores a clean positive as a true positive with no false positives', () => {
    const f = positiveFixtures().find((x) => x.target === 'pinch')!;
    const m = metricFor(scoreSession(machines, f.session).metrics, 'pinch');
    expect(m.tp).toBe(1);
    expect(m.fp).toBe(0);
    expect(m.fn).toBe(0);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.fpPerMin).toBe(0);
  });

  it('reports latency measured from the labeled onset', () => {
    const f = positiveFixtures().find((x) => x.target === 'pinch')!;
    const m = metricFor(scoreSession(machines, f.session).metrics, 'pinch');
    expect(m.latencyMs).not.toBeNull();
    expect(m.latencyMs!).toBeLessThanOrEqual(f.latencyBudgetMs);
  });

  it('counts an unlabeled detection as a false positive and rates it per minute', () => {
    // Same frames, but the ground truth claims nothing happened.
    const f = positiveFixtures().find((x) => x.target === 'pinch')!;
    const unlabeled: Session = { ...f.session, labels: [] };
    const m = metricFor(scoreSession(machines, unlabeled).metrics, 'pinch');
    expect(m.tp).toBe(0);
    expect(m.fp).toBe(1);
    expect(m.precision).toBe(0);
    expect(m.fpPerMin).toBeGreaterThan(0);
  });

  it('counts a missed label as a false negative', () => {
    const f = negativeFixtures().find((x) => x.session.meta.name === 'pinch-near-miss')!;
    const claimed: Session = {
      ...f.session,
      labels: [{ gesture: 'pinch', onset: 600, offset: 900 }],
    };
    const m = metricFor(scoreSession(machines, claimed).metrics, 'pinch');
    expect(m.fn).toBe(1);
    expect(m.recall).toBe(0);
  });

  it('does not let one prediction satisfy two ground-truth labels', () => {
    const f = positiveFixtures().find((x) => x.target === 'pinch')!;
    const label = f.session.labels[0]!;
    const doubled: Session = {
      ...f.session,
      labels: [label, { ...label }], // two identical labels, one real detection
    };
    const m = metricFor(scoreSession(machines, doubled).metrics, 'pinch');
    expect(m.tp).toBe(1);
    expect(m.fn).toBe(1);
  });

  it('aggregates across sessions by summing counts, not averaging rates', () => {
    const sessions = positiveFixtures().map((f) => f.session);
    const per = sessions.map((s) => scoreSession(machines, s));
    const total = aggregate(per);
    const pinch = metricFor(total, 'pinch');
    const summedTp = per.reduce(
      (n, r) => n + (r.metrics.find((m) => m.gesture === 'pinch')?.tp ?? 0),
      0,
    );
    expect(pinch.tp).toBe(summedTp);
  });

  it('reports the whole shipped gesture set, including gestures that never fired', () => {
    const f = positiveFixtures().find((x) => x.target === 'pinch')!;
    const names = scoreSession(machines, f.session).metrics.map((m) => m.gesture);
    for (const g of machines.map((m) => m.name)) expect(names).toContain(g);
  });
});

describe('regression mode', () => {
  const current: GestureMetrics[] = [
    { gesture: 'pinch', tp: 10, fp: 0, fn: 0, precision: 1, recall: 1, fpPerMin: 0, latencyMs: 50 },
  ];

  it('passes when metrics are unchanged', () => {
    expect(compareToBaseline(current, current, DEFAULT_TOLERANCES).pass).toBe(true);
  });

  it('fails when recall drops beyond tolerance', () => {
    const worse = [{ ...current[0]!, recall: 0.8 }];
    const r = compareToBaseline(worse, current, DEFAULT_TOLERANCES);
    expect(r.pass).toBe(false);
    expect(r.rows.some((x) => x.metric === 'recall' && x.regressed)).toBe(true);
  });

  it('fails when the false-positive rate rises beyond tolerance', () => {
    const worse = [{ ...current[0]!, fpPerMin: 4 }];
    expect(compareToBaseline(worse, current, DEFAULT_TOLERANCES).pass).toBe(false);
  });

  it('fails when latency regresses beyond tolerance', () => {
    const worse = [{ ...current[0]!, latencyMs: 400 }];
    expect(compareToBaseline(worse, current, DEFAULT_TOLERANCES).pass).toBe(false);
  });

  it('passes when metrics improve', () => {
    const better = [{ ...current[0]!, fpPerMin: 0, latencyMs: 10 }];
    expect(compareToBaseline(better, current, DEFAULT_TOLERANCES).pass).toBe(true);
  });

  it('treats a gesture missing from the baseline as new, not as a regression', () => {
    const added = [
      ...current,
      { gesture: 'swipe', tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, fpPerMin: 0, latencyMs: 20 },
    ];
    expect(compareToBaseline(added, current, DEFAULT_TOLERANCES).pass).toBe(true);
  });

  it('fails when a gesture in the baseline disappears entirely', () => {
    const r = compareToBaseline([], current, DEFAULT_TOLERANCES);
    expect(r.pass).toBe(false);
  });

  it('the full fixture set passes against itself', () => {
    const per = positiveFixtures().map((f) => scoreSession(machines, f.session));
    const metrics = aggregate(per);
    expect(compareToBaseline(metrics, metrics, DEFAULT_TOLERANCES).pass).toBe(true);
  });

  it('the committed baseline still passes against the live corpus', () => {
    // Guards the checked-in baseline.json, so a threshold edit that quietly degrades
    // recognition fails here and not weeks later.
    const baseline = (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
      metrics: GestureMetrics[];
    }).metrics;
    const current = aggregate(evalCorpus().map((s) => scoreSession(machines, s)));
    const result = compareToBaseline(current, baseline, DEFAULT_TOLERANCES);
    const detail = result.rows
      .filter((r) => r.regressed)
      .map((r) => `${r.gesture}.${String(r.metric)} ${r.baseline}->${r.current}`)
      .join('; ');
    expect(result.pass, detail).toBe(true);
  });

  it('detects a gesture whose recognition collapses', () => {
    const baseline = aggregate(evalCorpus().map((s) => scoreSession(machines, s)));
    const broken = baseline.map((m) =>
      m.gesture === 'pinch' ? { ...m, recall: 0, tp: 0, fn: m.tp } : m,
    );
    const result = compareToBaseline(broken, baseline, DEFAULT_TOLERANCES);
    expect(result.pass).toBe(false);
    expect(result.rows.some((r) => r.gesture === 'pinch' && r.metric === 'recall' && r.regressed)).toBe(true);
  });
});

describe('HTML report', () => {
  const per = positiveFixtures().slice(0, 2).map((f) => scoreSession(machines, f.session));

  it('renders a self-contained page with no external asset references', () => {
    const html = renderReport({ sessions: per, metrics: aggregate(per) });
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).not.toMatch(/src="http/i);
    expect(html).not.toMatch(/<link[^>]+href="http/i);
  });

  it('shows a timeline lane for ground truth and one for predictions', () => {
    const html = renderReport({ sessions: per, metrics: aggregate(per) });
    expect(html).toMatch(/ground truth/i);
    expect(html).toMatch(/predicted/i);
  });

  it('names every scored session and gesture', () => {
    const html = renderReport({ sessions: per, metrics: aggregate(per) });
    for (const s of per) expect(html).toContain(s.session);
    expect(html).toContain('pinch');
  });

  it('includes the regression verdict when one is supplied', () => {
    const metrics = aggregate(per);
    const regression = compareToBaseline(metrics, metrics, DEFAULT_TOLERANCES);
    const html = renderReport({ sessions: per, metrics, regression });
    expect(html).toMatch(/PASS/);
  });

  it('escapes text that would otherwise break out of the markup', () => {
    const hostile = { ...per[0]!, session: '<script>alert(1)</script>' };
    const html = renderReport({ sessions: [hostile], metrics: aggregate(per) });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
