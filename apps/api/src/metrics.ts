/**
 * In-process metrics rendered in Prometheus text format at GET /metrics.
 * Labels must be low-cardinality (result, provider, type) and never contain user data.
 */

type Labels = Record<string, string>;

const counters = new Map<string, Map<string, number>>();
const gauges = new Map<string, Map<string, number>>();
const histograms = new Map<string, Map<string, { buckets: number[]; counts: number[]; sum: number; count: number }>>();
const help = new Map<string, string>();

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function key(labels: Labels = {}): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`)
    .join(',');
}

export function describe(name: string, text: string): void {
  help.set(name, text);
}

export function inc(name: string, labels?: Labels, by = 1): void {
  const series = counters.get(name) ?? new Map<string, number>();
  const k = key(labels);
  series.set(k, (series.get(k) ?? 0) + by);
  counters.set(name, series);
}

export function setGauge(name: string, value: number, labels?: Labels): void {
  const series = gauges.get(name) ?? new Map<string, number>();
  series.set(key(labels), value);
  gauges.set(name, series);
}

export function observe(name: string, value: number, labels?: Labels, buckets = DEFAULT_BUCKETS): void {
  const series = histograms.get(name) ?? new Map();
  const k = key(labels);
  const h = series.get(k) ?? { buckets, counts: buckets.map(() => 0), sum: 0, count: 0 };
  h.buckets.forEach((b: number, i: number) => {
    if (value <= b) h.counts[i] = (h.counts[i] ?? 0) + 1;
  });
  h.sum += value;
  h.count++;
  series.set(k, h);
  histograms.set(name, series);
}

/** Times an async operation into a histogram (seconds). */
export async function timed<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    observe(name, (performance.now() - start) / 1000, labels);
  }
}

export function counterValue(name: string, labels?: Labels): number {
  return counters.get(name)?.get(key(labels)) ?? 0;
}

export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

export function renderPrometheus(): string {
  const lines: string[] = [];
  const header = (name: string, type: string) => {
    if (help.has(name)) lines.push(`# HELP ${name} ${help.get(name)}`);
    lines.push(`# TYPE ${name} ${type}`);
  };
  const series = (name: string, k: string, v: number) => lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
  for (const [name, s] of counters) {
    header(name, 'counter');
    for (const [k, v] of s) series(name, k, v);
  }
  for (const [name, s] of gauges) {
    header(name, 'gauge');
    for (const [k, v] of s) series(name, k, v);
  }
  for (const [name, s] of histograms) {
    header(name, 'histogram');
    for (const [k, h] of s) {
      h.buckets.forEach((b, i) => series(`${name}_bucket`, [k, `le="${b}"`].filter(Boolean).join(','), h.counts[i] ?? 0));
      series(`${name}_bucket`, [k, 'le="+Inf"'].filter(Boolean).join(','), h.count);
      series(`${name}_sum`, k, h.sum);
      series(`${name}_count`, k, h.count);
    }
  }
  return `${lines.join('\n')}\n`;
}

describe('sync_runs_total', 'User syncs by result');
describe('sync_connection_errors_total', 'Connection pulls that failed, by provider');
describe('sync_duration_seconds', 'Duration of a full user sync');
describe('detection_events_total', 'Reconciliation events by type (new_item, trial_converted, price_increase, ...)');
describe('email_signals_total', 'Emails turned into signals, by extractor and kind');
describe('alerts_scheduled_total', 'Alerts written to the outbox, by type');
describe('alerts_delivered_total', 'Alert delivery attempts, by channel and result');
describe('http_requests_total', 'HTTP requests by route and status class');
describe('http_request_duration_seconds', 'HTTP request latency by route');
describe('rate_limited_total', 'Requests rejected by the rate limiter, by bucket');
