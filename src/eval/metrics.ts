import type { CompiledMachine } from '../dsl/compile.js';
import type { GestureEvent, GestureMetrics, GroundTruth, Session } from '../types.js';
import { Recognizer } from '../runtime/recognizer.js';

// A prediction matches a ground-truth interval if it lands inside it, with a little
// slack on each side: a recognizer that fires marginally before the labeled onset is
// early, not wrong. Slack is deliberately small — widen it and false positives start
// getting credited as detections.
export const PRE_TOLERANCE_MS = 120;
export const POST_TOLERANCE_MS = 250;

export interface MatchDetail {
  gesture: string;
  kind: 'tp' | 'fp' | 'fn';
  predictedT?: number;
  onset?: number;
  offset?: number;
  latencyMs?: number;
  confidence?: number;
}

export interface SessionScore {
  session: string;
  durationMs: number;
  metrics: GestureMetrics[];
  matches: MatchDetail[];
  events: GestureEvent[];
  labels: GroundTruth[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const ratio = (num: number, den: number): number => (den === 0 ? (num === 0 ? 1 : 0) : num / den);

export function scoreSession(machines: CompiledMachine[], session: Session): SessionScore {
  const rec = new Recognizer(machines);
  const events: GestureEvent[] = [];
  for (const f of session.frames) events.push(...rec.push(f));

  const first = session.frames[0]?.t ?? 0;
  const last = session.frames[session.frames.length - 1]?.t ?? 0;
  const durationMs = Math.max(0, last - first);

  const gestures = [...new Set([...machines.map((m) => m.name), ...session.labels.map((l) => l.gesture)])].sort();

  const metrics: GestureMetrics[] = [];
  const matches: MatchDetail[] = [];

  for (const gesture of gestures) {
    const preds = events
      .filter((e) => e.gesture === gesture && e.phase === 'start')
      .sort((a, b) => a.t - b.t);
    const truths = session.labels.filter((l) => l.gesture === gesture).sort((a, b) => a.onset - b.onset);

    const claimed = new Array<boolean>(truths.length).fill(false);
    const latencies: number[] = [];
    let tp = 0;
    let fp = 0;

    for (const p of preds) {
      // Nearest unclaimed label wins, so one detection can never satisfy two labels.
      let best = -1;
      let bestDist = Infinity;
      truths.forEach((gt, i) => {
        if (claimed[i]) return;
        if (p.t < gt.onset - PRE_TOLERANCE_MS || p.t > gt.offset + POST_TOLERANCE_MS) return;
        const d = Math.abs(p.t - gt.onset);
        if (d < bestDist) { bestDist = d; best = i; }
      });

      if (best >= 0) {
        claimed[best] = true;
        tp++;
        const gt = truths[best]!;
        const latency = p.t - gt.onset;
        latencies.push(latency);
        matches.push({
          gesture, kind: 'tp', predictedT: p.t, onset: gt.onset, offset: gt.offset,
          latencyMs: latency, confidence: p.confidence,
        });
      } else {
        fp++;
        matches.push({ gesture, kind: 'fp', predictedT: p.t, confidence: p.confidence });
      }
    }

    truths.forEach((gt, i) => {
      if (claimed[i]) return;
      matches.push({ gesture, kind: 'fn', onset: gt.onset, offset: gt.offset });
    });
    const fn = claimed.filter((c) => !c).length;

    metrics.push({
      gesture,
      tp, fp, fn,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      fpPerMin: durationMs > 0 ? fp / (durationMs / 60000) : 0,
      latencyMs: median(latencies),
    });
  }

  return { session: session.meta.name, durationMs, metrics, matches, events, labels: session.labels };
}

/**
 * Pools counts across sessions rather than averaging per-session rates — a rate
 * averaged over a one-event session and a hundred-event session would weight them
 * equally and hide the regression that matters.
 */
export function aggregate(scores: SessionScore[]): GestureMetrics[] {
  const totalMs = scores.reduce((n, s) => n + s.durationMs, 0);
  const byGesture = new Map<string, { tp: number; fp: number; fn: number; lat: number[] }>();

  for (const s of scores) {
    for (const m of s.metrics) {
      const acc = byGesture.get(m.gesture) ?? { tp: 0, fp: 0, fn: 0, lat: [] };
      acc.tp += m.tp;
      acc.fp += m.fp;
      acc.fn += m.fn;
      byGesture.set(m.gesture, acc);
    }
    for (const d of s.matches) {
      if (d.kind === 'tp' && d.latencyMs !== undefined) {
        byGesture.get(d.gesture)!.lat.push(d.latencyMs);
      }
    }
  }

  return [...byGesture.entries()]
    .map(([gesture, a]) => ({
      gesture,
      tp: a.tp, fp: a.fp, fn: a.fn,
      precision: ratio(a.tp, a.tp + a.fp),
      recall: ratio(a.tp, a.tp + a.fn),
      fpPerMin: totalMs > 0 ? a.fp / (totalMs / 60000) : 0,
      latencyMs: median(a.lat),
    }))
    .sort((x, y) => (x.gesture < y.gesture ? -1 : x.gesture > y.gesture ? 1 : 0));
}
