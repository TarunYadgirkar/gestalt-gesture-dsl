// Browser-safe entry point: everything except the filesystem-backed library loader.
// The core has no DOM and no MediaPipe dependency — it only consumes the frame schema —
// so the same compiled machines run in Node tests and in the demo.

export * from './types.js';
export { LM, FINGERS, dist, angleDeg, centroid, resolvePoint, fingerCurl } from './landmarks.js';
export { parseGesture, serializeGesture } from './dsl/parse.js';
export { compile } from './dsl/compile.js';
export type { CompiledMachine, CompiledState, CompiledTransition } from './dsl/compile.js';
export type { GestureDef } from './dsl/schema.js';
export { Recognizer } from './runtime/recognizer.js';
export { saveSession, loadSession, SessionRecorder } from './eval/session.js';
export { scoreSession, aggregate } from './eval/metrics.js';
export { renderReport } from './eval/report.js';

import { compile } from './dsl/compile.js';
import { parseGesture } from './dsl/parse.js';
import type { CompiledMachine } from './dsl/compile.js';

/** Compiles gesture definitions supplied as raw YAML text (Vite `?raw` imports). */
export function compileGestures(sources: string[]): CompiledMachine[] {
  return sources.map((src) => compile(parseGesture(src)));
}
