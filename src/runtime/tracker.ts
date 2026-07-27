import type { Frame, HandId, HandSample } from '../types.js';
import { LM } from '../landmarks.js';

// MediaPipe's Left/Right label flips under fast motion and occlusion, so it is a hint,
// never an identity. Identity comes from spatial continuity: the wrist that is closest
// to where a hand was last frame is that same hand (SPEC §4.1, §6).

export interface TrackedHand {
  id: HandId;
  sample: HandSample;
}

interface Entry {
  id: HandId;
  wrist: { x: number; y: number };
  lastSeenT: number;
}

export interface TrackerOptions {
  /** Farthest a wrist may travel between frames and still be the same hand. */
  maxJump?: number;
  /** How long an unseen hand keeps its identity before it is forgotten. */
  forgetMs?: number;
}

export class HandTracker {
  private entries: Entry[] = [];
  private nextId: HandId = 0;
  private readonly maxJump: number;
  private readonly forgetMs: number;

  constructor(opts: TrackerOptions = {}) {
    this.maxJump = opts.maxJump ?? 0.35;
    this.forgetMs = opts.forgetMs ?? 500;
  }

  track(frame: Frame): TrackedHand[] {
    this.entries = this.entries.filter((e) => frame.t - e.lastSeenT <= this.forgetMs);

    const wristOf = (h: HandSample): { x: number; y: number } => {
      const w = h.landmarks[LM.WRIST]!;
      return { x: w.x, y: w.y };
    };

    const candidates: { hi: number; ei: number; d: number }[] = [];
    frame.hands.forEach((h, hi) => {
      const w = wristOf(h);
      this.entries.forEach((e, ei) => {
        const d = Math.hypot(w.x - e.wrist.x, w.y - e.wrist.y);
        if (d <= this.maxJump) candidates.push({ hi, ei, d });
      });
    });

    // Greedy nearest-first assignment. With at most two hands this is optimal, and
    // it stays deterministic: ties break on hand index, then entry index.
    candidates.sort((a, b) => a.d - b.d || a.hi - b.hi || a.ei - b.ei);

    const handToEntry = new Map<number, number>();
    const takenEntries = new Set<number>();
    for (const c of candidates) {
      if (handToEntry.has(c.hi) || takenEntries.has(c.ei)) continue;
      handToEntry.set(c.hi, c.ei);
      takenEntries.add(c.ei);
    }

    const out: TrackedHand[] = [];
    frame.hands.forEach((sample, hi) => {
      const ei = handToEntry.get(hi);
      const wrist = wristOf(sample);
      if (ei !== undefined) {
        const entry = this.entries[ei]!;
        entry.wrist = wrist;
        entry.lastSeenT = frame.t;
        out.push({ id: entry.id, sample });
      } else {
        const id = this.nextId++;
        this.entries.push({ id, wrist, lastSeenT: frame.t });
        out.push({ id, sample });
      }
    });

    return out.sort((a, b) => a.id - b.id);
  }
}
