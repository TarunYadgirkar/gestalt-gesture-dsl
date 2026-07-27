import type { Frame, HandSample } from '../../src/browser.js';
import { LM } from '../../src/browser.js';

// MediaPipe's 21-point topology as bone pairs.
const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const NEAR = [255, 122, 69] as const;
const MID = [196, 79, 232] as const;
const FAR = [74, 108, 247] as const;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Depth ramp: z is negative toward the camera in MediaPipe space, so a hand reaching
 * forward warms from blue through violet to amber. The skeleton is not decorated with
 * colour — it reports the axis you otherwise cannot see on a 2D screen.
 */
function depthColor(z: number, alpha = 1): string {
  const t = Math.min(1, Math.max(0, (z + 0.12) / 0.24)); // ~[-0.12, 0.12] -> [0,1]
  const [r, g, b] =
    t < 0.5
      ? ([lerp(NEAR[0], MID[0], t * 2), lerp(NEAR[1], MID[1], t * 2), lerp(NEAR[2], MID[2], t * 2)] as const)
      : ([lerp(MID[0], FAR[0], (t - 0.5) * 2), lerp(MID[1], FAR[1], (t - 0.5) * 2), lerp(MID[2], FAR[2], (t - 0.5) * 2)] as const);
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
}

export function drawFrame(
  canvas: HTMLCanvasElement,
  frame: Frame | null,
  highlight: Set<number>,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!frame) return;

  frame.hands.forEach((hand, i) => {
    drawHand(ctx, hand, canvas.width, canvas.height, highlight.has(i));
  });
}

function drawHand(
  ctx: CanvasRenderingContext2D,
  hand: HandSample,
  w: number,
  h: number,
  lit: boolean,
): void {
  const pt = (i: number): { x: number; y: number; z: number } => {
    const lm = hand.landmarks[i]!;
    return { x: lm.x * w, y: lm.y * h, z: lm.z };
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const [a, b] of BONES) {
    const p = pt(a), q = pt(b);
    const grad = ctx.createLinearGradient(p.x, p.y, q.x, q.y);
    grad.addColorStop(0, depthColor(p.z, lit ? 0.95 : 0.6));
    grad.addColorStop(1, depthColor(q.z, lit ? 0.95 : 0.6));
    ctx.strokeStyle = grad;
    ctx.lineWidth = lit ? 4 : 2.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }

  // Fingertips and wrist carry the conditions the DSL actually reads, so they get
  // drawn larger than the intermediate joints.
  const keyPoints = new Set<number>([LM.WRIST, LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP]);
  hand.landmarks.forEach((_, i) => {
    const p = pt(i);
    const key = keyPoints.has(i);
    ctx.fillStyle = depthColor(p.z, key ? 1 : 0.7);
    ctx.beginPath();
    ctx.arc(p.x, p.y, key ? (lit ? 6 : 4.5) : 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // The pinch gap is the most-read measurement in the library — show it directly.
  const thumb = pt(LM.THUMB_TIP);
  const index = pt(LM.INDEX_TIP);
  const gap = Math.hypot(thumb.x - index.x, thumb.y - index.y);
  if (gap < w * 0.14) {
    ctx.strokeStyle = gap < w * 0.05 ? 'rgba(70,229,180,0.9)' : 'rgba(139,130,168,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(thumb.x, thumb.y);
    ctx.lineTo(index.x, index.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
