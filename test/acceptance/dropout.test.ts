import { describe, it, expect } from 'vitest';
import { loadGestureLibrary } from '../../src/index.js';
import { dropFrames, positiveFixtures } from '../../src/synthetic/sequences.js';
import { replay, firstStart, signature } from '../helpers.js';
import type { Frame, Session } from '../../src/types.js';

const machines = loadGestureLibrary();
const SEEDS = [1, 7, 42, 1337, 90210];

describe('dropout: 10% of frames removed at random', () => {
  for (const fixture of positiveFixtures()) {
    const label = fixture.session.labels.find((l) => l.gesture === fixture.target)!;

    it(`${fixture.target} still detected across ${SEEDS.length} random droppings`, () => {
      for (const seed of SEEDS) {
        const degraded = dropFrames(fixture.session, 0.1, seed);
        const events = replay(machines, degraded);
        const start = firstStart(events, fixture.target);
        expect(start, `seed ${seed}: lost '${fixture.target}'`).toBeDefined();
        // A dropped frame can push detection one frame later; allow a modest margin
        // over the clean budget rather than an unbounded one.
        expect(start!.t - label.onset).toBeLessThanOrEqual(fixture.latencyBudgetMs + 60);
      }
    });

    it(`${fixture.target} does not produce a cancel storm under dropout`, () => {
      for (const seed of SEEDS) {
        const degraded = dropFrames(fixture.session, 0.1, seed);
        const cancels = replay(machines, degraded).filter(
          (e) => e.gesture === fixture.target && e.phase === 'cancel',
        );
        // Short gaps sit inside the grace window, so tracking_lost must not trigger.
        const lost = cancels.filter((c) => c.reason === 'tracking_lost');
        expect(lost, `seed ${seed}: spurious tracking_lost`).toHaveLength(0);
      }
    });
  }

  it('is deterministic: the same degraded stream yields identical events', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch-drag')!;
    const degraded = dropFrames(fixture.session, 0.1, 4242);
    expect(signature(replay(machines, degraded))).toBe(signature(replay(machines, degraded)));
  });
});

describe('tracking loss beyond the grace window', () => {
  // Blank out the hand for 500ms mid-pinch — well past the 200ms default grace.
  function blackout(s: Session, fromT: number, toT: number): Session {
    const frames: Frame[] = s.frames.map((f) =>
      f.t >= fromT && f.t <= toT ? { t: f.t, hands: [] } : f,
    );
    return { meta: s.meta, frames, labels: s.labels };
  }

  it('cancels with tracking_lost instead of faking a clean end', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch')!;
    const label = fixture.session.labels.find((l) => l.gesture === 'pinch')!;
    const gapped = blackout(fixture.session, label.onset + 100, label.onset + 600);

    const events = replay(machines, gapped).filter((e) => e.gesture === 'pinch');
    const start = events.find((e) => e.phase === 'start');
    expect(start).toBeDefined();

    const after = events.filter((e) => e.t > start!.t);
    const cancel = after.find((e) => e.phase === 'cancel');
    expect(cancel, 'expected a cancel when tracking is lost').toBeDefined();
    expect(cancel!.reason).toBe('tracking_lost');
    // The gesture never legitimately ended, so no 'end' may precede the cancel.
    const endBeforeCancel = after.find((e) => e.phase === 'end' && e.t <= cancel!.t);
    expect(endBeforeCancel).toBeUndefined();
  });

  it('holds state through a gap shorter than the grace window', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch')!;
    const label = fixture.session.labels.find((l) => l.gesture === 'pinch')!;
    const gapped = blackout(fixture.session, label.onset + 100, label.onset + 200);

    const events = replay(machines, gapped, { dropoutGraceMs: 200 });
    const pinches = events.filter((e) => e.gesture === 'pinch');
    expect(pinches.filter((e) => e.phase === 'cancel')).toHaveLength(0);
    // Survives as one continuous gesture rather than restarting.
    expect(pinches.filter((e) => e.phase === 'start')).toHaveLength(1);
  });

  it('emits exactly one cancel, not one per missing frame', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch')!;
    const label = fixture.session.labels.find((l) => l.gesture === 'pinch')!;
    const gapped = blackout(fixture.session, label.onset + 100, label.onset + 900);
    const cancels = replay(machines, gapped).filter(
      (e) => e.gesture === 'pinch' && e.phase === 'cancel',
    );
    expect(cancels).toHaveLength(1);
  });
});

describe('hands leaving and re-entering frame', () => {
  it('re-arms cleanly after the hand returns', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch')!;
    const src = fixture.session;
    // Two separate pinches separated by a long empty stretch.
    const gap: Frame[] = Array.from({ length: 30 }, (_, i) => ({
      t: src.frames[src.frames.length - 1]!.t + (i + 1) * 16,
      hands: [],
    }));
    const tail = src.frames.map((f) => ({
      t: f.t + gap[gap.length - 1]!.t + 16,
      hands: f.hands,
    }));
    const doubled: Session = {
      meta: src.meta,
      frames: [...src.frames, ...gap, ...tail],
      labels: [],
    };
    const starts = replay(machines, doubled).filter(
      (e) => e.gesture === 'pinch' && e.phase === 'start',
    );
    expect(starts).toHaveLength(2);
  });
});

describe('left/right handedness flips', () => {
  it('a single-frame label swap does not cancel or duplicate a gesture', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'two-hand-scale')!;
    const mid = Math.floor(fixture.session.frames.length / 2);
    const frames: Frame[] = fixture.session.frames.map((f, i) => {
      if (i !== mid || f.hands.length !== 2) return f;
      // MediaPipe mislabels which hand is which for one frame. Spatial identity
      // must carry through, so the gesture is unaffected.
      const [a, b] = f.hands;
      return {
        t: f.t,
        hands: [
          { ...a!, handedness: b!.handedness },
          { ...b!, handedness: a!.handedness },
        ],
      };
    });
    const flipped: Session = { meta: fixture.session.meta, frames, labels: fixture.session.labels };

    const clean = replay(machines, fixture.session).filter((e) => e.gesture === 'two-hand-scale');
    const swapped = replay(machines, flipped).filter((e) => e.gesture === 'two-hand-scale');

    expect(swapped.filter((e) => e.phase === 'start')).toHaveLength(1);
    expect(swapped.filter((e) => e.phase === 'cancel')).toHaveLength(0);
    expect(swapped.length).toBe(clean.length);
  });
});
