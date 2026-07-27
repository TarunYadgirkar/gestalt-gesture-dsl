// Shared types. Pure declarations, no logic — this is the contract everything binds to.

// ---- Input: MediaPipe Hands frame schema (SPEC §1) ----

export interface Landmark {
  x: number; // normalized [0,1], image space (y-down)
  y: number;
  z: number; // relative depth hint
}

export type Handedness = 'Left' | 'Right';

export interface HandSample {
  handedness: Handedness;
  score: number; // [0,1]
  landmarks: Landmark[]; // length 21, MediaPipe topology
}

export interface Frame {
  t: number; // ms, monotonic
  hands: HandSample[];
}

// ---- Output: gesture events (SPEC §4) ----

export type HandId = number; // stable runtime identity, assigned by the recognizer
export type GesturePhase = 'start' | 'update' | 'end' | 'cancel';

export interface GestureEvent {
  gesture: string;
  phase: GesturePhase;
  t: number;
  confidence: number; // [0,1]
  hands: HandId[];
  data?: Record<string, number>;
  latencyMs?: number; // set on the 'start' event: t - trueOnset (harness stamps trueOnset)
  reason?: string; // populated on 'cancel' (e.g. 'tracking_lost')
}

// ---- Inspection (SPEC §3) ----

export interface EmitSpec {
  phase: GesturePhase;
  data?: Record<string, string>; // key -> expr source
}

export interface TransitionView {
  to: string;
  guard: string; // human-readable predicate description
  minHoldMs: number;
  reason?: string;
  emit?: EmitSpec;
}

export interface StateView {
  id: string;
  accept: boolean;
  initial: boolean;
  emit?: EmitSpec;
  capture?: Record<string, string>;
  transitions: TransitionView[];
}

export interface MachineDescription {
  name: string;
  hands: 1 | 2;
  priority: number;
  initial: string;
  states: StateView[];
}

// ---- Runtime trace (SPEC §3/§4: "see why a gesture fired") ----

export interface TraceEntry {
  gesture: string;
  t: number;
  from: string;
  to: string;
  firedGuard: string;
  reason?: string;
  emitted?: GesturePhase;
  handIds: HandId[];
}

export interface RecognizerOptions {
  dropoutGraceMs?: number; // default 200
}

// ---- Eval harness (SPEC §7) ----

export interface SessionMeta {
  name: string;
  schema: 'gestalt/v1';
  fps?: number;
  createdBy?: string;
}

export interface GroundTruth {
  gesture: string;
  hands?: HandId[];
  onset: number; // ms
  offset: number; // ms
}

export interface Session {
  meta: SessionMeta;
  frames: Frame[];
  labels: GroundTruth[];
}

export interface GestureMetrics {
  gesture: string;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  fpPerMin: number;
  latencyMs: number | null; // median over TPs; null if no TP
}

export interface EvalTolerances {
  recall: number;
  precision: number;
  fpPerMin: number;
  latencyMs: number;
}

export interface RegressionRow {
  gesture: string;
  metric: keyof GestureMetrics;
  baseline: number;
  current: number;
  delta: number;
  regressed: boolean;
}

export interface RegressionResult {
  pass: boolean;
  rows: RegressionRow[];
  current: GestureMetrics[];
  baseline: GestureMetrics[];
}
