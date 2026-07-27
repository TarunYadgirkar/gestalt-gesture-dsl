import { describe, it, expect } from 'vitest';
import { loadGestureLibrary } from '../../src/index.js';
import { negativeFixtures, positiveFixtures } from '../../src/synthetic/sequences.js';
import { replay, startsOf } from '../helpers.js';

const machines = loadGestureLibrary();

describe('adversarial negatives: near-miss motions must not fire', () => {
  for (const fixture of negativeFixtures()) {
    it(`${fixture.session.meta.name} does not fire ${fixture.target}`, () => {
      const events = replay(machines, fixture.session);
      const fired = startsOf(events, fixture.target);
      const detail = fired.map((e) => `${e.gesture}@${e.t}ms conf=${e.confidence.toFixed(2)}`);
      expect(fired.length, `false positives: ${detail.join(', ')}`).toBe(0);
    });
  }

  it('a hand that only ever half-pinches fires nothing at all', () => {
    const fixture = negativeFixtures().find((f) => f.session.meta.name === 'pinch-near-miss')!;
    const events = replay(machines, fixture.session).filter((e) => e.phase === 'start');
    expect(events.map((e) => e.gesture)).toEqual([]);
  });

  it('a fist moving at push speed does not register as palm-push', () => {
    const fixture = negativeFixtures().find((f) => f.session.meta.name === 'fist-punch')!;
    const events = replay(machines, fixture.session);
    expect(startsOf(events, 'palm-push')).toHaveLength(0);
  });

  it('a slow lateral move does not register as a swipe', () => {
    const fixture = negativeFixtures().find((f) => f.session.meta.name === 'swipe-too-slow')!;
    const events = replay(machines, fixture.session);
    expect(startsOf(events, 'swipe')).toHaveLength(0);
  });
});

describe('cross-gesture false positives', () => {
  // A gesture may only fire in a session where it is actually labeled. This is the
  // real FP guard: it catches a machine that latches onto a different gesture's motion.
  for (const fixture of positiveFixtures()) {
    it(`${fixture.session.meta.name} fires only labeled gestures`, () => {
      const labeled = new Set(fixture.session.labels.map((l) => l.gesture));
      const events = replay(machines, fixture.session).filter((e) => e.phase === 'start');
      const unexpected = [...new Set(events.map((e) => e.gesture))].filter((g) => !labeled.has(g));
      expect(unexpected, `unlabeled gestures fired: ${unexpected.join(', ')}`).toEqual([]);
    });
  }
});

describe('an empty stream fires nothing', () => {
  it('emits no events when no hands are ever tracked', () => {
    const frames = Array.from({ length: 60 }, (_, i) => ({ t: i * 16, hands: [] }));
    const events = replay(machines, {
      meta: { name: 'empty', schema: 'gestalt/v1' },
      frames,
      labels: [],
    });
    expect(events).toEqual([]);
  });
});
