import type { Session } from '../types.js';

const SCHEMA = 'gestalt/v1';

export function saveSession(s: Session): string {
  return JSON.stringify(s, null, 2);
}

export function loadSession(json: string): Session {
  const raw: unknown = JSON.parse(json);
  const s = raw as Partial<Session>;
  if (!s || typeof s !== 'object') throw new Error('session is not an object');
  if (s.meta?.schema !== SCHEMA) {
    throw new Error(`unsupported session schema '${String(s.meta?.schema)}', expected '${SCHEMA}'`);
  }
  if (!Array.isArray(s.frames)) throw new Error('session has no frames array');
  if (!Array.isArray(s.labels)) throw new Error('session has no labels array');
  return s as Session;
}

/** Captures a live stream (e.g. the browser demo) into a replayable session. */
export class SessionRecorder {
  private readonly session: Session;

  constructor(name: string, createdBy = 'recorder') {
    this.session = { meta: { name, schema: SCHEMA, createdBy }, frames: [], labels: [] };
  }

  frame(f: Session['frames'][number]): void {
    this.session.frames.push(f);
  }

  label(l: Session['labels'][number]): void {
    this.session.labels.push(l);
  }

  finish(): Session {
    const fps = this.estimateFps();
    return { ...this.session, meta: { ...this.session.meta, ...(fps ? { fps } : {}) } };
  }

  private estimateFps(): number | undefined {
    const f = this.session.frames;
    if (f.length < 2) return undefined;
    const span = f[f.length - 1]!.t - f[0]!.t;
    return span > 0 ? Math.round(((f.length - 1) / span) * 1000) : undefined;
  }
}
