import type { GestureDef, Predicate, EmitDef } from './schema.js';
import type { GesturePhase, MachineDescription, StateView } from '../types.js';
import { compileExpr, type CompiledExpr } from './expr.js';
import { compilePredicate, predicateRefs, type CompiledPredicate } from './predicate.js';
import { isNamedPoint } from '../landmarks.js';

export interface CompiledBinding {
  key: string;
  expr: CompiledExpr;
}

export interface CompiledEmit {
  phase: GesturePhase;
  data: CompiledBinding[];
}

export interface CompiledTransition {
  to: string;
  toIndex: number;
  when: CompiledPredicate;
  whenSrc: Predicate;
  minHoldMs: number;
  emit?: CompiledEmit;
  reason?: string;
}

export interface CompiledState {
  id: string;
  index: number;
  accept: boolean;
  emit?: CompiledEmit;
  capture: CompiledBinding[];
  transitions: CompiledTransition[];
}

export interface CompiledNamed {
  key: string;
  src: Predicate;
  pred: CompiledPredicate;
}

export interface CompiledMachine {
  name: string;
  hands: 1 | 2;
  priority: number;
  description?: string;
  initial: number;
  states: CompiledState[];
  named: CompiledNamed[];
  latchCount: number;
  customPoints: Record<string, number[]>;
  describe(): MachineDescription;
  toDSL(): GestureDef;
}

function compileEmit(e: EmitDef | undefined, where: string): CompiledEmit | undefined {
  if (!e) return undefined;
  const data = Object.entries(e.data ?? {}).map(([key, src]) => {
    try {
      return { key, expr: compileExpr(src) };
    } catch (err) {
      throw new Error(`${where}: emit.data.${key}: ${(err as Error).message}`);
    }
  });
  return { phase: e.phase, data };
}

// Named predicates must evaluate in dependency order so a predicate that references
// another sees this frame's value, not last frame's. Cycles are a hard error.
function orderNamed(defs: Record<string, Predicate>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (key: string, path: string[]): void => {
    const s = state.get(key);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`predicate cycle: ${[...path, key].join(' -> ')}`);
    const def = defs[key];
    if (def === undefined) throw new Error(`unknown predicate reference '${key}'`);
    state.set(key, 'visiting');
    for (const ref of predicateRefs(def)) visit(ref, [...path, key]);
    state.set(key, 'done');
    order.push(key);
  };

  for (const k of Object.keys(defs)) visit(k, []);
  return order;
}

export function compile(def: GestureDef): CompiledMachine {
  const where = `gesture '${def.name}'`;

  const customPoints: Record<string, number[]> = {};
  for (const [alias, idx] of Object.entries(def.points ?? {})) {
    const list = Array.isArray(idx) ? idx : [idx];
    for (const i of list) {
      if (i < 0 || i > 20) throw new Error(`${where}: point '${alias}' index ${i} out of range 0..20`);
    }
    customPoints[alias] = list;
  }

  let latchCount = 0;
  const env = {
    allocSlot: () => latchCount++,
    namedKeys: new Set(Object.keys(def.predicates)),
    compiledNamed: new Map<string, CompiledPredicate>(),
  };

  // Dependency order guarantees a referenced predicate is already in compiledNamed
  // by the time anything describes through to it.
  const named: CompiledNamed[] = orderNamed(def.predicates).map((key) => {
    const src = def.predicates[key]!;
    const pred = compilePredicate(src, env);
    env.compiledNamed.set(key, pred);
    return { key, src, pred };
  });

  const stateIndex = new Map<string, number>();
  def.states.forEach((s, i) => {
    if (stateIndex.has(s.id)) throw new Error(`${where}: duplicate state id '${s.id}'`);
    stateIndex.set(s.id, i);
  });

  const states: CompiledState[] = def.states.map((s, index) => {
    const capture = Object.entries(s.capture ?? {}).map(([key, src]) => {
      try {
        return { key, expr: compileExpr(src) };
      } catch (err) {
        throw new Error(`${where}: state '${s.id}': capture.${key}: ${(err as Error).message}`);
      }
    });

    const transitions: CompiledTransition[] = s.transitions.map((t, ti) => {
      const toIndex = stateIndex.get(t.to);
      if (toIndex === undefined) {
        throw new Error(`${where}: state '${s.id}' transition ${ti} targets unknown state '${t.to}'`);
      }
      let when: CompiledPredicate;
      try {
        when = compilePredicate(t.when, env);
      } catch (err) {
        throw new Error(`${where}: state '${s.id}' transition ${ti}: ${(err as Error).message}`);
      }
      return {
        to: t.to,
        toIndex,
        when,
        whenSrc: t.when,
        minHoldMs: t.min_hold_ms ?? 0,
        emit: compileEmit(t.emit, `${where}: state '${s.id}' transition ${ti}`),
        reason: t.reason,
      };
    });

    return {
      id: s.id,
      index,
      accept: s.accept === true,
      emit: compileEmit(s.emit, `${where}: state '${s.id}'`),
      capture,
      transitions,
    };
  });

  const explicitInitial = def.states.findIndex((s) => s.initial === true);
  const initial = explicitInitial >= 0 ? explicitInitial : 0;

  if (!states.some((s) => s.accept)) {
    throw new Error(`${where}: no accept state — the gesture could never fire`);
  }
  if (states[initial]!.accept) {
    throw new Error(`${where}: initial state '${states[initial]!.id}' cannot also be an accept state`);
  }

  validatePoints(def, states, named, customPoints, where);

  return {
    name: def.name,
    hands: def.hands,
    priority: def.priority,
    description: def.description,
    initial,
    states,
    named,
    latchCount,
    customPoints,

    describe(): MachineDescription {
      const stateViews: StateView[] = states.map((s) => ({
        id: s.id,
        accept: s.accept,
        initial: s.index === initial,
        ...(s.emit ? { emit: emitView(s.emit) } : {}),
        ...(s.capture.length
          ? { capture: Object.fromEntries(s.capture.map((c) => [c.key, c.expr.source])) }
          : {}),
        transitions: s.transitions.map((t) => ({
          to: t.to,
          guard: t.when.describe(),
          minHoldMs: t.minHoldMs,
          ...(t.reason ? { reason: t.reason } : {}),
          ...(t.emit ? { emit: emitView(t.emit) } : {}),
        })),
      }));
      return {
        name: def.name,
        hands: def.hands,
        priority: def.priority,
        initial: states[initial]!.id,
        states: stateViews,
      };
    },

    // Rebuilt from the compiled structures rather than echoing a stashed copy of the
    // input, so a round-trip actually exercises the compiler.
    toDSL(): GestureDef {
      return {
        name: def.name,
        hands: def.hands,
        priority: def.priority,
        ...(def.description ? { description: def.description } : {}),
        ...(def.points ? { points: def.points } : {}),
        predicates: Object.fromEntries(named.map((n) => [n.key, n.src])),
        states: states.map((s) => ({
          id: s.id,
          ...(s.index === initial && initial !== 0 ? { initial: true } : {}),
          ...(s.accept ? { accept: true } : {}),
          ...(s.emit ? { emit: emitView(s.emit) } : {}),
          ...(s.capture.length
            ? { capture: Object.fromEntries(s.capture.map((c) => [c.key, c.expr.source])) }
            : {}),
          transitions: s.transitions.map((t) => ({
            when: t.whenSrc,
            to: t.to,
            ...(t.minHoldMs ? { min_hold_ms: t.minHoldMs } : {}),
            ...(t.emit ? { emit: emitView(t.emit) } : {}),
            ...(t.reason ? { reason: t.reason } : {}),
          })),
        })),
      } as GestureDef;
    },
  };
}

const emitView = (e: CompiledEmit): { phase: GesturePhase; data?: Record<string, string> } =>
  e.data.length
    ? { phase: e.phase, data: Object.fromEntries(e.data.map((d) => [d.key, d.expr.source])) }
    : { phase: e.phase };

function validatePoints(
  def: GestureDef,
  states: CompiledState[],
  named: CompiledNamed[],
  customPoints: Record<string, number[]>,
  where: string,
): void {
  const refs = new Set<string>();
  for (const n of named) for (const p of n.pred.points) refs.add(p);
  for (const s of states) {
    for (const c of s.capture) for (const p of c.expr.points) refs.add(p);
    for (const e of s.emit?.data ?? []) for (const p of e.expr.points) refs.add(p);
    for (const t of s.transitions) {
      for (const p of t.when.points) refs.add(p);
      for (const e of t.emit?.data ?? []) for (const p of e.expr.points) refs.add(p);
    }
  }

  for (const ref of refs) {
    const dot = ref.indexOf('.');
    const [prefix, bare] = dot >= 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : ['h0', ref];
    if (prefix !== 'h0' && prefix !== 'h1') {
      throw new Error(`${where}: point '${ref}' has an unknown hand prefix '${prefix}' (use h0. or h1.)`);
    }
    if (prefix === 'h1' && def.hands !== 2) {
      throw new Error(
        `${where}: point '${ref}' references a second hand but the gesture declares hands: ${def.hands}`,
      );
    }
    if (!isNamedPoint(bare) && !(bare in customPoints)) {
      throw new Error(`${where}: unknown landmark point '${bare}'`);
    }
  }
}
