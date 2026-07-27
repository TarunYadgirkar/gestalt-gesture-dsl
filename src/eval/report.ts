import type { GestureMetrics, RegressionResult } from '../types.js';
import type { SessionScore } from './metrics.js';

export interface ReportInput {
  sessions: SessionScore[];
  metrics: GestureMetrics[];
  regression?: RegressionResult;
  title?: string;
  generatedAt?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const ms = (x: number | null): string => (x === null ? '—' : `${Math.round(x)}ms`);

const LANE_H = 26;
const ROW_H = 62;
const PAD_L = 132;
const W = 900;

function timeline(score: SessionScore): string {
  const gestures = [...new Set([
    ...score.labels.map((l) => l.gesture),
    ...score.matches.filter((m) => m.kind !== 'fn').map((m) => m.gesture),
  ])].sort();

  if (gestures.length === 0) return '<p class="empty">No labels or detections in this session.</p>';

  const dur = Math.max(1, score.durationMs);
  const plotW = W - PAD_L - 24;
  const x = (t: number): number => PAD_L + (t / dur) * plotW;
  const height = gestures.length * ROW_H + 34;

  const rows = gestures.map((g, i) => {
    const y = i * ROW_H + 24;
    const truths = score.labels.filter((l) => l.gesture === g);
    const preds = score.matches.filter((m) => m.gesture === g && m.kind !== 'fn');

    const gtBars = truths.map((t) => {
      const x0 = x(t.onset);
      const w = Math.max(3, x(t.offset) - x0);
      return `<rect class="gt" x="${x0.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${LANE_H - 12}" rx="3"><title>ground truth ${esc(g)}: ${Math.round(t.onset)}–${Math.round(t.offset)}ms</title></rect>`;
    }).join('');

    const missed = score.matches.filter((m) => m.gesture === g && m.kind === 'fn').map((m) => {
      const x0 = x(m.onset ?? 0);
      const w = Math.max(3, x(m.offset ?? 0) - x0);
      return `<rect class="fn" x="${x0.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${LANE_H - 12}" rx="3"><title>MISSED ${esc(g)} at ${Math.round(m.onset ?? 0)}ms</title></rect>`;
    }).join('');

    const py = y + LANE_H;
    const marks = preds.map((m) => {
      const px = x(m.predictedT ?? 0);
      const cls = m.kind === 'tp' ? 'tp' : 'fp';
      const label = m.kind === 'tp'
        ? `detected ${esc(g)} at ${Math.round(m.predictedT ?? 0)}ms (latency ${Math.round(m.latencyMs ?? 0)}ms, confidence ${(m.confidence ?? 0).toFixed(2)})`
        : `FALSE POSITIVE ${esc(g)} at ${Math.round(m.predictedT ?? 0)}ms`;
      return `<g class="${cls}"><line x1="${px.toFixed(1)}" y1="${py}" x2="${px.toFixed(1)}" y2="${py + LANE_H - 12}" /><circle cx="${px.toFixed(1)}" cy="${py}" r="4" /><title>${label}</title></g>`;
    }).join('');

    return `
      <text class="lane-label" x="${PAD_L - 12}" y="${y + 10}">${esc(g)}</text>
      <line class="axis" x1="${PAD_L}" y1="${y + LANE_H + 14}" x2="${W - 24}" y2="${y + LANE_H + 14}" />
      ${gtBars}${missed}${marks}`;
  }).join('');

  const ticks = Array.from({ length: 5 }, (_, i) => {
    const t = (dur / 4) * i;
    return `<text class="tick" x="${x(t).toFixed(1)}" y="${height - 6}">${Math.round(t)}ms</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${height}" class="timeline" role="img" aria-label="predicted versus ground truth timeline">
    <text class="lane-head" x="8" y="14">ground truth ▬ / predicted ●</text>
    ${rows}${ticks}
  </svg>`;
}

function metricsTable(rows: GestureMetrics[]): string {
  const body = rows.map((m) => {
    const warn = m.fp > 0 ? ' class="warn"' : '';
    return `<tr${warn}>
      <td class="g">${esc(m.gesture)}</td>
      <td>${m.tp}</td><td>${m.fp}</td><td>${m.fn}</td>
      <td>${pct(m.precision)}</td><td>${pct(m.recall)}</td>
      <td>${m.fpPerMin.toFixed(2)}</td><td>${ms(m.latencyMs)}</td>
    </tr>`;
  }).join('');
  return `<table class="metrics">
    <thead><tr><th>gesture</th><th>TP</th><th>FP</th><th>FN</th><th>precision</th><th>recall</th><th>FP/min</th><th>latency</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function regressionBlock(r: RegressionResult): string {
  const badge = r.pass ? '<span class="badge ok">PASS</span>' : '<span class="badge bad">FAIL</span>';
  const regressed = r.rows.filter((x) => x.regressed);
  const detail = regressed.length === 0
    ? '<p class="muted">No gesture regressed beyond tolerance.</p>'
    : `<table class="metrics"><thead><tr><th>gesture</th><th>metric</th><th>baseline</th><th>current</th><th>delta</th></tr></thead><tbody>${
        regressed.map((x) => `<tr class="warn"><td class="g">${esc(x.gesture)}</td><td>${esc(String(x.metric))}</td><td>${x.baseline.toFixed(3)}</td><td>${x.current.toFixed(3)}</td><td>${x.delta >= 0 ? '+' : ''}${x.delta.toFixed(3)}</td></tr>`).join('')
      }</tbody></table>`;
  return `<section><h2>Regression vs baseline ${badge}</h2>${detail}</section>`;
}

export function renderReport(input: ReportInput): string {
  const { sessions, metrics, regression } = input;
  const title = input.title ?? 'Gestalt evaluation report';
  const totalFp = metrics.reduce((n, m) => n + m.fp, 0);
  const totalTp = metrics.reduce((n, m) => n + m.tp, 0);
  const totalFn = metrics.reduce((n, m) => n + m.fn, 0);

  const sessionBlocks = sessions.map((s) => `
    <section class="session">
      <h3>${esc(s.session)} <span class="muted">${Math.round(s.durationMs)}ms · ${s.events.length} events</span></h3>
      ${timeline(s)}
      ${metricsTable(s.metrics.filter((m) => m.tp + m.fp + m.fn > 0))}
    </section>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #14171c; --line: #232830; --text: #e6e9ef; --muted: #8b93a1;
    --gt: #3d5a80; --tp: #43d17c; --fp: #ff5d5d; --fn: #ffa53d; --accent: #7aa2f7;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f7f8fa; --panel: #fff; --line: #e3e6ec; --text: #14171c; --muted: #5d6470;
            --gt: #9db8d8; --tp: #1f9d55; --fp: #d92d2d; --fn: #c4761a; --accent: #2c5fd4; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 64px; background: var(--bg); color: var(--text);
         font: 14px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 16px; margin: 32px 0 12px; letter-spacing: -0.01em; }
  h3 { font-size: 14px; margin: 0 0 10px; font-weight: 600; }
  .muted { color: var(--muted); font-weight: 400; }
  .summary { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0 8px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 10px 14px; min-width: 96px; }
  .stat b { display: block; font-size: 20px; letter-spacing: -0.02em; }
  .stat span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  section.session { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
                    padding: 16px; margin: 14px 0; }
  .timeline { width: 100%; height: auto; display: block; margin: 4px 0 12px; }
  .timeline .gt { fill: var(--gt); }
  .timeline .fn { fill: none; stroke: var(--fn); stroke-width: 2; stroke-dasharray: 4 3; }
  .timeline .tp line { stroke: var(--tp); stroke-width: 2; }
  .timeline .tp circle { fill: var(--tp); }
  .timeline .fp line { stroke: var(--fp); stroke-width: 2; }
  .timeline .fp circle { fill: var(--fp); }
  .timeline .axis { stroke: var(--line); stroke-width: 1; }
  .timeline .lane-label { fill: var(--text); font-size: 11px; text-anchor: end; }
  .timeline .lane-head, .timeline .tick { fill: var(--muted); font-size: 10px; }
  .timeline .tick { text-anchor: middle; }
  table.metrics { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  table.metrics th { text-align: right; font-size: 11px; color: var(--muted); font-weight: 500;
                     text-transform: uppercase; letter-spacing: .05em; padding: 6px 8px;
                     border-bottom: 1px solid var(--line); }
  table.metrics td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  table.metrics th:first-child, table.metrics td.g { text-align: left; }
  table.metrics td.g { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  tr.warn td { background: color-mix(in srgb, var(--fp) 10%, transparent); }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; vertical-align: middle;
           font-weight: 600; letter-spacing: .04em; }
  .badge.ok { background: var(--tp); color: #04120a; }
  .badge.bad { background: var(--fp); color: #fff; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin: 8px 0 0; }
  .key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .empty { color: var(--muted); font-style: italic; }
  @media (max-width: 640px) { body { padding: 20px 12px 48px; } .stat { flex: 1 1 40%; } }
</style></head>
<body><div class="wrap">
  <h1>${esc(title)}</h1>
  <p class="muted">Predicted gesture events against labeled ground truth${input.generatedAt ? ` · ${esc(input.generatedAt)}` : ''}</p>

  <div class="summary">
    <div class="stat"><b>${totalTp}</b><span>true positives</span></div>
    <div class="stat"><b>${totalFp}</b><span>false positives</span></div>
    <div class="stat"><b>${totalFn}</b><span>missed</span></div>
    <div class="stat"><b>${sessions.length}</b><span>sessions</span></div>
  </div>
  <p class="legend">
    <span><i class="key" style="background:var(--gt)"></i>ground truth</span>
    <span><i class="key" style="background:var(--tp)"></i>correct detection</span>
    <span><i class="key" style="background:var(--fp)"></i>false positive</span>
    <span><i class="key" style="background:var(--fn)"></i>missed</span>
  </p>

  ${regression ? regressionBlock(regression) : ''}

  <h2>Aggregate metrics</h2>
  ${metricsTable(metrics)}

  <h2>Sessions</h2>
  ${sessionBlocks}
</div></body></html>`;
}
