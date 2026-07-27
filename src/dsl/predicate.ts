import type { Predicate } from './schema.js';
import { compileExpr, type CompiledExpr, type EvalContext } from './expr.js';

// A compiled predicate is a pure function of (frame context, latch array). Hysteresis
// state lives in the latch array, which belongs to the *machine instance*, not to the
// compiled machine — so one compiled definition can drive many hands concurrently.
//
// Named predicates are compiled once and evaluated once per frame, in dependency
// order, before any guard runs. Two consequences that matter:
//   1. Every named predicate keeps a single shared hysteresis latch, so referencing
//      `pinched` from three different states cannot produce three disagreeing latches.
//   2. Latches stay current even while their state is not active, so a guard entered
//      mid-stream sees a correctly-latched value rather than a stale one.

export interface CompiledPredicate {
  eval(ctx: EvalContext, latches: boolean[]): boolean;
  /** 0.5 at the threshold, →1 deep inside it. Feeds event confidence. */
  margin(ctx: EvalContext): number;
  describe(): string;
  /** Point references this predicate reads, for up-front validation. */
  points: string[];
}

interface Bound {
  op: 'lt' | 'lte' | 'gt' | 'gte';
  value: number;
  exit?: number;
}

function boundOf(spec: Record<string, unknown>, where: string): Bound {
  const found: Bound[] = [];
  for (const op of ['lt', 'lte', 'gt', 'gte'] as const) {
    const v = spec[op];
    if (typeof v === 'number') found.push({ op, value: v, exit: spec.exit as number | undefined });
  }
  if (found.length === 0) throw new Error(`${where}: needs one of lt/lte/gt/gte`);
  if (found.length > 1) {
    throw new Error(`${where}: multiple comparisons (${found.map((f) => f.op).join(', ')})`);
  }
  return found[0]!;
}

const satisfies = (v: number, op: Bound['op'], t: number): boolean => {
  if (!Number.isFinite(v)) return false; // untracked hand or undefined capture
  switch (op) {
    case 'lt': return v < t;
    case 'lte': return v <= t;
    case 'gt': return v > t;
    case 'gte': return v >= t;
  }
};

function marginFor(v: number, op: Bound['op'], t: number): number {
  if (!Number.isFinite(v)) return 0;
  const scale = Math.max(Math.abs(t), 1e-6);
  const inside = op === 'lt' || op === 'lte' ? (t - v) / scale : (v - t) / scale;
  return Math.min(1, Math.max(0, 0.5 + 0.5 * inside));
}

// Leaf: a value expression compared against a threshold, with optional hysteresis.
// While FALSE the primary threshold must be crossed to latch on; while TRUE the
// looser `exit` threshold governs release (SPEC §2.3).
function leaf(expr: CompiledExpr, bound: Bound, label: string, slot: number): CompiledPredicate {
  const { op, value, exit } = bound;
  const describe = exit === undefined
    ? `${label} ${op} ${value}`
    : `${label} ${op} ${value} (release ${exit})`;

  return {
    points: expr.points,
    describe: () => describe,
    margin: (ctx) => marginFor(expr.fn(ctx), op, value),
    eval(ctx, latches) {
      const v = expr.fn(ctx);
      const threshold = exit !== undefined && latches[slot] === true ? exit : value;
      const next = satisfies(v, op, threshold);
      latches[slot] = next;
      return next;
    },
  };
}

const pointRef = (name: string): string => (name.includes('.') ? name : `h0.${name}`);

export interface PredicateEnv {
  /** Allocates a hysteresis latch slot on the owning machine. */
  allocSlot(): number;
  /** Names that resolve through the per-frame cache rather than being inlined. */
  namedKeys: Set<string>;
  /** Already-compiled named predicates, for describing a reference in full. */
  compiledNamed: Map<string, CompiledPredicate>;
}

export function compilePredicate(p: Predicate, env: PredicateEnv): CompiledPredicate {
  if (typeof p === 'string') {
    if (!env.namedKeys.has(p)) throw new Error(`unknown predicate reference '${p}'`);
    return {
      points: [],
      // Render the underlying condition, not just the alias: an inspector that says
      // "fired because `pinched`" cannot answer "pinched by how much?".
      describe: () => {
        const inner = env.compiledNamed.get(p);
        return inner ? `${p}[${inner.describe()}]` : p;
      },
      margin: (ctx) => ctx.namedMargins[p] ?? 0,
      eval: (ctx) => ctx.namedValues[p] === true,
    };
  }

  if ('all' in p || 'any' in p) {
    const isAll = 'all' in p;
    const kids = (isAll ? p.all : p.any).map((c) => compilePredicate(c, env));
    const joiner = isAll ? ' AND ' : ' OR ';
    return {
      points: kids.flatMap((k) => k.points),
      describe: () => `(${kids.map((k) => k.describe()).join(joiner)})`,
      margin: (ctx) => {
        const ms = kids.map((k) => k.margin(ctx));
        return isAll ? Math.min(...ms) : Math.max(...ms);
      },
      eval(ctx, latches) {
        // No short-circuiting: every leaf must tick so its latch stays current.
        // Short-circuiting would freeze a hysteresis latch at a stale value.
        const results = kids.map((k) => k.eval(ctx, latches));
        return isAll ? results.every(Boolean) : results.some(Boolean);
      },
    };
  }

  if ('not' in p) {
    const inner = compilePredicate(p.not, env);
    return {
      points: inner.points,
      describe: () => `NOT ${inner.describe()}`,
      margin: (ctx) => Math.min(1, Math.max(0, 1 - inner.margin(ctx))),
      eval: (ctx, latches) => !inner.eval(ctx, latches),
    };
  }

  if ('distance' in p) {
    const { a, b } = p.distance;
    const label = `distance(${a},${b})`;
    return leaf(
      compileExpr(`distance(${pointRef(a)},${pointRef(b)})`),
      boundOf(p.distance, label),
      label,
      env.allocSlot(),
    );
  }

  if ('angle' in p) {
    const { at, from, to } = p.angle;
    const label = `angle(${at},${from},${to})`;
    const expr = compileAngleExpr(pointRef(at), pointRef(from), pointRef(to));
    return leaf(expr, boundOf(p.angle, label), label, env.allocSlot());
  }

  if ('curl' in p) {
    const label = `curl(${p.curl.finger})`;
    return leaf(compileExpr(label), boundOf(p.curl, label), label, env.allocSlot());
  }

  if ('speed' in p) {
    const { point, axis } = p.speed;
    const ref = pointRef(point);
    const signed = axis && axis !== 'planar';
    const expr = signed ? compileAxisSpeed(ref, axis) : compileExpr(`speed(${ref})`);
    const label = `speed(${point}${signed ? `.${axis}` : ''})`;
    return leaf(expr, boundOf(p.speed, label), label, env.allocSlot());
  }

  if ('expr' in p) {
    return leaf(
      compileExpr(p.expr.value),
      boundOf(p.expr, p.expr.value),
      p.expr.value,
      env.allocSlot(),
    );
  }

  if ('tracked' in p) {
    const which = p.tracked.hand;
    const idx = which === 'h1' ? 1 : 0;
    return {
      points: [],
      describe: () => `tracked(${which})`,
      margin: () => 1,
      eval: (ctx) => (which === 'any' ? ctx.hands.some(Boolean) : ctx.hands[idx] != null),
    };
  }

  throw new Error(`unrecognized predicate: ${JSON.stringify(p)}`);
}

/** Direct references a predicate makes to other named predicates (for ordering). */
export function predicateRefs(p: Predicate, out: Set<string> = new Set()): Set<string> {
  if (typeof p === 'string') { out.add(p); return out; }
  if ('all' in p) for (const c of p.all) predicateRefs(c, out);
  else if ('any' in p) for (const c of p.any) predicateRefs(c, out);
  else if ('not' in p) predicateRefs(p.not, out);
  return out;
}

// Signed per-axis speed: (cur - prev) / dt. Built directly rather than through the
// expression grammar so `dt` need not become a user-visible term.
function compileAxisSpeed(ref: string, axis: 'x' | 'y' | 'z'): CompiledExpr {
  const delta = compileExpr(`d${axis}(${ref})`);
  return {
    source: `speed_${axis}(${ref})`,
    points: delta.points,
    fn: (ctx) => (ctx.dtSec > 0 ? delta.fn(ctx) / ctx.dtSec : 0),
  };
}

// Law of cosines over the three pairwise distances, so there is one expression
// evaluator rather than a second geometry path.
function compileAngleExpr(at: string, from: string, to: string): CompiledExpr {
  const a = compileExpr(`distance(${at},${from})`);
  const b = compileExpr(`distance(${at},${to})`);
  const c = compileExpr(`distance(${from},${to})`);
  return {
    source: `angle(${at},${from},${to})`,
    points: [...new Set([...a.points, ...b.points, ...c.points])],
    fn: (ctx) => {
      const A = a.fn(ctx), B = b.fn(ctx), C = c.fn(ctx);
      if (!Number.isFinite(A) || !Number.isFinite(B) || A === 0 || B === 0) return NaN;
      const cos = Math.min(1, Math.max(-1, (A * A + B * B - C * C) / (2 * A * B)));
      return (Math.acos(cos) * 180) / Math.PI;
    },
  };
}
