import type { CompiledMachine } from '../dsl/compile.js';
import type { Frame, GestureEvent, HandId, HandSample, RecognizerOptions, TraceEntry } from '../types.js';
import { HandTracker, type TrackedHand } from './tracker.js';
import { MachineInstance, type GuardView } from './instance.js';

export interface InstanceView {
  gesture: string;
  priority: number;
  hands: HandId[];
  state: string;
  active: boolean;
  guards: GuardView[];
}

const DEFAULT_GRACE_MS = 200;
const MAX_TRACE = 2000;

// Cancels and ends land before starts so a consumer undoes the old effect before
// applying the new one. Beyond that, ordering is by gesture name — never library
// order or insertion order (SPEC §6 determinism).
const PHASE_RANK: Record<GestureEvent['phase'], number> = { cancel: 0, end: 1, start: 2, update: 3 };

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Proposal {
  instance: MachineInstance;
  event: GestureEvent;
  snapshot: ReturnType<MachineInstance['snapshot']>;
  events: GestureEvent[];
  trace: TraceEntry[];
}

export class Recognizer {
  private readonly machines: CompiledMachine[];
  private readonly tracker = new HandTracker();
  private readonly instances = new Map<string, MachineInstance>();
  private readonly graceMs: number;
  private traceLog: TraceEntry[] = [];

  constructor(machines: CompiledMachine[], opts: RecognizerOptions = {}) {
    this.machines = [...machines].sort((a, b) => byName(a.name, b.name));
    this.graceMs = opts.dropoutGraceMs ?? DEFAULT_GRACE_MS;
  }

  push(frame: Frame): GestureEvent[] {
    const tracked = this.tracker.track(frame);
    const byId = new Map<HandId, HandSample>(tracked.map((h) => [h.id, h.sample]));

    this.syncInstances(tracked);

    const emitted: GestureEvent[] = [];
    const proposals: Proposal[] = [];

    for (const inst of [...this.instances.values()]) {
      const bound: (HandSample | null)[] = inst.handIds.map((id) => byId.get(id) ?? null);

      if (bound.some((h) => h === null)) {
        const outcome = this.handleGap(inst, frame.t);
        if (outcome) emitted.push(outcome);
        continue;
      }
      inst.missingSinceT = null;

      const snapshot = inst.snapshot();
      const result = inst.step(frame.t, bound);
      if (result.proposedStart) {
        proposals.push({
          instance: inst,
          event: result.proposedStart,
          snapshot,
          events: result.events,
          trace: result.trace,
        });
      } else {
        emitted.push(...result.events);
        this.traceLog.push(...result.trace);
      }
    }

    emitted.push(...this.resolve(proposals, frame.t));

    if (this.traceLog.length > MAX_TRACE) this.traceLog = this.traceLog.slice(-MAX_TRACE);

    return emitted.sort(
      (a, b) =>
        a.t - b.t || PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || byName(a.gesture, b.gesture),
    );
  }

  trace(gesture?: string): TraceEntry[] {
    return gesture ? this.traceLog.filter((e) => e.gesture === gesture) : [...this.traceLog];
  }

  /**
   * Live state of every instance: which state it sits in, and every candidate
   * transition out of it with this frame's verdict. This is what makes "why did it
   * fire" answerable while it is still running, not only after the fact.
   */
  inspect(): InstanceView[] {
    return [...this.instances.values()]
      .map((i) => ({
        gesture: i.machine.name,
        priority: i.machine.priority,
        hands: [...i.handIds],
        state: i.machine.states[i.stateIndex]!.id,
        active: i.active,
        guards: i.guards,
      }))
      .sort((a, b) => byName(a.gesture, b.gesture) || (a.hands[0] ?? 0) - (b.hands[0] ?? 0));
  }

  // ---- instancing (SPEC §4.2) ----

  private syncInstances(tracked: TrackedHand[]): void {
    const ids = tracked.map((h) => h.id);

    for (const machine of this.machines) {
      if (machine.hands === 1) {
        for (const id of ids) {
          const key = `${machine.name}#${id}`;
          if (!this.instances.has(key)) this.instances.set(key, new MachineInstance(machine, [id]));
        }
        continue;
      }
      if (ids.length < 2) continue;
      const key = `${machine.name}#pair`;
      const existing = this.instances.get(key);
      if (!existing) {
        this.instances.set(key, new MachineInstance(machine, [ids[0]!, ids[1]!]));
      } else if (existing.isIdle) {
        // Sticky while in flight: only an idle instance may rebind to different hands.
        existing.handIds = [ids[0]!, ids[1]!];
      }
    }
  }

  // ---- dropout (SPEC §4.3) ----

  private handleGap(inst: MachineInstance, t: number): GestureEvent | null {
    inst.markGap();

    // Nothing in flight: no event. Drop the instance so a returning hand starts clean.
    if (inst.isIdle) {
      inst.reset();
      this.dropInstance(inst);
      return null;
    }

    if (inst.missingSinceT === null) inst.missingSinceT = t;
    if (t - inst.missingSinceT <= this.graceMs) return null; // hold state through the gap

    const wasActive = inst.active;
    const event = inst.makeCancel(t, 'tracking_lost');
    this.traceLog.push({
      gesture: inst.machine.name,
      t,
      from: inst.machine.states[inst.stateIndex]!.id,
      to: inst.machine.states[inst.machine.initial]!.id,
      firedGuard: `bound hand missing for more than ${this.graceMs}ms`,
      reason: 'tracking_lost',
      ...(wasActive ? { emitted: 'cancel' as const } : {}),
      handIds: [...inst.handIds],
    });
    inst.reset();
    this.dropInstance(inst);
    // A gesture that never started has nothing to cancel — resetting is enough.
    return wasActive ? event : null;
  }

  private dropInstance(inst: MachineInstance): void {
    for (const [key, value] of this.instances) {
      if (value === inst) { this.instances.delete(key); return; }
    }
  }

  // ---- competition (SPEC §5) ----

  private resolve(proposals: Proposal[], t: number): GestureEvent[] {
    if (proposals.length === 0) return [];

    const ranked = [...proposals].sort(
      (a, b) =>
        b.instance.machine.priority - a.instance.machine.priority ||
        b.event.confidence - a.event.confidence ||
        byName(a.instance.machine.name, b.instance.machine.name),
    );

    // Incumbents: active before this frame, so they hold a claim on their hands.
    const owner = new Map<HandId, MachineInstance>();
    for (const inst of this.instances.values()) {
      if (!inst.active || proposals.some((p) => p.instance === inst)) continue;
      for (const id of inst.handIds) owner.set(id, inst);
    }

    const freshOwned = new Set<HandId>();
    const out: GestureEvent[] = [];

    for (const p of ranked) {
      const claimed = p.instance.handIds;
      const clashesFresh = claimed.some((id) => freshOwned.has(id));
      const incumbents = [
        ...new Set(claimed.map((id) => owner.get(id)).filter((x): x is MachineInstance => !!x)),
      ];
      const blocked = incumbents.some((inc) => p.instance.machine.priority <= inc.machine.priority);

      if (clashesFresh || blocked) {
        p.instance.restore(p.snapshot); // loser rolls back silently, emits nothing
        continue;
      }

      for (const inc of incumbents) {
        out.push(inc.makeCancel(t, `preempted_by:${p.instance.machine.name}`));
        this.traceLog.push({
          gesture: inc.machine.name,
          t,
          from: inc.machine.states[inc.stateIndex]!.id,
          to: inc.machine.states[inc.machine.initial]!.id,
          firedGuard: `preempted by ${p.instance.machine.name} (priority ${p.instance.machine.priority} > ${inc.machine.priority})`,
          reason: `preempted_by:${p.instance.machine.name}`,
          emitted: 'cancel',
          handIds: [...inc.handIds],
        });
        inc.reset();
        for (const id of inc.handIds) owner.delete(id);
      }

      for (const id of claimed) freshOwned.add(id);
      out.push(...p.events);
      this.traceLog.push(...p.trace);
    }

    return out;
  }
}
