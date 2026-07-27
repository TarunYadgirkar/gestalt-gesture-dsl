import type { HandSample, Handedness, Landmark } from '../types.js';
import { LM } from '../landmarks.js';

export type PoseName = 'open' | 'pinch' | 'fist' | 'point' | 'palm_forward';

export interface PoseOptions {
  center?: { x: number; y: number; z?: number };
  scale?: number; // hand size in normalized units
  rotation?: number; // in-plane degrees, + = counterclockwise (y-up)
  handedness?: Handedness;
  score?: number;
  pinchAmount?: number; // 0..1, only for 'pinch'
}

// Canonical open right hand in local space: wrist at origin, fingers point +y (up),
// x to the right. Units ~ fraction of hand length (wrist->middle_tip ~1.06).
const TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.0], // 0 wrist
  [-0.25, 0.10], // 1 thumb cmc
  [-0.40, 0.25], // 2 thumb mcp
  [-0.50, 0.38], // 3 thumb ip
  [-0.55, 0.50], // 4 thumb tip
  [-0.18, 0.55], // 5 index mcp
  [-0.20, 0.75], // 6 index pip
  [-0.21, 0.88], // 7 index dip
  [-0.22, 1.00], // 8 index tip
  [0.0, 0.58], // 9 middle mcp
  [0.0, 0.80], // 10 middle pip
  [0.0, 0.93], // 11 middle dip
  [0.0, 1.06], // 12 middle tip
  [0.16, 0.55], // 13 ring mcp
  [0.17, 0.75], // 14 ring pip
  [0.18, 0.88], // 15 ring dip
  [0.19, 1.00], // 16 ring tip
  [0.30, 0.50], // 17 pinky mcp
  [0.32, 0.66], // 18 pinky pip
  [0.33, 0.77], // 19 pinky dip
  [0.34, 0.86], // 20 pinky tip
];

const DEFAULT_SCALE = 0.32;

type P2 = [number, number];
const lerp2 = (a: P2, b: P2, t: number): P2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function curlFinger(local: P2[], mcpI: number, pipI: number, dipI: number, tipI: number, c: number): void {
  const mcp = local[mcpI]!;
  local[pipI] = lerp2(local[pipI]!, mcp, 0.25 * c);
  local[dipI] = lerp2(local[dipI]!, mcp, 0.55 * c);
  local[tipI] = lerp2(local[tipI]!, mcp, 0.85 * c);
}

export function pose(name: PoseName, opts: PoseOptions = {}): HandSample {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const center = opts.center ?? { x: 0.5, y: 0.5 };
  const cz = center.z ?? 0;
  const rot = ((opts.rotation ?? 0) * Math.PI) / 180;
  const handedness: Handedness = opts.handedness ?? 'Right';
  const score = opts.score ?? 0.99;

  const local: P2[] = TEMPLATE.map((p) => [p[0], p[1]] as P2);

  if (name === 'pinch') {
    const amt = opts.pinchAmount ?? 1;
    const tt = local[LM.THUMB_TIP]!, it = local[LM.INDEX_TIP]!;
    const mid: P2 = [(tt[0] + it[0]) / 2, (tt[1] + it[1]) / 2];
    local[LM.THUMB_TIP] = lerp2(tt, mid, amt);
    local[LM.INDEX_TIP] = lerp2(it, mid, amt);
    local[LM.THUMB_IP] = lerp2(local[LM.THUMB_IP]!, mid, amt * 0.4);
    local[LM.INDEX_DIP] = lerp2(local[LM.INDEX_DIP]!, mid, amt * 0.4);
  } else if (name === 'fist') {
    curlFinger(local, LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP, 1);
    curlFinger(local, LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP, 1);
    curlFinger(local, LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP, 1);
    curlFinger(local, LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP, 1);
    curlFinger(local, LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_IP, LM.THUMB_TIP, 0.5);
  } else if (name === 'point') {
    curlFinger(local, LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP, 1);
    curlFinger(local, LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP, 1);
    curlFinger(local, LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP, 1);
    curlFinger(local, LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_IP, LM.THUMB_TIP, 0.6);
  }
  // 'open' and 'palm_forward' use the template unchanged (motion carries palm-push).

  const mirror = handedness === 'Left' ? -1 : 1;
  const cos = Math.cos(rot), sin = Math.sin(rot);

  const landmarks: Landmark[] = local.map(([lx0, ly]) => {
    const lx = lx0 * mirror;
    // rotate in local (y-up) space
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    // place into image space: y-up local -> y-down image
    return { x: center.x + rx * scale, y: center.y - ry * scale, z: cz };
  });

  return { handedness, score, landmarks };
}

// Per-landmark linear interpolation between two samples (same handedness).
export function lerpPose(a: HandSample, b: HandSample, t: number): HandSample {
  const landmarks = a.landmarks.map((la, i) => {
    const lb = b.landmarks[i]!;
    return { x: la.x + (lb.x - la.x) * t, y: la.y + (lb.y - la.y) * t, z: la.z + (lb.z - la.z) * t };
  });
  return { handedness: a.handedness, score: a.score + (b.score - a.score) * t, landmarks };
}
