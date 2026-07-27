import type { CompiledMachine, CompiledTransition } from '../dsl/compile.js';
import type { EvalContext } from '../dsl/expr.js';
import type { GestureEvent, GesturePhase, HandId, HandSample, TraceEntry } from '../types.js';
import { DERIVED_POINTS, NAMED_POINT_INDEX, centroid, fingerCurl, type FingerName } from '../landmarks.js';
import type { Landmark } from '../types.js';

export interface StepResult {
  events: GestureEvent[];
  trace: TraceEntry[];
  /** Set when this step proposed a 'start' — the competition resolver arbitrates. */
  proposedStart?: GestureEvent;
}

interface Snapshot {
  stateIndex: number;
  latches: boolean[];
  captures: Record<string, number>;
  holdSince: (number | null)[];
  active: boolean;
  onsetT: number | null;
}

/**
 * One running copy of a compiled machine, bound to specific hands. A `hands: 1`
 * definition has one instance per tracked hand; a `hands: 2` definition has one
 * instance bound to both (SPEC §4.2).
 */
export class MachineInstance {
  stateIndex: number;
  latches: boolean[];
  captures: Record<string, number> = {};
  /** Per-transition dwell timers, keyed `${stateIndex}:${transitionIndex}`. */
  private holdSince: (number | null)[];
  active = false;
  onsetT: number | null = null;
  missingSinceT: number | null = null;

  private prevHands: (HandSample | null)[] = [];
  private prevT: number | null = null;

  constructor(
    readonly machine: CompiledMachine,
    public handIds: HandId[],
  ) {
    this.stateIndex = machine.initial;
    this.latches = new Array<boolean>(machine.latchCount).fill(false);
    this.holdSince = new Array<number | null>(this.timerCount()).fill(null);
  }

  private timerCount(): number {
    return this.machine.states.reduce((n, s) => n + s.transitions.length, 0);
  }

  private timerIndex(stateIndex: number, ti: number): number {
    let base = 0;
    for (let i = 0; i < stateIndex; i++) base += this.machine.states[i]!.transitions.length;
    return base + ti;
  }

  get isIdle(): boolean {
    return this.stateIndex === this.machine.initial && !this.active;
  }

  snapshot(): Snapshot {
    return {
      stateIndex: this.stateIndex,
      latches: [...this.latches],
      captures: { ...this.captures },
      holdSince: [...this.holdSince],
      active: this.active,
      onsetT: this.onsetT,
    };
  }

  restore(s: Snapshot): void {
    this.stateIndex = s.stateIndex;
    this.latches = [...s.latches];
    this.captures = { ...s.captures };
    this.holdSince = [...s.holdSince];
    this.active = s.active;
    this.onsetT = s.onsetT;
  }

  reset(): void {
    this.stateIndex = this.machine.initial;
    this.latches.fill(false);
    this.captures = {};
    this.holdSince.fill(null);
    this.active = false;
    this.onsetT = null;
    this.missingSinceT = null;
  }

  /** Called when a frame arrives but a bound hand is absent — keeps deltas honest. */
  markGap(): void {
    this.prevHands = [];
    this.prevT = null;
  }

  step(t: number, hands: (HandSample | null)[]): StepResult {
    const dtSec = this.prevT === null ? 0 : Math.max(0, (t - this.prevT) / 1000);
    const ctx = this.buildContext(hands, dtSec);

    // Named predicates tick once per frame in dependency order, before any guard, so
    // every shared hysteresis latch advances exactly once (see predicate.ts).
    for (const n of this.machine.named) {
      ctx.namedValues[n.key] = n.pred.eval(ctx, this.latches);
      ctx.namedMargins[n.key] = n.pred.margin(ctx);
    }

    const state = this.machine.states[this.stateIndex]!;

    // Every transition is evaluated, not just up to the first match: a guard that is
    // skipped would leave its hysteresis latch and dwell timer stale, so a later frame
    // would read a value from whenever it was last visited.
    const satisfied: boolean[] = state.transitions.map((tr) => tr.when.eval(ctx, this.latches));

    let fired: { tr: CompiledTransition; ti: number } | null = null;
    for (let ti = 0; ti < state.transitions.length; ti++) {
      const tr = state.transitions[ti]!;
      const timer = this.timerIndex(this.stateIndex, ti);
      if (!satisfied[ti]) {
        this.holdSince[timer] = null;
        continue;
      }
      if (this.holdSince[timer] === null) this.holdSince[timer] = t;
      if (tr.minHoldMs > 0 && t - this.holdSince[timer]! < tr.minHoldMs) continue;
      if (!fired) fired = { tr, ti };
    }

    this.prevHands = hands;
    this.prevT = t;

    if (!fired) return { events: [], trace: [] };
    return this.applyTransition(fired.tr, state.id, t, ctx, hands);
  }

  private applyTransition(
    tr: CompiledTransition,
    fromId: string,
    t: number,
    ctx: EvalContext,
    hands: (HandSample | null)[],
  ): StepResult {
    const events: GestureEvent[] = [];
    const isSelf = tr.toIndex === this.stateIndex;
    const confidence = this.confidence(hands, tr.when.margin(ctx));

    if (this.stateIndex === this.machine.initial && this.onsetT === null) this.onsetT = t;

    // The transition's own emit is evaluated before entering the target, so it reads
    // the captures that were in force while the guard was true.
    if (tr.emit) events.push(this.makeEvent(tr.emit.phase, t, confidence, ctx, tr.emit.data));

    this.stateIndex = tr.toIndex;
    const target = this.machine.states[tr.toIndex]!;

    // A self-transition must not re-run capture, or every update tick would re-anchor
    // the gesture and dx/scale would collapse to zero (SPEC §4.4).
    if (!isSelf) {
      for (const c of target.capture) this.captures[c.key] = c.expr.fn(ctx);
      if (target.emit) events.push(this.makeEvent(target.emit.phase, t, confidence, ctx, target.emit.data));
    }

    const start = events.find((e) => e.phase === 'start');
    if (start) this.active = true;
    if (events.some((e) => e.phase === 'end' || e.phase === 'cancel')) {
      this.active = false;
      this.onsetT = null;
    }

    const trace: TraceEntry[] = [{
      gesture: this.machine.name,
      t,
      from: fromId,
      to: target.id,
      firedGuard: tr.when.describe(),
      ...(tr.reason ? { reason: tr.reason } : {}),
      ...(events.length ? { emitted: events[0]!.phase } : {}),
      handIds: [...this.handIds],
    }];

    return { events, trace, ...(start ? { proposedStart: start } : {}) };
  }

  private makeEvent(
    phase: GesturePhase,
    t: number,
    confidence: number,
    ctx: EvalContext,
    data: { key: string; expr: { fn: (c: EvalContext) => number } }[],
  ): GestureEvent {
    const out: GestureEvent = {
      gesture: this.machine.name,
      phase,
      t,
      confidence,
      hands: [...this.handIds],
    };
    if (data.length) {
      const bag: Record<string, number> = {};
      for (const d of data) bag[d.key] = d.expr.fn(ctx);
      out.data = bag;
    }
    // Time the machine spent forming this gesture. Latency against ground truth is a
    // harness concern; this is what the runtime can honestly report on its own.
    if (phase === 'start' && this.onsetT !== null) out.latencyMs = t - this.onsetT;
    return out;
  }

  /** mean(tracking score) scaled by how deep inside its threshold the guard sat. */
  private confidence(hands: (HandSample | null)[], margin: number): number {
    const present = hands.filter((h): h is HandSample => h !== null);
    const meanScore = present.length
      ? present.reduce((s, h) => s + h.score, 0) / present.length
      : 0;
    return Math.min(1, Math.max(0, meanScore * Math.min(1, Math.max(0, margin))));
  }

  makeCancel(t: number, reason: string): GestureEvent {
    return {
      gesture: this.machine.name,
      phase: 'cancel',
      t,
      confidence: 0,
      hands: [...this.handIds],
      reason,
    };
  }

  private buildContext(hands: (HandSample | null)[], dtSec: number): EvalContext {
    const prev = this.prevHands;
    const custom = this.machine.customPoints;

    const resolve = (hand: HandSample | null, bare: string): Landmark | null => {
      if (!hand) return null;
      const own = custom[bare];
      if (own) return centroid(own.map((i) => hand.landmarks[i]!));
      const derived = DERIVED_POINTS[bare];
      if (derived) return centroid(derived.map((i) => hand.landmarks[i]!));
      const idx = NAMED_POINT_INDEX[bare];
      if (idx === undefined) return null;
      return hand.landmarks[idx] ?? null;
    };

    const split = (ref: string): [number, string] => {
      const dot = ref.indexOf('.');
      if (dot < 0) return [0, ref];
      return [ref.slice(0, dot) === 'h1' ? 1 : 0, ref.slice(dot + 1)];
    };

    return {
      hands,
      prevHands: prev,
      dtSec,
      captures: this.captures,
      namedValues: {},
      namedMargins: {},
      point(ref, which) {
        const [slot, bare] = split(ref);
        const src = which === 'cur' ? hands : prev;
        return resolve(src[slot] ?? null, bare);
      },
      curl(ref) {
        const [slot, bare] = split(ref);
        const hand = hands[slot];
        if (!hand) return NaN;
        return fingerCurl(hand, bare as FingerName);
      },
    };
  }
}
