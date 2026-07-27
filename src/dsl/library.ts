import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { compile, type CompiledMachine } from './compile.js';
import { parseGesture } from './parse.js';

export const GESTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../gestures');

/** Loads and compiles every .yaml in a directory. Sorted by filename for determinism. */
export function loadGestureLibrary(dir: string = GESTURE_DIR): CompiledMachine[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  const machines = files.map((file) => {
    try {
      return compile(parseGesture(readFileSync(join(dir, file), 'utf8')));
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`);
    }
  });

  const seen = new Set<string>();
  for (const m of machines) {
    if (seen.has(m.name)) throw new Error(`duplicate gesture name '${m.name}' in ${dir}`);
    seen.add(m.name);
  }
  return machines;
}
