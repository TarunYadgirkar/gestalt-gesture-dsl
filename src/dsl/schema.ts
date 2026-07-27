import { z } from 'zod';

// The DSL grammar (SPEC §2), as a runtime-checked schema. Parsing a gesture file
// produces a GestureDef and nothing else; every later stage can trust these types.

const cmp = {
  lt: z.number().optional(),
  lte: z.number().optional(),
  gt: z.number().optional(),
  gte: z.number().optional(),
  exit: z.number().optional(), // hysteresis release threshold (SPEC §2.3)
};

// Expression sources are strings, but YAML turns an unquoted `1` into a number.
const ExprSource = z.union([z.string(), z.number().transform(String)]);

const FingerSchema = z.enum(['thumb', 'index', 'middle', 'ring', 'pinky']);
const AxisSchema = z.enum(['x', 'y', 'z', 'planar']);

const DistanceLeaf = z.object({
  distance: z.object({ a: z.string(), b: z.string(), ...cmp }).strict(),
}).strict();

const AngleLeaf = z.object({
  angle: z.object({ at: z.string(), from: z.string(), to: z.string(), ...cmp }).strict(),
}).strict();

const CurlLeaf = z.object({
  curl: z.object({ finger: FingerSchema, ...cmp }).strict(),
}).strict();

const SpeedLeaf = z.object({
  speed: z.object({ point: z.string(), axis: AxisSchema.optional(), ...cmp }).strict(),
}).strict();

const ExprLeaf = z.object({
  expr: z.object({ value: z.string(), ...cmp }).strict(),
}).strict();

const TrackedLeaf = z.object({
  tracked: z.object({ hand: z.enum(['any', 'h0', 'h1']) }).strict(),
}).strict();

export type Predicate =
  | string
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | z.infer<typeof DistanceLeaf>
  | z.infer<typeof AngleLeaf>
  | z.infer<typeof CurlLeaf>
  | z.infer<typeof SpeedLeaf>
  | z.infer<typeof ExprLeaf>
  | z.infer<typeof TrackedLeaf>;

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.string(), // reference to a named predicate
    z.object({ all: z.array(PredicateSchema).min(1) }).strict(),
    z.object({ any: z.array(PredicateSchema).min(1) }).strict(),
    z.object({ not: PredicateSchema }).strict(),
    DistanceLeaf,
    AngleLeaf,
    CurlLeaf,
    SpeedLeaf,
    ExprLeaf,
    TrackedLeaf,
  ]),
);

export const EmitSchema = z.object({
  phase: z.enum(['start', 'update', 'end', 'cancel']),
  // key -> expression source. A bare number is a valid expression, so YAML's
  // `dir: 1` is accepted and normalized to its source text.
  data: z.record(z.string(), ExprSource).optional(),
}).strict();

export const TransitionSchema = z.object({
  when: PredicateSchema,
  to: z.string(),
  min_hold_ms: z.number().nonnegative().optional(),
  emit: EmitSchema.optional(),
  reason: z.string().optional(),
}).strict();

export const StateSchema = z.object({
  id: z.string(),
  initial: z.boolean().optional(),
  accept: z.boolean().optional(),
  emit: EmitSchema.optional(),
  capture: z.record(z.string(), ExprSource).optional(),
  transitions: z.array(TransitionSchema).default([]),
}).strict();

export const GestureSchema = z.object({
  name: z.string().min(1),
  hands: z.union([z.literal(1), z.literal(2)]),
  priority: z.number().default(0),
  description: z.string().optional(),
  points: z.record(z.string(), z.union([z.number().int(), z.array(z.number().int())])).optional(),
  predicates: z.record(z.string(), PredicateSchema).default({}),
  states: z.array(StateSchema).min(1),
}).strict();

export type GestureDef = z.infer<typeof GestureSchema>;
export type StateDef = z.infer<typeof StateSchema>;
export type TransitionDef = z.infer<typeof TransitionSchema>;
export type EmitDef = z.infer<typeof EmitSchema>;
