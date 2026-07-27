// Public API surface. Signatures are the contract the acceptance suite binds to.

export * from './types.js';
export { LM, FINGERS, dist, angleDeg, centroid, resolvePoint, fingerCurl } from './landmarks.js';

export { GESTURE_DIR, loadGestureLibrary } from './dsl/library.js';
export { parseGesture, serializeGesture } from './dsl/parse.js';
export { compile } from './dsl/compile.js';
export type { CompiledMachine } from './dsl/compile.js';
export type { GestureDef } from './dsl/schema.js';
export { Recognizer } from './runtime/recognizer.js';
