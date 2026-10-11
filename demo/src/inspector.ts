import type { CompiledMachine } from '../../src/browser.js';
import type { InstanceView } from '../../src/runtime/recognizer.js';

// The state machine inspector — the thing this project exists to make possible.
// Each card shows the run of states with the current one lit, and, expanded, every
// candidate transition out of that state with its live verdict and threshold.

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const CARET =
  '<svg class="machine-caret" viewBox="0 0 256 256" aria-hidden="true"><path d="m181.7 133.7-80 80a8 8 0 0 1-11.4-11.4l74.4-74.3-74.4-74.3a8 8 0 0 1 11.4-11.4l80 80a8 8 0 0 1 0 11.4Z"/></svg>';

export class Inspector {
  private readonly cards = new Map<string, HTMLElement>();
  private readonly initialState = new Map<string, string>();
  private latest = new Map<string, InstanceView>();
  private readonly open = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly machines: CompiledMachine[],
  ) {
    this.build();
  }

  expand(name: string): void {
    if (this.open.has(name)) return;
    this.toggle(name);
  }

  private toggle(name: string): void {
    const card = this.cards.get(name);
    if (!card) return;
    if (this.open.has(name)) this.open.delete(name);
    else this.open.add(name);
    const isOpen = this.open.has(name);
    card.classList.toggle('open', isOpen);
    card.querySelector('.machine-head')?.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) this.renderGuards(card.querySelector('.guards')!, this.latest.get(name));
  }

  private build(): void {
    this.root.textContent = '';
    for (const m of [...this.machines].sort((a, b) => b.priority - a.priority)) {
      const card = el('div', 'machine');
      card.dataset.gesture = m.name;

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'machine-head';
      head.setAttribute('aria-expanded', String(this.open.has(m.name)));
      head.setAttribute('aria-controls', `guards-${m.name}`);
      head.insertAdjacentHTML('beforeend', CARET);
      head.append(
        el('span', 'machine-name', m.name),
        el('span', 'machine-prio', `p${m.priority}`),
        el('span', 'machine-state', 'idle'),
      );
      head.addEventListener('click', () => this.toggle(m.name));

      const chain = el('div', 'chain');
      const d = m.describe();
      this.initialState.set(m.name, d.initial);
      d.states.forEach((s, i) => {
        if (i > 0) chain.append(el('span', 'edge'));
        const node = el('span', `node${s.accept ? ' accept' : ''}`, s.id);
        node.dataset.state = s.id;
        chain.append(node);
      });

      const guards = el('div', 'guards');
      guards.id = `guards-${m.name}`;

      card.classList.toggle('open', this.open.has(m.name));
      card.append(head, chain, guards);
      this.root.append(card);
      this.cards.set(m.name, card);
    }
  }

  update(views: InstanceView[]): void {
    // One card per gesture; with two hands the more advanced instance is the
    // interesting one, so it wins the display.
    const best = new Map<string, InstanceView>();
    for (const v of views) {
      const prev = best.get(v.gesture);
      const rank = (x: InstanceView): number => (x.active ? 2 : x.guards.some((g) => g.passed) ? 1 : 0);
      if (!prev || rank(v) > rank(prev)) best.set(v.gesture, v);
    }

    this.latest = best;
    for (const [name, card] of this.cards) {
      const v = best.get(name);
      const stateEl = card.querySelector('.machine-state')!;
      const initial = this.initialState.get(name)!;
      const state = v?.state ?? initial;

      stateEl.textContent = state;
      card.classList.toggle('firing', v?.active === true);
      card.classList.toggle('armed', !!v && !v.active && state !== initial);

      for (const node of card.querySelectorAll<HTMLElement>('.node')) {
        node.classList.toggle('current', node.dataset.state === state);
      }

      if (this.open.has(name)) this.renderGuards(card.querySelector('.guards')!, v);
    }
  }

  private renderGuards(host: Element, v: InstanceView | undefined): void {
    if (!v || v.guards.length === 0) {
      if (host.textContent !== 'waiting for a tracked hand') {
        host.textContent = '';
        host.append(el('div', 'guard', 'waiting for a tracked hand'));
      }
      return;
    }

    host.textContent = '';
    for (const g of v.guards) {
      const row = el('div', `guard${g.passed ? ' pass' : ''}`);
      const tick = el('span', 'tick', g.passed ? '✓' : '·');
      tick.setAttribute('aria-hidden', 'true');
      row.append(tick, el('span', 'sr-only', g.passed ? 'true: ' : 'false: '));
      row.append(el('span', 'expr', g.guard));
      const dwell = g.minHoldMs > 0 ? ` ${Math.min(g.heldMs, g.minHoldMs) | 0}/${g.minHoldMs}ms` : '';
      row.append(el('span', 'to', `→ ${g.to}${dwell}`));
      if (g.reason) row.title = g.reason;
      host.append(row);
    }
  }
}
