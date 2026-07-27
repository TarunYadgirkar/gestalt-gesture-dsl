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

export class Inspector {
  private readonly cards = new Map<string, HTMLElement>();
  private readonly open = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly machines: CompiledMachine[],
  ) {
    // Pinch starts expanded so the guard readout is visible without a click.
    this.open.add('pinch');
    this.build();
  }

  private build(): void {
    this.root.textContent = '';
    for (const m of [...this.machines].sort((a, b) => b.priority - a.priority)) {
      const card = el('div', 'machine');
      card.dataset.gesture = m.name;

      const head = el('div', 'machine-head');
      head.append(
        el('span', 'machine-name', m.name),
        el('span', 'machine-prio', `p${m.priority}`),
        el('span', 'machine-state', 'idle'),
      );
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-expanded', String(this.open.has(m.name)));

      const toggle = (): void => {
        if (this.open.has(m.name)) this.open.delete(m.name);
        else this.open.add(m.name);
        card.classList.toggle('open', this.open.has(m.name));
        head.setAttribute('aria-expanded', String(this.open.has(m.name)));
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });

      const chain = el('div', 'chain');
      const d = m.describe();
      d.states.forEach((s, i) => {
        if (i > 0) chain.append(el('span', 'edge'));
        const node = el('span', `node${s.accept ? ' accept' : ''}`, s.id);
        node.dataset.state = s.id;
        chain.append(node);
      });

      const guards = el('div', 'guards');

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

    for (const [name, card] of this.cards) {
      const v = best.get(name);
      const stateEl = card.querySelector('.machine-state')!;
      const initial = this.machines.find((m) => m.name === name)!.describe().initial;
      const state = v?.state ?? initial;

      stateEl.textContent = state;
      card.classList.toggle('firing', v?.active === true);
      card.classList.toggle('armed', !!v && !v.active && state !== initial);

      for (const node of card.querySelectorAll<HTMLElement>('.node')) {
        node.classList.toggle('current', node.dataset.state === state);
      }

      this.renderGuards(card.querySelector('.guards')!, v);
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
      row.append(el('span', 'tick', g.passed ? '✓' : '·'));
      row.append(el('span', 'expr', g.guard));
      const dwell = g.minHoldMs > 0 ? ` ${Math.min(g.heldMs, g.minHoldMs) | 0}/${g.minHoldMs}ms` : '';
      row.append(el('span', 'to', `→ ${g.to}${dwell}`));
      if (g.reason) row.title = g.reason;
      host.append(row);
    }
  }
}
