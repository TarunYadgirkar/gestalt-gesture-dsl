import { Recognizer } from '../src/index.js';
import type { CompiledMachine } from '../src/index.js';
import type { GestureEvent, RecognizerOptions, Session } from '../src/types.js';

export function replay(
  machines: CompiledMachine[],
  session: Session,
  opts?: RecognizerOptions,
): GestureEvent[] {
  const rec = new Recognizer(machines, opts);
  const out: GestureEvent[] = [];
  for (const f of session.frames) out.push(...rec.push(f));
  return out;
}

export const startsOf = (events: GestureEvent[], gesture: string): GestureEvent[] =>
  events.filter((e) => e.gesture === gesture && e.phase === 'start');

export const firstStart = (events: GestureEvent[], gesture: string): GestureEvent | undefined =>
  startsOf(events, gesture)[0];

// Strip nothing — event equality is the determinism contract.
export const signature = (events: GestureEvent[]): string => JSON.stringify(events);
