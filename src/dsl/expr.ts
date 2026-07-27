// Mini expression language (SPEC §2.4). Recursive-descent parser producing a closure
// over an EvalContext. Deliberately tiny: arithmetic plus a fixed function table.
// Compiled once at compile() time so the runtime hot path does no parsing.

import type { HandSample, Landmark } from '../types.js';

export interface EvalContext {
  // Role-bound hands. h0 is always present when a machine is evaluated; h1 only for
  // two-hand gestures. `null` means the hand is currently untracked (dropout).
  hands: (HandSample | null)[];
  prevHands: (HandSample | null)[];
  dtSec: number; // seconds since the previous frame (0 on the first frame)
  captures: Record<string, number>;
  /** Named predicate results for this frame, evaluated once in dependency order. */
  namedValues: Record<string, boolean>;
  namedMargins: Record<string, number>;
  point(ref: string, which: 'cur' | 'prev'): Landmark | null;
  curl(ref: string): number;
}

export type ExprFn = (ctx: EvalContext) => number;

export interface CompiledExpr {
  source: string;
  fn: ExprFn;
  /** Point references used, so the compiler can validate them up front. */
  points: string[];
}

type Token = { kind: 'num'; v: number } | { kind: 'ident'; v: string } | { kind: 'op'; v: string };

const OPS = new Set(['+', '-', '*', '/', '(', ')', ',']);

// Functions whose arguments are landmark/finger names rather than sub-expressions.
const POINT_FNS = new Set(['x', 'y', 'z', 'dx', 'dy', 'dz', 'distance', 'speed', 'curl']);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (OPS.has(c)) { out.push({ kind: 'op', v: c }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`bad number '${raw}' in expression: ${src}`);
      out.push({ kind: 'num', v });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      out.push({ kind: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character '${c}' in expression: ${src}`);
  }
  return out;
}

const NULLARY: Record<string, ExprFn> = {
  span: (ctx) => {
    const a = ctx.point('h0.palm_center', 'cur');
    const b = ctx.point('h1.palm_center', 'cur');
    if (!a || !b) return NaN;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  },
  pair_angle: (ctx) => {
    const a = ctx.point('h0.palm_center', 'cur');
    const b = ctx.point('h1.palm_center', 'cur');
    if (!a || !b) return NaN;
    return (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI; // y-up degrees
  },
};

// Wraps a signed angle difference into (-180, 180]. Without this, a rotation across
// the ±180 seam reads as a ~350 degree jump and fires everything at once.
export function adiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

class Parser {
  private pos = 0;
  readonly points: string[] = [];

  constructor(private readonly src: string, private readonly toks: Token[]) {}

  private peek(): Token | undefined { return this.toks[this.pos]; }

  private eat(v: string): void {
    const t = this.peek();
    if (!t || t.kind !== 'op' || t.v !== v) {
      throw new Error(`expected '${v}' in expression: ${this.src}`);
    }
    this.pos++;
  }

  parse(): ExprFn {
    const fn = this.additive();
    if (this.pos !== this.toks.length) {
      throw new Error(`trailing tokens in expression: ${this.src}`);
    }
    return fn;
  }

  private additive(): ExprFn {
    let left = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || (t.v !== '+' && t.v !== '-')) return left;
      this.pos++;
      const right = this.multiplicative();
      const l = left;
      left = t.v === '+' ? (c) => l(c) + right(c) : (c) => l(c) - right(c);
    }
  }

  private multiplicative(): ExprFn {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || (t.v !== '*' && t.v !== '/')) return left;
      this.pos++;
      const right = this.unary();
      const l = left;
      left = t.v === '*' ? (c) => l(c) * right(c) : (c) => l(c) / right(c);
    }
  }

  private unary(): ExprFn {
    const t = this.peek();
    if (t && t.kind === 'op' && t.v === '-') {
      this.pos++;
      const inner = this.unary();
      return (c) => -inner(c);
    }
    return this.primary();
  }

  private primary(): ExprFn {
    const t = this.peek();
    if (!t) throw new Error(`unexpected end of expression: ${this.src}`);

    if (t.kind === 'num') { this.pos++; const v = t.v; return () => v; }

    if (t.kind === 'op' && t.v === '(') {
      this.pos++;
      const inner = this.additive();
      this.eat(')');
      return inner;
    }

    if (t.kind !== 'ident') throw new Error(`unexpected token in expression: ${this.src}`);
    this.pos++;
    const name = t.v;

    const next = this.peek();
    const isCall = next && next.kind === 'op' && next.v === '(';
    if (!isCall) {
      if (name.startsWith('capture.')) {
        const key = name.slice('capture.'.length);
        return (c) => {
          const v = c.captures[key];
          return v === undefined ? NaN : v;
        };
      }
      const nullary = NULLARY[name];
      if (nullary) return nullary;
      throw new Error(`unknown term '${name}' in expression: ${this.src}`);
    }

    this.eat('(');

    // Functions that take landmark names take them as bare identifiers, not as
    // sub-expressions — `distance(thumb_tip,index_tip)` names two points, it does not
    // evaluate two terms. Everything else takes ordinary expressions.
    const takesPoints = POINT_FNS.has(name);
    const args: ExprFn[] = [];
    const names: string[] = [];

    const atClose = (): boolean => {
      const p = this.peek();
      return !!p && p.kind === 'op' && p.v === ')';
    };

    if (!atClose()) {
      for (;;) {
        if (takesPoints) {
          const t2 = this.peek();
          if (!t2 || t2.kind !== 'ident') {
            throw new Error(`${name}() expects a point name: ${this.src}`);
          }
          this.pos++;
          names.push(t2.v);
        } else {
          args.push(this.additive());
        }
        const p = this.peek();
        if (p && p.kind === 'op' && p.v === ',') { this.pos++; continue; }
        break;
      }
    }
    this.eat(')');

    return this.buildCall(name, args, names);
  }

  private buildCall(name: string, args: ExprFn[], names: string[]): ExprFn {
    const arity = (n: number): void => {
      const got = POINT_FNS.has(name) ? names.length : args.length;
      if (got !== n) throw new Error(`${name}() takes ${n} argument(s): ${this.src}`);
    };
    const pointArg = (i: number): string => {
      const p = names[i];
      if (!p) throw new Error(`${name}() expects a point name: ${this.src}`);
      this.points.push(p);
      return p;
    };

    switch (name) {
      case 'abs': arity(1); { const a = args[0]!; return (c) => Math.abs(a(c)); }
      case 'adiff': arity(2); { const a = args[0]!, b = args[1]!; return (c) => adiff(a(c), b(c)); }
      case 'min': arity(2); { const a = args[0]!, b = args[1]!; return (c) => Math.min(a(c), b(c)); }
      case 'max': arity(2); { const a = args[0]!, b = args[1]!; return (c) => Math.max(a(c), b(c)); }

      case 'x': case 'y': case 'z': {
        arity(1);
        const p = pointArg(0);
        const axis = name as 'x' | 'y' | 'z';
        return (c) => { const lm = c.point(p, 'cur'); return lm ? lm[axis] : NaN; };
      }
      case 'dx': case 'dy': case 'dz': {
        arity(1);
        const p = pointArg(0);
        const axis = name.slice(1) as 'x' | 'y' | 'z';
        return (c) => {
          const cur = c.point(p, 'cur');
          const prev = c.point(p, 'prev');
          if (!cur || !prev) return 0;
          return cur[axis] - prev[axis];
        };
      }
      case 'distance': {
        arity(2);
        const a = pointArg(0), b = pointArg(1);
        return (c) => {
          const pa = c.point(a, 'cur'), pb = c.point(b, 'cur');
          if (!pa || !pb) return NaN;
          return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
        };
      }
      case 'speed': {
        arity(1);
        const p = pointArg(0);
        return (c) => {
          const cur = c.point(p, 'cur'), prev = c.point(p, 'prev');
          if (!cur || !prev || c.dtSec <= 0) return 0;
          return Math.hypot(cur.x - prev.x, cur.y - prev.y) / c.dtSec;
        };
      }
      case 'curl': {
        arity(1);
        const f = pointArg(0);
        this.points.pop(); // a finger name, not a landmark point
        return (c) => c.curl(f);
      }
      default:
        throw new Error(`unknown function '${name}()' in expression: ${this.src}`);
    }
  }
}

export function compileExpr(source: string): CompiledExpr {
  const parser = new Parser(source, tokenize(source));
  const fn = parser.parse();
  return { source, fn, points: [...new Set(parser.points)] };
}
