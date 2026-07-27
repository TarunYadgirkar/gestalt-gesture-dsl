import type { HandSample, Landmark } from './types.js';

// MediaPipe Hands 21-point indices.
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
} as const;

export const FINGERS = {
  thumb: { mcp: LM.THUMB_MCP, pip: LM.THUMB_IP, tip: LM.THUMB_TIP, base: LM.THUMB_CMC },
  index: { mcp: LM.INDEX_MCP, pip: LM.INDEX_PIP, dip: LM.INDEX_DIP, tip: LM.INDEX_TIP },
  middle: { mcp: LM.MIDDLE_MCP, pip: LM.MIDDLE_PIP, dip: LM.MIDDLE_DIP, tip: LM.MIDDLE_TIP },
  ring: { mcp: LM.RING_MCP, pip: LM.RING_PIP, dip: LM.RING_DIP, tip: LM.RING_TIP },
  pinky: { mcp: LM.PINKY_MCP, pip: LM.PINKY_PIP, dip: LM.PINKY_DIP, tip: LM.PINKY_TIP },
} as const;

export type FingerName = keyof typeof FINGERS;

// Named point aliases usable in the DSL (SPEC §1).
export const NAMED_POINT_INDEX: Record<string, number> = {
  wrist: LM.WRIST,
  thumb_tip: LM.THUMB_TIP, thumb_ip: LM.THUMB_IP, thumb_mcp: LM.THUMB_MCP,
  index_tip: LM.INDEX_TIP, index_dip: LM.INDEX_DIP, index_pip: LM.INDEX_PIP, index_mcp: LM.INDEX_MCP,
  middle_tip: LM.MIDDLE_TIP, middle_mcp: LM.MIDDLE_MCP,
  ring_tip: LM.RING_TIP, ring_mcp: LM.RING_MCP,
  pinky_tip: LM.PINKY_TIP, pinky_mcp: LM.PINKY_MCP,
};

// Derived points are centroids of several indices.
export const DERIVED_POINTS: Record<string, number[]> = {
  palm_center: [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP],
};

export function isNamedPoint(name: string): boolean {
  return name in NAMED_POINT_INDEX || name in DERIVED_POINTS;
}

// ---- pure geometry ----

export function dist(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function dist2d(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function centroid(pts: Landmark[]): Landmark {
  const n = pts.length || 1;
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p.x; y += p.y; z += p.z; }
  return { x: x / n, y: y / n, z: z / n };
}

// Angle at vertex `at` between rays to `from` and `to`, in degrees [0,180].
export function angleDeg(at: Landmark, from: Landmark, to: Landmark): number {
  const v1x = from.x - at.x, v1y = from.y - at.y;
  const v2x = to.x - at.x, v2y = to.y - at.y;
  const dot = v1x * v2x + v1y * v2y;
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (m1 === 0 || m2 === 0) return 0;
  const c = Math.min(1, Math.max(-1, dot / (m1 * m2)));
  return (Math.acos(c) * 180) / Math.PI;
}

// Resolve a named point on a hand sample to a concrete Landmark.
export function resolvePoint(hand: HandSample, name: string): Landmark {
  const derived = DERIVED_POINTS[name];
  if (derived) return centroid(derived.map((i) => hand.landmarks[i]!));
  const idx = NAMED_POINT_INDEX[name];
  if (idx === undefined) throw new Error(`unknown point: ${name}`);
  const lm = hand.landmarks[idx];
  if (!lm) throw new Error(`hand missing landmark ${idx} for point ${name}`);
  return lm;
}

// Finger curl metric: 0 = straight, ~1 = fully curled. Uses tip-to-mcp distance
// relative to a straight-finger reference (pip span). Robust to hand scale.
export function fingerCurl(hand: HandSample, finger: FingerName): number {
  const f = FINGERS[finger];
  const mcp = hand.landmarks[f.mcp]!;
  const tip = hand.landmarks[f.tip]!;
  const pip = hand.landmarks[f.pip]!;
  const straight = dist(mcp, pip) + dist(pip, tip); // path length if extended
  const direct = dist(mcp, tip); // shrinks as the finger curls
  if (straight === 0) return 0;
  const ratio = direct / straight; // ~1 straight, ->small when curled
  return Math.min(1, Math.max(0, 1 - ratio));
}
