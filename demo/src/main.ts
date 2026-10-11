import './styles.css';
import { Recognizer, compileGestures, type Frame, type GestureEvent } from '../../src/browser.js';
import { positiveFixtures } from '../../src/synthetic/sequences.js';
import type { LabeledSession } from '../../src/synthetic/sequences.js';
import { GESTURE_SOURCES } from './gestures.js';
import { drawFrame } from './render.js';
import { Inspector } from './inspector.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stage = $('stage');
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const empty = $('empty');
const tape = $('tape');
const machinesEl = $('machines');
const fixtureSel = $<HTMLSelectElement>('fixture');
const btnReplay = $<HTMLButtonElement>('btn-replay');
const btnCam = $<HTMLButtonElement>('btn-cam');
const btnCamLabel = $('btn-cam-label');
const btnStop = $<HTMLButtonElement>('btn-stop');
const hudSrc = $('hud-src');
const progressBar = $('progress-bar');

const machines = compileGestures(Object.values(GESTURE_SOURCES));
const inspector = new Inspector(machinesEl, machines);

// The richest default: a pinch that starts moving, so the first thing a visitor sees
// is pinch firing and then being preempted by pinch-drag.
const DEFAULT_FIXTURE = 'pinch-drag';
const MAX_TAPE = 60;
const UPDATE_SAMPLE = 6; // keep one update tick in six so lifecycle events stay visible
const REST_MS = 700; // beat between replay loops, so the reset is legible

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let recognizer = new Recognizer(machines);
let frameCount = 0;
let eventCount = 0;
let stopCurrent: (() => void) | null = null;
let replaying = false;

const fixtures = positiveFixtures();
for (const f of fixtures) {
  const opt = document.createElement('option');
  opt.value = f.target;
  opt.textContent = f.target;
  fixtureSel.append(opt);
}
fixtureSel.value = DEFAULT_FIXTURE;

const selectedFixture = (): LabeledSession =>
  fixtures.find((f) => f.target === fixtureSel.value) ?? fixtures[0]!;

// ---- event tape ----

function describeEvent(e: GestureEvent): string {
  const bits = [`${Math.round(e.t)}ms`, `hand ${e.hands.join('+')}`];
  if (e.phase !== 'cancel' && e.phase !== 'end') bits.push(`conf ${e.confidence.toFixed(2)}`);
  if (e.reason) bits.push(e.reason);
  for (const [k, val] of Object.entries(e.data ?? {})) bits.push(`${k} ${val.toFixed(2)}`);
  return bits.join('  ');
}

function eventNode(e: GestureEvent, animate: boolean): HTMLLIElement {
  const node = document.createElement('li');
  node.className = `ev ${e.phase}${animate ? ' fresh' : ''}`;
  const title = document.createElement('span');
  title.className = 'ev-title';
  const phase = document.createElement('span');
  phase.className = 'ev-phase';
  phase.textContent = e.phase;
  title.append(e.gesture, phase);
  const meta = document.createElement('span');
  meta.className = 'ev-meta';
  meta.textContent = describeEvent(e);
  node.append(title, meta);
  return node;
}

function pushEvents(events: GestureEvent[]): void {
  for (const e of events) {
    eventCount++;
    if (e.phase === 'update' && eventCount % UPDATE_SAMPLE !== 0) continue;
    tape.append(eventNode(e, !prefersReducedMotion));
    tape.scrollLeft = tape.scrollWidth;
  }
  while (tape.children.length > MAX_TAPE) tape.firstElementChild?.remove();
  $('ev-count').textContent = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
}

// ---- shared per-frame path: both sources go through exactly this ----

function consume(frame: Frame): void {
  frameCount++;
  const events = recognizer.push(frame);
  if (events.length) pushEvents(events);

  const views = recognizer.inspect();
  inspector.update(views);

  const lit = new Set<number>();
  if (views.some((v) => v.active)) frame.hands.forEach((_, i) => lit.add(i));
  drawFrame(overlay, frame, lit);

  const n = frame.hands.length;
  $('hud-hands').textContent = `${n} hand${n === 1 ? '' : 's'}`;
}

function setSource(label: string, synthetic: boolean): void {
  hudSrc.textContent = label;
  hudSrc.classList.toggle('synthetic', synthetic);
}

function setProgress(i: number, total: number): void {
  $('hud-frames').textContent = `frame ${i}/${total}`;
  progressBar.style.transform = `scaleX(${total ? i / total : 0})`;
}

function reset(): void {
  stopCurrent?.();
  stopCurrent = null;
  replaying = false;
  recognizer = new Recognizer(machines);
  frameCount = 0;
  eventCount = 0;
  tape.textContent = '';
  $('ev-count').textContent = '0 events';
  empty.hidden = true;
}

function idle(): void {
  stopCurrent = null;
  replaying = false;
  btnStop.disabled = true;
  btnCam.disabled = false;
  btnReplay.disabled = false;
  setSource('idle', false);
}

// ---- source A: replay a synthetic session (no permissions needed) ----

function replay(): void {
  const fixture = selectedFixture();
  reset();
  replaying = true;
  btnStop.disabled = false;
  stage.classList.add('no-video');
  inspector.expand(fixture.target);
  setSource(`synthetic · ${fixture.target}`, true);

  const frames = fixture.session.frames;
  const step = frames.length > 1 ? frames[1]!.t - frames[0]!.t : 16;

  let i = 0;
  let loops = 0;
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let restUntil = 0;
  let offset = 0; // keeps frame timestamps monotonic across loops

  const tick = (now: number): void => {
    acc += now - last;
    last = now;

    if (restUntil > 0) {
      if (now >= restUntil) {
        // Fresh recognizer each loop: a replay must start from the same clean state
        // every time, or loop two would inherit loop one's latches.
        restUntil = 0;
        recognizer = new Recognizer(machines);
        offset += frames[frames.length - 1]!.t + REST_MS;
        i = 0;
        acc = 0;
        loops++;
        setSource(`synthetic · ${fixture.target} · loop ${loops + 1}`, true);
      }
      raf = requestAnimationFrame(tick);
      return;
    }

    // Replay in the session's own time base so latency looks like it will live.
    while (acc >= step && i < frames.length) {
      const f = frames[i]!;
      consume({ t: f.t + offset, hands: f.hands });
      i++;
      acc -= step;
    }
    setProgress(i, frames.length);
    if (i >= frames.length) restUntil = now + REST_MS;
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  stopCurrent = () => cancelAnimationFrame(raf);
}

// Reduced motion: no autoplay. Run the default session up to the frame where its
// target gesture is firing and hold there, so the first screen still shows a decision.
function showStill(): void {
  const fixture = selectedFixture();
  reset();
  inspector.expand(fixture.target);
  const frames = fixture.session.frames;
  let i = 0;
  for (; i < frames.length; i++) {
    consume(frames[i]!);
    if (recognizer.inspect().some((v) => v.gesture === fixture.target && v.active)) break;
  }
  setProgress(Math.min(i + 1, frames.length), frames.length);
  setSource(`synthetic · ${fixture.target} · paused`, true);
}

// ---- source B: live webcam via MediaPipe HandLandmarker ----

function showStageMessage(title: string, body: string): void {
  empty.hidden = false;
  empty.textContent = '';
  const h = document.createElement('h3');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  empty.append(h, p);
}

async function startCamera(): Promise<void> {
  btnCam.disabled = true;
  btnCamLabel.textContent = 'Loading hand model…';
  try {
    const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
    );
    const landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 720, facingMode: 'user' },
    });
    video.srcObject = stream;
    await video.play();

    reset();
    btnStop.disabled = false;
    btnReplay.disabled = false;
    stage.classList.remove('no-video');
    setSource('camera', false);
    progressBar.style.transform = 'scaleX(0)';
    btnCamLabel.textContent = 'Camera on';

    let raf = 0;
    let lastVideoTime = -1;
    let fpsLast = performance.now();
    let fpsFrames = 0;

    const tick = (): void => {
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const now = performance.now();
        const result = landmarker.detectForVideo(video, now);

        const frame: Frame = {
          t: now,
          hands: result.landmarks.map((landmarks, i) => ({
            handedness: (result.handedness[i]?.[0]?.categoryName ?? 'Right') as 'Left' | 'Right',
            score: result.handedness[i]?.[0]?.score ?? 0.9,
            landmarks: landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          })),
        };
        consume(frame);
        $('hud-frames').textContent = `frame ${frameCount}`;

        fpsFrames++;
        if (now - fpsLast > 500) {
          $('fps').textContent = `${Math.round((fpsFrames * 1000) / (now - fpsLast))} fps`;
          fpsLast = now;
          fpsFrames = 0;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    stopCurrent = () => {
      cancelAnimationFrame(raf);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      stage.classList.add('no-video');
      btnCam.disabled = false;
      btnCamLabel.textContent = 'Use my camera';
      $('fps').textContent = '';
    };
  } catch (err) {
    // Camera refusal is the common path, not an exception: say what to do instead.
    btnCam.disabled = false;
    btnCamLabel.textContent = 'Use my camera';
    const reason = err instanceof Error ? err.message : String(err);
    showStageMessage(
      'Camera unavailable',
      `${reason}. Allow camera access in your browser and try again, or replay a session to run the same recognizer without a camera.`,
    );
  }
}

btnReplay.addEventListener('click', replay);
btnCam.addEventListener('click', () => { void startCamera(); });
btnStop.addEventListener('click', () => {
  stopCurrent?.();
  drawFrame(overlay, null, new Set());
  setProgress(0, 0);
  $('hud-frames').textContent = 'frame 0';
  showStageMessage('No hand in view', 'Replay a session to watch the machines run, or use your camera to drive them with your own hands.');
  inspector.update([]);
  idle();
});
fixtureSel.addEventListener('change', () => {
  if (replaying) replay();
  else inspector.expand(fixtureSel.value);
});

inspector.update([]);
if (prefersReducedMotion) showStill();
else replay();
