import type { Frame, HandSample, Landmark, Session } from '../types.js';
import { LM, dist, resolvePoint } from '../landmarks.js';
import { pose } from './poser.js';

export interface LabeledSession {
  session: Session;
  target: string;
  expectFire: boolean;
  latencyBudgetMs: number;
}

const FPS = 60;
const DT = 1000 / FPS;
const tAt = (i: number): number => Math.round(i * DT);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const ramp = (i: number, i0: number, i1: number): number => clamp01((i - i0) / (i1 - i0));

// ---- geometry probes (mirror what the recognizer will compute) ----

const pinchDist = (h: HandSample): number =>
  dist(h.landmarks[LM.THUMB_TIP]!, h.landmarks[LM.INDEX_TIP]!);
const PINCH_ENTER = 0.05;
const DRAG_THRESH = 0.06;
const isPinched = (h: HandSample): boolean => pinchDist(h) < PINCH_ENTER;

const palm = (h: HandSample): Landmark => resolvePoint(h, 'palm_center');
const span = (a: HandSample, b: HandSample): number => dist(palm(a), palm(b));
const pairAngleDeg = (a: HandSample, b: HandSample): number => {
  const pa = palm(a), pb = palm(b);
  return (Math.atan2(-(pb.y - pa.y), pb.x - pa.x) * 180) / Math.PI; // y-up
};

function velAxis(cur: Landmark, prev: Landmark, axis: 'x' | 'y' | 'z'): number {
  return (cur[axis] - prev[axis]) / (DT / 1000);
}

// Planar speed, matching the `moving` predicate in pinch-drag.yaml. Using an x-only
// velocity here would mislabel a rotation, whose hands travel mostly in y.
function planarSpeed(cur: Landmark, prev: Landmark, dtMs: number): number {
  return Math.hypot(cur.x - prev.x, cur.y - prev.y) / (dtMs / 1000);
}

// First frame time where pred holds; falls back to first frame if never (shouldn't happen for positives).
function onsetT(frames: Frame[], pred: (f: Frame, prev: Frame | null, i: number) => boolean): number {
  for (let i = 0; i < frames.length; i++) {
    if (pred(frames[i]!, i > 0 ? frames[i - 1]! : null, i)) return frames[i]!.t;
  }
  return frames[frames.length - 1]!.t;
}

function build(n: number, gen: (i: number) => HandSample[]): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) frames.push({ t: tAt(i), hands: gen(i) });
  return frames;
}

function session(name: string, frames: Frame[], labels: Session['labels']): Session {
  return { meta: { name, schema: 'gestalt/v1', fps: FPS, createdBy: 'synthetic' }, frames, labels };
}

// ---------- positive builders ----------

function pinchPositive(): LabeledSession {
  // still open -> close over 6 frames -> hold pinched still -> release
  const frames = build(90, (i) => {
    const amt = i < 30 ? 0 : i <= 36 ? ramp(i, 30, 36) : i <= 72 ? 1 : i <= 78 ? 1 - ramp(i, 72, 78) : 0;
    return [pose('pinch', { pinchAmount: amt, center: { x: 0.5, y: 0.5 } })];
  });
  const onset = onsetT(frames, (f) => isPinched(f.hands[0]!));
  const offset = tAt(78);
  return {
    session: session('pinch-positive', frames, [{ gesture: 'pinch', onset, offset }]),
    target: 'pinch',
    expectFire: true,
    latencyBudgetMs: 160,
  };
}

const V_DRAG = 0.25; // planar speed (units/s) that counts as dragging

function pinchDragPositive(): LabeledSession {
  // pinch closes at ~frame 20, then drags right while pinched
  const frames = build(80, (i) => {
    const amt = i < 20 ? 0 : i <= 26 ? ramp(i, 20, 26) : 1 * (i <= 66 ? 1 : 1 - ramp(i, 66, 72));
    const x = 0.5 + 0.22 * ramp(i, 26, 50); // drag right after close
    return [pose('pinch', { pinchAmount: Math.max(0, amt), center: { x, y: 0.5 } })];
  });
  const onset = onsetT(frames, (f, prev) => {
    if (!prev) return false;
    const h = f.hands[0]!;
    if (!isPinched(h)) return false;
    return Math.abs(velAxis(palm(h), palm(prev.hands[0]!), 'x')) > V_DRAG;
  });
  // The hand genuinely pinches before it drags, so 'pinch' is honest ground truth here
  // too — it is preempted by pinch-drag (SPEC §5 rule 2), not a false positive.
  const pinchOnset = onsetT(frames, (f) => isPinched(f.hands[0]!));
  return {
    session: session('pinch-drag-positive', frames, [
      { gesture: 'pinch-drag', onset, offset: tAt(72) },
      { gesture: 'pinch', onset: pinchOnset, offset: onset },
    ]),
    target: 'pinch-drag',
    expectFire: true,
    latencyBudgetMs: 160,
  };
}

function swipePositive(): LabeledSession {
  // still, then fast rightward sweep
  const frames = build(70, (i) => {
    const x = 0.22 + 0.56 * ramp(i, 20, 32);
    return [pose('open', { center: { x, y: 0.5 } })];
  });
  const SWIPE_V = 1.5;
  const onset = onsetT(frames, (f, prev) => {
    if (!prev) return false;
    return velAxis(palm(f.hands[0]!), palm(prev.hands[0]!), 'x') > SWIPE_V;
  });
  return {
    session: session('swipe-positive', frames, [{ gesture: 'swipe', onset, offset: tAt(40) }]),
    target: 'swipe',
    expectFire: true,
    latencyBudgetMs: 200,
  };
}

function dwellSelectPositive(): LabeledSession {
  const DWELL_MS = 600;
  // point, settle by frame 3, hold still until frame 50, then move away
  const frames = build(66, (i) => {
    const x = i < 3 ? 0.5 + 0.02 * (3 - i) : i <= 50 ? 0.5 : 0.5 + 0.02 * (i - 50);
    return [pose('point', { center: { x, y: 0.5 } })];
  });
  const hoverStart = tAt(3);
  const onset = onsetT(frames, (f) => f.t >= hoverStart + DWELL_MS);
  return {
    session: session('dwell-select-positive', frames, [{ gesture: 'dwell-select', onset, offset: tAt(50) }]),
    target: 'dwell-select',
    expectFire: true,
    latencyBudgetMs: 120,
  };
}

function palmPushPositive(): LabeledSession {
  // open palm still, then push toward camera (z decreases fast)
  const frames = build(60, (i) => {
    const z = -0.35 * ramp(i, 20, 30);
    return [pose('open', { center: { x: 0.5, y: 0.5, z } })];
  });
  const PUSH_VZ = -0.8;
  const onset = onsetT(frames, (f, prev) => {
    if (!prev) return false;
    return velAxis(palm(f.hands[0]!), palm(prev.hands[0]!), 'z') < PUSH_VZ;
  });
  return {
    session: session('palm-push-positive', frames, [{ gesture: 'palm-push', onset, offset: tAt(40) }]),
    target: 'palm-push',
    expectFire: true,
    latencyBudgetMs: 120,
  };
}

// When both hands are pinched and translating, each hand on its own is a pinch-drag.
// Label it at the frame the hands actually start moving, not at the frame they pinch.
function perHandDragOnset(frames: Frame[]): number {
  return onsetT(frames, (f, prev) => {
    if (!prev || f.hands.length < 2 || prev.hands.length < 2) return false;
    return f.hands.every((h, i) => {
      const p = prev.hands[i];
      return !!p && isPinched(h) && planarSpeed(palm(h), palm(p), f.t - prev.t) > V_DRAG;
    });
  });
}

function twoHandScalePositive(): LabeledSession {
  let anchor: number | null = null;
  const frames = build(60, (i) => {
    const s = ramp(i, 20, 44);
    const h0 = pose('pinch', { pinchAmount: 1, handedness: 'Left', center: { x: 0.35 - 0.15 * s, y: 0.5 } });
    const h1 = pose('pinch', { pinchAmount: 1, handedness: 'Right', center: { x: 0.65 + 0.15 * s, y: 0.5 } });
    return [h0, h1];
  });
  const dragOnset = perHandDragOnset(frames);
  const onset = onsetT(frames, (f) => {
    const [a, b] = f.hands;
    if (!a || !b || !isPinched(a) || !isPinched(b)) return false;
    const sp = span(a, b);
    if (anchor === null) anchor = sp;
    return Math.abs(sp / anchor - 1) > 0.1;
  });
  return {
    session: session('two-hand-scale-positive', frames, [
      { gesture: 'two-hand-scale', onset, offset: tAt(58) },
      // Both hands are pinched from frame 0 and then translate apart, so on each hand
      // in isolation a pinch and then a pinch-drag genuinely occur. They are preempted
      // by the two-hand gesture (SPEC §5 rule 2), not false positives — so they are
      // labeled rather than counted against precision.
      { gesture: 'pinch', onset: frames[0]!.t, offset: dragOnset },
      { gesture: 'pinch', onset: frames[0]!.t, offset: dragOnset },
      { gesture: 'pinch-drag', onset: dragOnset, offset: onset },
      { gesture: 'pinch-drag', onset: dragOnset, offset: onset },
    ]),
    target: 'two-hand-scale',
    expectFire: true,
    latencyBudgetMs: 160,
  };
}

function twoHandRotatePositive(): LabeledSession {
  let anchor: number | null = null;
  const r = 0.15;
  const frames = build(60, (i) => {
    const deg = 45 * ramp(i, 20, 48);
    const th = (deg * Math.PI) / 180;
    const cx = 0.5, cy = 0.5;
    const h0 = pose('pinch', { pinchAmount: 1, handedness: 'Left', center: { x: cx + r * Math.cos(th + Math.PI), y: cy - r * Math.sin(th + Math.PI) } });
    const h1 = pose('pinch', { pinchAmount: 1, handedness: 'Right', center: { x: cx + r * Math.cos(th), y: cy - r * Math.sin(th) } });
    return [h0, h1];
  });
  const dragOnset = perHandDragOnset(frames);
  const onset = onsetT(frames, (f) => {
    const [a, b] = f.hands;
    if (!a || !b || !isPinched(a) || !isPinched(b)) return false;
    const ang = pairAngleDeg(a, b);
    if (anchor === null) anchor = ang;
    return Math.abs(ang - anchor) > 15;
  });
  return {
    session: session('two-hand-rotate-positive', frames, [
      { gesture: 'two-hand-rotate', onset, offset: tAt(58) },
      // Same as the scale fixture: real pinches and real per-hand translation, both
      // superseded by the two-hand gesture once the bearing changes enough.
      { gesture: 'pinch', onset: frames[0]!.t, offset: dragOnset },
      { gesture: 'pinch', onset: frames[0]!.t, offset: dragOnset },
      { gesture: 'pinch-drag', onset: dragOnset, offset: onset },
      { gesture: 'pinch-drag', onset: dragOnset, offset: onset },
    ]),
    target: 'two-hand-rotate',
    expectFire: true,
    latencyBudgetMs: 160,
  };
}

// ---------- negative (adversarial) builders ----------

function pinchNearMiss(): LabeledSession {
  // closes to ~0.077 gap, never crosses 0.05
  const frames = build(80, (i) => {
    const amt = i < 30 ? 0 : i <= 40 ? 0.6 * ramp(i, 30, 40) : i <= 70 ? 0.6 : 0.6 * (1 - ramp(i, 70, 78));
    return [pose('pinch', { pinchAmount: amt, center: { x: 0.5, y: 0.5 } })];
  });
  return { session: session('pinch-near-miss', frames, []), target: 'pinch', expectFire: false, latencyBudgetMs: 160 };
}

function dragTooSlow(): LabeledSession {
  // real pinch, but barely moves (below drag threshold): pinch-drag must NOT fire
  const frames = build(80, (i) => {
    const amt = i < 20 ? 0 : i <= 26 ? ramp(i, 20, 26) : 1;
    const x = 0.5 + 0.03 * ramp(i, 26, 74); // total 0.03 < DRAG_THRESH, and slow
    return [pose('pinch', { pinchAmount: amt, center: { x, y: 0.5 } })];
  });
  // The hand does close into a real pinch — that part must fire. What must NOT fire is
  // pinch-drag, because the hand never reaches drag speed. Labeling the pinch keeps the
  // negative honest: it isolates the drag threshold instead of also asserting no pinch.
  const pinchOnset = onsetT(frames, (f) => isPinched(f.hands[0]!));
  return {
    session: session('drag-too-slow', frames, [
      { gesture: 'pinch', onset: pinchOnset, offset: frames[frames.length - 1]!.t },
    ]),
    target: 'pinch-drag',
    expectFire: false,
    latencyBudgetMs: 160,
  };
}

function swipeTooSlow(): LabeledSession {
  const frames = build(70, (i) => {
    const x = 0.3 + 0.25 * ramp(i, 20, 56); // 0.42 units/s, well under swipe speed
    return [pose('open', { center: { x, y: 0.5 } })];
  });
  return { session: session('swipe-too-slow', frames, []), target: 'swipe', expectFire: false, latencyBudgetMs: 200 };
}

function dwellTooShort(): LabeledSession {
  // holds still ~330ms then moves — dwell (600ms) never completes
  const frames = build(60, (i) => {
    const x = i < 3 ? 0.5 : i <= 23 ? 0.5 : 0.5 + 0.02 * (i - 23);
    return [pose('point', { center: { x, y: 0.5 } })];
  });
  return { session: session('dwell-too-short', frames, []), target: 'dwell-select', expectFire: false, latencyBudgetMs: 120 };
}

function palmPushSlow(): LabeledSession {
  const frames = build(70, (i) => {
    const z = -0.18 * ramp(i, 20, 56); // slow reach, vz ~ -0.3
    return [pose('open', { center: { x: 0.5, y: 0.5, z } })];
  });
  return { session: session('palm-push-slow', frames, []), target: 'palm-push', expectFire: false, latencyBudgetMs: 120 };
}

function fistPunch(): LabeledSession {
  // fast forward motion but a FIST, not an open palm — palm-push must NOT fire
  const frames = build(60, (i) => {
    const z = -0.35 * ramp(i, 20, 30);
    return [pose('fist', { center: { x: 0.5, y: 0.5, z } })];
  });
  return { session: session('fist-punch', frames, []), target: 'palm-push', expectFire: false, latencyBudgetMs: 120 };
}

// ---------- catalogs ----------

export function positiveFixtures(): LabeledSession[] {
  return [
    pinchPositive(),
    pinchDragPositive(),
    twoHandScalePositive(),
    twoHandRotatePositive(),
    dwellSelectPositive(),
    palmPushPositive(),
    swipePositive(),
  ];
}

export function negativeFixtures(): LabeledSession[] {
  return [pinchNearMiss(), dragTooSlow(), swipeTooSlow(), dwellTooShort(), palmPushSlow(), fistPunch()];
}

// ---------- frame dropout (seeded, deterministic) ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Remove ~fraction of frames at random (never the first). Labels preserved.
export function dropFrames(s: Session, fraction: number, seed: number): Session {
  const rng = mulberry32(seed);
  const frames = s.frames.filter((_, i) => i === 0 || rng() >= fraction);
  return { meta: s.meta, frames, labels: s.labels };
}
