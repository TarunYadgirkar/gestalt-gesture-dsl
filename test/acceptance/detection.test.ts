import { describe, it, expect } from 'vitest';
import { loadGestureLibrary, Recognizer } from '../../src/index.js';
import { positiveFixtures } from '../../src/synthetic/sequences.js';
import { replay, firstStart } from '../helpers.js';

// Firing meaningfully BEFORE the true onset means the machine latched onto something
// other than the gesture. Allow two frames of slack for frame-boundary rounding.
const EARLY_TOLERANCE_MS = 34;

const machines = loadGestureLibrary();

describe('detection: every shipped gesture fires within its latency budget', () => {
  for (const fixture of positiveFixtures()) {
    const label = fixture.session.labels.find((l) => l.gesture === fixture.target)!;

    it(`${fixture.target} fires within ${fixture.latencyBudgetMs}ms of true onset`, () => {
      const events = replay(machines, fixture.session);
      const start = firstStart(events, fixture.target);

      expect(start, `no '${fixture.target}' start event emitted`).toBeDefined();
      const latency = start!.t - label.onset;
      expect(latency).toBeLessThanOrEqual(fixture.latencyBudgetMs);
      expect(latency).toBeGreaterThanOrEqual(-EARLY_TOLERANCE_MS);
    });

    it(`${fixture.target} reports a usable confidence`, () => {
      const events = replay(machines, fixture.session);
      const start = firstStart(events, fixture.target)!;
      expect(start.confidence).toBeGreaterThan(0);
      expect(start.confidence).toBeLessThanOrEqual(1);
    });

    it(`${fixture.target} names the hands it consumed`, () => {
      const events = replay(machines, fixture.session);
      const start = firstStart(events, fixture.target)!;
      const expectedHands = fixture.target.startsWith('two-hand') ? 2 : 1;
      expect(start.hands).toHaveLength(expectedHands);
    });

    it(`${fixture.target} does not fire repeatedly for one occurrence`, () => {
      const events = replay(machines, fixture.session);
      const starts = events.filter((e) => e.gesture === fixture.target && e.phase === 'start');
      expect(starts.length).toBe(1);
    });
  }
});

describe('detection: continuous gestures stream update data', () => {
  it('pinch-drag reports a growing dx while dragging', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch-drag')!;
    const events = replay(machines, fixture.session);
    const updates = events.filter((e) => e.gesture === 'pinch-drag' && e.phase === 'update');
    expect(updates.length).toBeGreaterThan(3);
    const dxs = updates.map((e) => e.data!.dx!);
    expect(dxs[dxs.length - 1]!).toBeGreaterThan(dxs[0]!);
  });

  it('two-hand-scale reports a scale factor above 1 when hands separate', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'two-hand-scale')!;
    const events = replay(machines, fixture.session);
    const last = events.filter((e) => e.gesture === 'two-hand-scale' && e.phase !== 'end').pop()!;
    expect(last.data!.scale!).toBeGreaterThan(1.1);
  });

  it('two-hand-rotate reports degrees approaching the applied rotation', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'two-hand-rotate')!;
    const events = replay(machines, fixture.session);
    const last = events.filter((e) => e.gesture === 'two-hand-rotate' && e.phase !== 'end').pop()!;
    expect(Math.abs(last.data!.degrees!)).toBeGreaterThan(30);
    expect(Math.abs(last.data!.degrees!)).toBeLessThan(60);
  });
});

describe('detection: live inspection while running', () => {
  it('reports the current state of every live machine instance', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch')!;
    const rec = new Recognizer(machines);
    const label = fixture.session.labels[0]!;

    let duringPinch: ReturnType<Recognizer['inspect']> = [];
    for (const f of fixture.session.frames) {
      rec.push(f);
      if (f.t === label.onset + 100) duringPinch = rec.inspect();
    }

    const pinch = duringPinch.find((i) => i.gesture === 'pinch')!;
    expect(pinch.state).toBe('closed');
    expect(pinch.active).toBe(true);
    expect(pinch.hands).toHaveLength(1);
  });

  it('exposes each candidate transition of the current state with its live verdict', () => {
    // This is the inspector's whole purpose: not just "which state", but which guard
    // is currently true and what it would take to move.
    const fixture = positiveFixtures().find((f) => f.target === 'pinch')!;
    const rec = new Recognizer(machines);
    const label = fixture.session.labels[0]!;

    let idle: ReturnType<Recognizer['inspect']> = [];
    let held: ReturnType<Recognizer['inspect']> = [];
    for (const f of fixture.session.frames) {
      rec.push(f);
      if (f.t === label.onset - 200) idle = rec.inspect();
      if (f.t === label.onset + 100) held = rec.inspect();
    }

    const before = idle.find((i) => i.gesture === 'pinch')!;
    expect(before.state).toBe('idle');
    const openGuard = before.guards.find((g) => g.to === 'closed')!;
    expect(openGuard.passed, 'hand is still open, so the pinch guard must read false').toBe(false);
    expect(openGuard.guard).toContain('distance');
    expect(openGuard.guard).toMatch(/0\.05/); // the threshold is visible, not hidden

    const after = held.find((i) => i.gesture === 'pinch')!;
    expect(after.state).toBe('closed');
    const releaseGuard = after.guards.find((g) => g.to === 'idle')!;
    expect(releaseGuard.passed, 'still pinched, so the release guard must read false').toBe(false);
    expect(releaseGuard.reason).toMatch(/separated/i);
  });
});

describe('detection: the machine can explain why it fired', () => {
  it('exposes a trace naming the transition that produced the event', () => {
    const fixture = positiveFixtures().find((f) => f.target === 'pinch')!;
    const rec = new Recognizer(machines);
    for (const f of fixture.session.frames) rec.push(f);
    const firing = rec.trace('pinch').find((e) => e.emitted === 'start');
    expect(firing).toBeDefined();
    expect(firing!.from).toBe('idle');
    expect(firing!.to).toBe('closed');
    expect(firing!.reason).toMatch(/closed/i);
    expect(firing!.firedGuard).toContain('distance');
  });
});
