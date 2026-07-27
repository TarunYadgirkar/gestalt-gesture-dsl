import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Session } from '../types.js';
import { loadSession } from './session.js';
import { dropFrames, negativeFixtures, positiveFixtures } from '../synthetic/sequences.js';

export const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');
export const BASELINE_PATH = join(FIXTURE_DIR, 'baseline.json');

const DROPOUT_SEEDS = [7, 42, 1337];

/**
 * The corpus the regression run scores against: clean positives, adversarial
 * negatives, and dropout-degraded variants. Degraded copies are included on purpose —
 * a change that only holds up on pristine input is not an improvement.
 * Any *.session.json committed under fixtures/ is picked up too.
 */
export function evalCorpus(): Session[] {
  const synthetic = [
    ...positiveFixtures().map((f) => f.session),
    ...negativeFixtures().map((f) => f.session),
  ];

  const degraded = positiveFixtures().flatMap((f) =>
    DROPOUT_SEEDS.map((seed) => {
      const s = dropFrames(f.session, 0.1, seed);
      return { ...s, meta: { ...s.meta, name: `${s.meta.name}+drop10%.seed${seed}` } };
    }),
  );

  return [...synthetic, ...degraded, ...recordedSessions()];
}

export function recordedSessions(): Session[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.session.json'))
    .sort()
    .map((f) => loadSession(readFileSync(join(FIXTURE_DIR, f), 'utf8')));
}
