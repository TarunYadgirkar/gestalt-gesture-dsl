import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CompiledMachine } from './compile.js';

export const GESTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../gestures');

export function loadGestureLibrary(_dir: string = GESTURE_DIR): CompiledMachine[] {
  throw new Error('not implemented: loadGestureLibrary');
}
