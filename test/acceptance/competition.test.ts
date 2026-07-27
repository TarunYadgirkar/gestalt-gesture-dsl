import { describe, it, expect } from 'vitest';
import { loadGestureLibrary, compile, parseGesture } from '../../src/index.js';
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

  it('escalates one rung at a time: pinch -> pinch-drag -> two-hand-scale', () => {
    // Two pinched hands moving apart satisfy all three gestures in turn. Each rung is
    // taken by strictly higher priority (10 -> 20 -> 30), and each displaced gesture is
    // told it was superseded, so a consumer can undo exactly what it applied.
    const fixture = positiveFixtures().find((f) => f.target === 'two-hand-scale')!;
    const events = replay(machines, fixture.session);

    const pinchStarts = events.filter((e) => e.gesture === 'pinch' && e.phase === 'start');
    expect(pinchStarts, 'one pinch instance per tracked hand').toHaveLength(2);
    expect(pinchStarts[0]!.hands[0]).not.toBe(pinchStarts[1]!.hands[0]);

    const pinchCancels = events.filter((e) => e.gesture === 'pinch' && e.phase === 'cancel');
    expect(pinchCancels).toHaveLength(2);
    for (const c of pinchCancels) expect(c.reason).toBe('preempted_by:pinch-drag');

    const dragStarts = events.filter((e) => e.gesture === 'pinch-drag' && e.phase === 'start');
    expect(dragStarts, 'one drag per hand once both translate').toHaveLength(2);

    const scaleStart = events.find((e) => e.gesture === 'two-hand-scale' && e.phase === 'start')!;
    expect(scaleStart).toBeDefined();

    const dragCancels = events.filter((e) => e.gesture === 'pinch-drag' && e.phase === 'cancel');
    expect(dragCancels, 'both drags yield to the two-hand gesture').toHaveLength(2);
    for (const c of dragCancels) {
      expect(c.reason).toBe('preempted_by:two-hand-scale');
      expect(c.t).toBe(scaleStart.t);
    }

    // Strictly increasing priority up the ladder, and nothing displaced silently.
    const order = ['pinch', 'pinch-drag', 'two-hand-scale'];
    const firstStartT = order.map((g) => events.find((e) => e.gesture === g && e.phase === 'start')!.t);
    expect(firstStartT[0]!).toBeLessThan(firstStartT[1]!);
    expect(firstStartT[1]!).toBeLessThan(firstStartT[2]!);
    expect(events.filter((e) => e.phase === 'end' && e.gesture !== 'two-hand-scale')).toHaveLength(0);
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
  // Hands pinch, then simultaneously separate AND rotate. two-hand-scale and
  // two-hand-rotate hold equal priority (30), so the documented order falls through to
  // confidence: whichever sits deeper inside its threshold takes the hands, and the
  // other emits nothing at all.
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

  it('picks the same winner on every run', () => {
    const s = scaleAndRotate();
    const first = replay(machines, s);
    for (let i = 0; i < 5; i++) expect(signature(replay(machines, s))).toBe(signature(first));
  });

  it('the loser emits nothing at all, not even a cancel', () => {
    const events = replay(machines, scaleAndRotate());
    const winner = events.find((e) => e.phase === 'start' && e.gesture.startsWith('two-hand-'))!.gesture;
    const loser = winner === 'two-hand-scale' ? 'two-hand-rotate' : 'two-hand-scale';
    expect(events.filter((e) => e.gesture === loser)).toHaveLength(0);
  });

  it('resolves on confidence when priorities are equal', () => {
    const events = replay(machines, scaleAndRotate());
    const winner = events.find((e) => e.phase === 'start' && e.gesture.startsWith('two-hand-'))!;
    // The winner must be genuinely inside its threshold, not an arbitrary pick.
    expect(winner.confidence).toBeGreaterThan(0.5);
  });

  it('falls through to the smaller name when priority and confidence are identical', () => {
    // Two definitions that differ only in name: same priority, same guard, so their
    // confidences are bit-identical and only rule (c) can separate them.
    const twin = (name: string): string => `
name: ${name}
hands: 1
priority: 50
predicates:
  pinched: { distance: { a: thumb_tip, b: index_tip, lt: 0.05, exit: 0.075 } }
states:
  - id: idle
    transitions:
      - when: pinched
        to: held
        emit: { phase: start }
  - id: held
    accept: true
    transitions:
      - when: { not: pinched }
        to: idle
        emit: { phase: end }
`;
    const twins = [compile(parseGesture(twin('zzz-twin'))), compile(parseGesture(twin('aaa-twin')))];

    const frames: Frame[] = Array.from({ length: 20 }, (_, i) => ({
      t: i * 16,
      hands: [pose('pinch', { pinchAmount: i < 5 ? 0 : 1, center: { x: 0.5, y: 0.5 } })],
    }));
    const events = replay(twins, {
      meta: { name: 'twins', schema: 'gestalt/v1' },
      frames,
      labels: [],
    });

    const starts = events.filter((e) => e.phase === 'start');
    expect(starts, 'exactly one twin may claim the hand').toHaveLength(1);
    expect(starts[0]!.gesture).toBe('aaa-twin');
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
