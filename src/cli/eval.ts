#!/usr/bin/env -S npx tsx
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadGestureLibrary } from '../dsl/library.js';
import {
  aggregate, scoreSession, compareToBaseline, DEFAULT_TOLERANCES, formatRegression, renderReport,
} from '../eval/index.js';
import { BASELINE_PATH, evalCorpus } from '../eval/fixtures.js';
import type { GestureMetrics } from '../types.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'run';
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const machines = loadGestureLibrary();
const corpus = evalCorpus();
const scores = corpus.map((s) => scoreSession(machines, s));
const metrics = aggregate(scores);

const table = (rows: GestureMetrics[]): string => {
  const head = ['gesture', 'TP', 'FP', 'FN', 'prec', 'recall', 'FP/min', 'latency'];
  const body = rows.map((m) => [
    m.gesture,
    String(m.tp), String(m.fp), String(m.fn),
    m.precision.toFixed(3), m.recall.toFixed(3),
    m.fpPerMin.toFixed(2),
    m.latencyMs === null ? '—' : `${Math.round(m.latencyMs)}ms`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  return [line(head), widths.map((w) => '─'.repeat(w)).join('  '), ...body.map(line)].join('\n');
};

const writeOut = (path: string, content: string): void => {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), content);
};

if (command === 'run') {
  process.stdout.write(`${corpus.length} sessions · ${machines.length} gestures\n\n${table(metrics)}\n`);
  process.exit(0);
}

if (command === 'report') {
  const out = value('out') ?? 'report-out/index.html';
  const baseline = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { metrics: GestureMetrics[] }).metrics
    : undefined;
  const html = renderReport({
    sessions: scores,
    metrics,
    ...(baseline ? { regression: compareToBaseline(metrics, baseline, DEFAULT_TOLERANCES) } : {}),
    generatedAt: new Date().toISOString(),
  });
  writeOut(out, html);
  process.stdout.write(`report written to ${out}\n`);
  process.exit(0);
}

if (command === 'regression') {
  if (flag('update-baseline')) {
    writeOut(BASELINE_PATH, `${JSON.stringify({ metrics, sessions: corpus.length }, null, 2)}\n`);
    process.stdout.write(`baseline updated (${metrics.length} gestures, ${corpus.length} sessions)\n`);
    process.exit(0);
  }
  if (!existsSync(BASELINE_PATH)) {
    process.stderr.write(`no baseline at ${BASELINE_PATH}; run: npm run regression -- --update-baseline\n`);
    process.exit(2);
  }
  const baseline = (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { metrics: GestureMetrics[] }).metrics;
  const result = compareToBaseline(metrics, baseline, DEFAULT_TOLERANCES);
  process.stdout.write(`${table(metrics)}\n\n${formatRegression(result)}\n`);
  process.exit(result.pass ? 0 : 1);
}

process.stderr.write(`unknown command '${command}'\n\nusage:\n  eval run\n  eval report [--out path.html]\n  eval regression [--update-baseline]\n`);
process.exit(2);
