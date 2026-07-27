import './styles.css';
import { Recognizer, compileGestures, type Frame, type GestureEvent } from '../../src/browser.js';
import { positiveFixtures } from '../../src/synthetic/sequences.js';
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
const btnStop = $<HTMLButtonElement>('btn-stop');

const machines = compileGestures(Object.values(GESTURE_SOURCES));
const inspector = new Inspector(machinesEl, machines);

let recognizer = new Recognizer(machines);
let frameCount = 0;
let eventCount = 0;
let stopCurrent: (() => void) | null = null;

const fixtures = positiveFixtures();
for (const f of fixtures) {
  const opt = document.createElement('option');
  opt.value = f.target;
  opt.textContent = f.target;
  fixtureSel.append(opt);
}

// ---- event tape ----

const MAX_TAPE = 60;

function pushEvents(events: GestureEvent[]): void {
  for (const e of events) {
    // Update events are the high-frequency ones; showing every tick would bury the
    // lifecycle events that actually matter. Keep one in six.
    if (e.phase === 'update' && eventCount % 6 !== 0) { eventCount++; continue; }
    eventCount++;

    const node = document.createElement('div');
    node.className = `ev ${e.phase}`;
    const title = document.createElement('b');
    title.textContent = `${e.gesture} ${e.phase}`;
    const meta = document.createElement('small');
    const bits = [`${Math.round(e.t)}ms`, `hand ${e.hands.join('+')}`];
    if (e.phase !== 'cancel' && e.phase !== 'end') bits.push(`conf ${e.confidence.toFixed(2)}`);
    if (e.reason) bits.push(e.reason);
    if (e.data) {
      for (const [k, val] of Object.entries(e.data)) bits.push(`${k} ${val.toFixed(2)}`);
    }
    meta.textContent = bits.join(' · ');
    node.append(title, meta);
    tape.append(node);
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

  $('hud-hands').textContent = `hands ${frame.hands.length}`;
  $('hud-frames').textContent = `frames ${frameCount}`;
}

function reset(source: string): void {
  stopCurrent?.();
  recognizer = new Recognizer(machines);
  frameCount = 0;
  eventCount = 0;
  tape.textContent = '';
  $('ev-count').textContent = '0 events';
  $('hud-src').textContent = source;
  empty.style.display = 'none';
  btnStop.disabled = false;
}

function idle(): void {
  stopCurrent = null;
  btnStop.disabled = true;
  btnCam.disabled = false;
  btnReplay.disabled = false;
  $('hud-src').textContent = 'idle';
}

// ---- source A: replay a recorded session (no permissions needed) ----

function replay(): void {
  const target = fixtureSel.value;
  const fixture = fixtures.find((f) => f.target === target) ?? fixtures[0]!;
  reset(`replay · ${fixture.target}`);
  stage.classList.add('no-video');

  const frames = fixture.session.frames;
  const step = frames.length > 1 ? frames[1]!.t - frames[0]!.t : 16;
  const REST_MS = 700; // beat between loops, so the reset is legible

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
        $('hud-src').textContent = `replay · ${fixture.target} · loop ${loops + 1}`;
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
    if (i >= frames.length) restUntil = now + REST_MS;
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  stopCurrent = () => cancelAnimationFrame(raf);
}

// ---- source B: live webcam via MediaPipe HandLandmarker ----

async function startCamera(): Promise<void> {
  btnCam.disabled = true;
  btnCam.textContent = 'Loading model…';
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

    reset('camera');
    stage.classList.remove('no-video');
    btnCam.textContent = 'Camera running';

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
      btnCam.textContent = 'Use my camera';
      $('fps').textContent = '—';
    };
  } catch (err) {
    // Camera refusal is the common path, not an exception — say what to do instead.
    btnCam.disabled = false;
    btnCam.textContent = 'Use my camera';
    empty.style.display = 'grid';
    empty.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = 'Camera unavailable';
    const p = document.createElement('p');
    p.textContent =
      `${err instanceof Error ? err.message : String(err)}. Replaying a recorded session runs the same recognizer with no camera.`;
    empty.append(h, p);
  }
}

btnReplay.addEventListener('click', replay);
btnCam.addEventListener('click', () => { void startCamera(); });
btnStop.addEventListener('click', () => {
  stopCurrent?.();
  drawFrame(overlay, null, new Set());
  empty.style.display = 'grid';
  idle();
});

inspector.update([]);
