import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compile, parseGesture, serializeGesture, GESTURE_DIR } from '../../src/index.js';
import { positiveFixtures } from '../../src/synthetic/sequences.js';
import { replay, signature } from '../helpers.js';

const files = readdirSync(GESTURE_DIR).filter((f) => f.endsWith('.yaml'));

describe('DSL round-trip: definition -> machine -> serialized -> reloaded', () => {
  for (const file of files) {
    const yaml = readFileSync(join(GESTURE_DIR, file), 'utf8');

    it(`${file}: describe() survives a serialize/reload cycle unchanged`, () => {
      const original = compile(parseGesture(yaml));
      const reloaded = compile(parseGesture(serializeGesture(original.toDSL())));
      expect(reloaded.describe()).toEqual(original.describe());
    });

    it(`${file}: a second cycle is a fixed point`, () => {
      const once = serializeGesture(compile(parseGesture(yaml)).toDSL());
      const twice = serializeGesture(compile(parseGesture(once)).toDSL());
      expect(twice).toBe(once);
    });

    it(`${file}: describe() is inspectable — states, guards and thresholds`, () => {
      const d = compile(parseGesture(yaml)).describe();
      expect(d.name).toBeTruthy();
      expect(d.states.length).toBeGreaterThan(1);
      expect(d.states.some((s) => s.id === d.initial)).toBe(true);
      expect(d.states.some((s) => s.accept)).toBe(true);
      for (const st of d.states) {
        for (const tr of st.transitions) {
          expect(d.states.some((s) => s.id === tr.to), `dangling target ${tr.to}`).toBe(true);
          expect(tr.guard.length).toBeGreaterThan(0);
        }
      }
      // Guards must render their numbers, otherwise "why did it fire" is unanswerable.
      const guards = d.states.flatMap((s) => s.transitions.map((t) => t.guard)).join(' ');
      expect(guards).toMatch(/[0-9]/);
    });
  }
});

describe('DSL round-trip: behavior is identical, not just structure', () => {
  it('reloaded machines produce byte-identical events on every fixture', () => {
    const original = files.map((f) => compile(parseGesture(readFileSync(join(GESTURE_DIR, f), 'utf8'))));
    const reloaded = original.map((m) => compile(parseGesture(serializeGesture(m.toDSL()))));

    for (const fixture of positiveFixtures()) {
      expect(signature(replay(reloaded, fixture.session)), fixture.session.meta.name).toBe(
        signature(replay(original, fixture.session)),
      );
    }
  });
});

describe('DSL validation rejects bad definitions with a useful message', () => {
  const base = `
name: broken
hands: 1
predicates:
  p: { distance: { a: thumb_tip, b: index_tip, lt: 0.05 } }
states:
  - id: idle
    transitions: [{ when: p, to: closed }]
  - id: closed
    accept: true
    transitions: []
`;

  it('accepts the baseline it is derived from', () => {
    expect(() => compile(parseGesture(base))).not.toThrow();
  });

  it('rejects a transition targeting a state that does not exist', () => {
    const bad = base.replace('to: closed }]', 'to: nowhere }]');
    expect(() => compile(parseGesture(bad))).toThrow(/nowhere/);
  });

  it('rejects a reference to an undefined predicate', () => {
    const bad = base.replace('when: p,', 'when: undefined_predicate,');
    expect(() => compile(parseGesture(bad))).toThrow(/undefined_predicate/);
  });

  it('rejects an unknown landmark point name', () => {
    const bad = base.replace('a: thumb_tip', 'a: elbow');
    expect(() => compile(parseGesture(bad))).toThrow(/elbow/);
  });

  it('rejects a non-numeric threshold', () => {
    const bad = base.replace('lt: 0.05', 'lt: "quite close"');
    expect(() => parseGesture(bad)).toThrow();
  });

  it('rejects a definition with no accept state', () => {
    const bad = base.replace('accept: true', 'accept: false');
    expect(() => compile(parseGesture(bad))).toThrow(/accept/i);
  });
});
