import { describe, it, expect } from 'vitest';
import { pose } from '../src/synthetic/poser.js';
import {
  positiveFixtures,
  negativeFixtures,
  dropFrames,
} from '../src/synthetic/sequences.js';
import { dist, resolvePoint, fingerCurl, LM } from '../src/landmarks.js';
import type { Session } from '../src/types.js';

const PINCH_ON = 0.045; // distance below which the marquee pinch is considered closed

function thumbIndex(frame: Session['frames'][number]): number {
  const h = frame.hands[0]!;
  return dist(h.landmarks[LM.THUMB_TIP]!, h.landmarks[LM.INDEX_TIP]!);
}

function assertWellFormed(s: Session) {
  expect(s.frames.length).toBeGreaterThan(0);
  for (let i = 1; i < s.frames.length; i++) {
    expect(s.frames[i]!.t).toBeGreaterThan(s.frames[i - 1]!.t);
  }
  for (const f of s.frames) {
    for (const h of f.hands) {
      expect(h.landmarks).toHaveLength(21);
      for (const lm of h.landmarks) {
        expect(Number.isFinite(lm.x)).toBe(true);
        expect(Number.isFinite(lm.y)).toBe(true);
      }
    }
  }
  const t0 = s.frames[0]!.t;
  const tN = s.frames[s.frames.length - 1]!.t;
  for (const l of s.labels) {
    expect(l.onset).toBeGreaterThanOrEqual(t0);
    expect(l.offset).toBeLessThanOrEqual(tN + 1);
    expect(l.offset).toBeGreaterThanOrEqual(l.onset);
  }
}

describe('poser', () => {
  it('open hand has separated thumb and index and extended fingers', () => {
    const h = pose('open');
    expect(h.landmarks).toHaveLength(21);
    expect(dist(resolvePoint(h, 'thumb_tip'), resolvePoint(h, 'index_tip'))).toBeGreaterThan(0.12);
    expect(fingerCurl(h, 'index')).toBeLessThan(0.3);
    expect(fingerCurl(h, 'middle')).toBeLessThan(0.3);
  });

  it('full pinch brings thumb and index tips together', () => {
    const h = pose('pinch', { pinchAmount: 1 });
    expect(dist(resolvePoint(h, 'thumb_tip'), resolvePoint(h, 'index_tip'))).toBeLessThan(0.03);
  });

  it('partial pinch stays open in proportion to pinchAmount', () => {
    const closed = dist(
      resolvePoint(pose('pinch', { pinchAmount: 1 }), 'thumb_tip'),
      resolvePoint(pose('pinch', { pinchAmount: 1 }), 'index_tip'),
    );
    const half = dist(
      resolvePoint(pose('pinch', { pinchAmount: 0.5 }), 'thumb_tip'),
      resolvePoint(pose('pinch', { pinchAmount: 0.5 }), 'index_tip'),
    );
    expect(half).toBeGreaterThan(closed);
  });

  it('fist curls every finger', () => {
    const h = pose('fist');
    for (const f of ['index', 'middle', 'ring', 'pinky'] as const) {
      expect(fingerCurl(h, f)).toBeGreaterThan(0.4);
    }
  });

  it('scale grows the hand span', () => {
    const small = pose('open', { scale: 0.2 });
    const big = pose('open', { scale: 0.4 });
    const spanS = dist(small.landmarks[LM.WRIST]!, small.landmarks[LM.MIDDLE_TIP]!);
    const spanB = dist(big.landmarks[LM.WRIST]!, big.landmarks[LM.MIDDLE_TIP]!);
    expect(spanB).toBeGreaterThan(spanS * 1.5);
  });
});

describe('fixture catalog', () => {
  const positives = positiveFixtures();
  const negatives = negativeFixtures();

  it('covers all seven shipped gestures as positives', () => {
    const targets = new Set(positives.map((f) => f.target));
    for (const g of [
      'pinch', 'pinch-drag', 'two-hand-scale', 'two-hand-rotate',
      'dwell-select', 'palm-push', 'swipe',
    ]) {
      expect(targets.has(g)).toBe(true);
    }
  });

  it('every positive fixture is well-formed and labeled', () => {
    for (const f of positives) {
      assertWellFormed(f.session);
      expect(f.expectFire).toBe(true);
      expect(f.session.labels.some((l) => l.gesture === f.target)).toBe(true);
      expect(f.latencyBudgetMs).toBeGreaterThan(0);
    }
  });

  it('every negative fixture is well-formed and expects no fire', () => {
    expect(negatives.length).toBeGreaterThan(0);
    for (const f of negatives) {
      assertWellFormed(f.session);
      expect(f.expectFire).toBe(false);
    }
  });

  it('pinch positive actually crosses the close threshold at its labeled onset', () => {
    const f = positives.find((x) => x.target === 'pinch')!;
    const label = f.session.labels.find((l) => l.gesture === 'pinch')!;
    const closedAfter = f.session.frames.some(
      (fr) => fr.t >= label.onset && fr.t <= label.onset + 80 && thumbIndex(fr) < PINCH_ON,
    );
    expect(closedAfter).toBe(true);
    const openBefore = f.session.frames
      .filter((fr) => fr.t < label.onset - 80)
      .every((fr) => thumbIndex(fr) > PINCH_ON);
    expect(openBefore).toBe(true);
  });

  it('near-miss pinch never closes', () => {
    const f = negatives.find((x) => x.target === 'pinch')!;
    const minGap = Math.min(...f.session.frames.map(thumbIndex));
    expect(minGap).toBeGreaterThan(0.05);
  });
});

describe('dropFrames', () => {
  const s = positiveFixtures().find((x) => x.target === 'pinch')!.session;

  it('removes roughly the requested fraction and stays monotonic', () => {
    const dropped = dropFrames(s, 0.1, 12345);
    expect(dropped.frames.length).toBeLessThan(s.frames.length);
    expect(dropped.frames.length).toBeGreaterThan(s.frames.length * 0.8);
    for (let i = 1; i < dropped.frames.length; i++) {
      expect(dropped.frames[i]!.t).toBeGreaterThan(dropped.frames[i - 1]!.t);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = dropFrames(s, 0.1, 999);
    const b = dropFrames(s, 0.1, 999);
    expect(a.frames.map((f) => f.t)).toEqual(b.frames.map((f) => f.t));
  });

  it('preserves labels', () => {
    const dropped = dropFrames(s, 0.1, 7);
    expect(dropped.labels).toEqual(s.labels);
  });
});
