import { describe, it, expect } from 'vitest';
import { loadGestureLibrary } from '../../src/index.js';
import { positiveFixtures } from '../../src/synthetic/sequences.js';
import { pose } from '../../src/synthetic/poser.js';
import { replay, signature } from '../helpers.js';
import type { Frame, Session } from '../../src/types.js';

const machines = loadGestureLibrary();

describe('competition: preemption by strictly higher priority (SPEC §5 rule 2)', () => {
  it('pinch-drag preempts the in-flight pinch on the same hand', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch-drag')!;
    const events = replay(machines, fixture.session);

    const pinchStart = events.find((e) => e.gesture === 'pinch' && e.phase === 'start');
    const dragStart = events.find((e) => e.gesture === 'pinch-drag' && e.phase === 'start');
    const pinchCancel = events.find((e) => e.gesture === 'pinch' && e.phase === 'cancel');

    expect(pinchStart, 'pinch should fire first — the fingers really did close').toBeDefined();
    expect(dragStart, 'pinch-drag should fire once the hand moves').toBeDefined();
    expect(dragStart!.t).toBeGreaterThan(pinchStart!.t);

    expect(pinchCancel, 'the superseded pinch must be cancelled, not left hanging').toBeDefined();
    expect(pinchCancel!.reason).toBe('preempted_by:pinch-drag');
    expect(pinchCancel!.t).toBe(dragStart!.t);

    // The loser must not also report a clean end — a consumer would double-handle it.
    expect(events.filter((e) => e.gesture === 'pinch' && e.phase === 'end')).toHaveLength(0);
  });

  it('two-hand-scale preempts both single-hand pinches at once', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'two-hand-scale')!;
    const events = replay(machines, fixture.session);

    const pinchStarts = events.filter((e) => e.gesture === 'pinch' && e.phase === 'start');
    expect(pinchStarts, 'one pinch instance per tracked hand').toHaveLength(2);
    expect(pinchStarts[0]!.hands[0]).not.toBe(pinchStarts[1]!.hands[0]);

    const scaleStart = events.find((e) => e.gesture === 'two-hand-scale' && e.phase === 'start')!;
    const cancels = events.filter((e) => e.gesture === 'pinch' && e.phase === 'cancel');
    expect(cancels).toHaveLength(2);
    for (const c of cancels) {
      expect(c.reason).toBe('preempted_by:two-hand-scale');
      expect(c.t).toBe(scaleStart.t);
    }
  });

  it('a lower-priority newcomer never displaces an active gesture', () => {
    // swipe (5) must not interrupt an active pinch-drag (20) even while moving fast.
    const frames: Frame[] = [];
    for (let i = 0; i < 60; i++) {
      const amt = i < 5 ? 0 : 1;
      const x = 0.2 + (i < 10 ? 0 : 0.03 * (i - 10)); // 1.8 units/s once moving
      frames.push({ t: i * 16, hands: [pose('pinch', { pinchAmount: amt, center: { x, y: 0.5 } })] });
    }
    const s: Session = { meta: { name: 'fast-drag', schema: 'gestalt/v1' }, frames, labels: [] };
    const events = replay(machines, s);

    expect(events.some((e) => e.gesture === 'pinch-drag' && e.phase === 'start')).toBe(true);
    // The hand is pinched, so swipe's own guard rejects it; and even if it matched,
    // priority 5 could not take the hand from priority 20.
    expect(events.filter((e) => e.gesture === 'swipe' && e.phase === 'start')).toHaveLength(0);
  });
});

describe('competition: fresh vs fresh (SPEC §5 rule 1)', () => {
  // Hands pinch, then simultaneously separate AND rotate: two-hand-scale and
  // two-hand-rotate both cross their trigger on the same frame with equal priority
  // (30) and equal confidence. Documented tiebreak is the lexicographically smaller
  // name, so 'two-hand-rotate' wins and 'two-hand-scale' emits nothing.
  function scaleAndRotate(): Session {
    const frames: Frame[] = [];
    for (let i = 0; i < 60; i++) {
      const p = i < 10 ? 0 : Math.min(1, (i - 10) / 20);
      const r = 0.15 + 0.12 * p;
      const deg = 40 * p;
      const th = (deg * Math.PI) / 180;
      frames.push({
        t: i * 16,
        hands: [
          pose('pinch', {
            pinchAmount: 1,
            handedness: 'Left',
            center: { x: 0.5 + r * Math.cos(th + Math.PI), y: 0.5 - r * Math.sin(th + Math.PI) },
          }),
          pose('pinch', {
            pinchAmount: 1,
            handedness: 'Right',
            center: { x: 0.5 + r * Math.cos(th), y: 0.5 - r * Math.sin(th) },
          }),
        ],
      });
    }
    return { meta: { name: 'scale-and-rotate', schema: 'gestalt/v1' }, frames, labels: [] };
  }

  it('resolves to exactly one winner — never both', () => {
    const events = replay(machines, scaleAndRotate());
    const scale = events.filter((e) => e.gesture === 'two-hand-scale' && e.phase === 'start');
    const rotate = events.filter((e) => e.gesture === 'two-hand-rotate' && e.phase === 'start');
    expect(scale.length + rotate.length).toBe(1);
  });

  it('breaks the tie by name, deterministically and repeatably', () => {
    const s = scaleAndRotate();
    const first = replay(machines, s);
    for (let i = 0; i < 5; i++) expect(signature(replay(machines, s))).toBe(signature(first));

    const winner = first.find(
      (e) => e.phase === 'start' && e.gesture.startsWith('two-hand-'),
    )!.gesture;
    expect(winner).toBe('two-hand-rotate');
  });

  it('the loser emits nothing at all, not even a cancel', () => {
    const events = replay(machines, scaleAndRotate());
    expect(events.filter((e) => e.gesture === 'two-hand-scale')).toHaveLength(0);
  });
});

describe('competition: determinism across the whole fixture set', () => {
  it('identical input always produces byte-identical events', () => {
    for (const fixture of positiveFixtures()) {
      const a = signature(replay(machines, fixture.session));
      const b = signature(replay(machines, fixture.session));
      expect(a, fixture.session.meta.name).toBe(b);
    }
  });

  it('machine order in the library does not change the outcome', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch-drag')!;
    const forward = replay(machines, fixture.session);
    const reversed = replay([...machines].reverse(), fixture.session);
    const key = (es: typeof forward) =>
      es.map((e) => `${e.t}:${e.gesture}:${e.phase}`).sort().join('|');
    expect(key(reversed)).toBe(key(forward));
  });
});
