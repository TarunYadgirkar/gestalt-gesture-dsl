import type { CompiledMachine } from '../dsl/compile.js';
import type { Frame, GestureEvent, RecognizerOptions, TraceEntry } from '../types.js';

export class Recognizer {
  constructor(_machines: CompiledMachine[], _opts: RecognizerOptions = {}) {}

  push(_frame: Frame): GestureEvent[] {
    throw new Error('not implemented: Recognizer.push');
  }

  trace(_gesture?: string): TraceEntry[] {
    throw new Error('not implemented: Recognizer.trace');
  }
}
