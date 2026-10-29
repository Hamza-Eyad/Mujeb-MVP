import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type PercentileRow, type TurnSummary, latencyPercentiles } from '../observability/turn-metrics.js';

export interface TurnStats {
  turns: number;
  byOutcome: Record<string, number>;
  falseInterruptions: number;
  rows: PercentileRow[];
}

export interface LatencyReport extends TurnStats {
  files: string[];
  /** The same figures per channel (`phone`, `browser`), and `unknown` for turns logged before the field existed. */
  byChannel: Record<string, TurnStats>;
}

const UNKNOWN_CHANNEL = 'unknown';
const CHANNEL_ORDER = ['phone', 'browser', UNKNOWN_CHANNEL];

export function summarizeTurns(summaries: readonly TurnSummary[]): TurnStats {
  const byOutcome: Record<string, number> = {};
  let falseInterruptions = 0;
  for (const s of summaries) {
    byOutcome[s.outcome] = (byOutcome[s.outcome] ?? 0) + 1;
    falseInterruptions += s.false_interruptions;
  }
  return { turns: summaries.length, byOutcome, falseInterruptions, rows: latencyPercentiles(summaries) };
}

export async function buildLatencyReport(logDir: string, options: { since?: string } = {}): Promise<LatencyReport> {
  let names: string[];
  try {
    names = (await readdir(logDir)).filter((n) => /^turns-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    names = [];
  }
  if (options.since) names = names.filter((n) => n.slice(6, 16) >= (options.since ?? ''));
  const summaries: TurnSummary[] = [];
  for (const name of names) {
    const text = await readFile(join(logDir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        summaries.push(JSON.parse(line) as TurnSummary);
      } catch {
        /* skip a partially written line */
      }
    }
  }
  const groups = new Map<string, TurnSummary[]>();
  for (const s of summaries) {
    const channel = s.channel ?? UNKNOWN_CHANNEL;
    const group = groups.get(channel);
    if (group) group.push(s);
    else groups.set(channel, [s]);
  }
  const channels = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const byChannel = Object.fromEntries(channels.map((c) => [c, summarizeTurns(groups.get(c) ?? [])]));
  return { files: names, ...summarizeTurns(summaries), byChannel };
}

export function formatLatencyReport(report: LatencyReport): string {
  const channels = Object.entries(report.byChannel);
  const lines = [
    `files: ${report.files.length > 0 ? report.files.join(', ') : '(none)'}`,
    `channels: ${channels.length > 0 ? channels.map(([c, s]) => `${c} ${s.turns}`).join(', ') : '(none)'}`,
    ...formatStats(report),
  ];
  // With turns from more than one channel, each gets its own table: phone and browser latency differ.
  if (channels.length > 1) {
    for (const [channel, stats] of channels) lines.push('', `── channel: ${channel}`, ...formatStats(stats));
  }
  return lines.join('\n');
}

function formatStats(stats: TurnStats): string[] {
  const lines = [
    `turns: ${stats.turns}  outcomes: ${JSON.stringify(stats.byOutcome)}  false interruptions: ${stats.falseInterruptions}`,
    '',
    `${'metric'.padEnd(30)}${'n'.padStart(6)}${'p50'.padStart(8)}${'p90'.padStart(8)}${'p95'.padStart(8)}${'max'.padStart(8)}`,
  ];
  for (const r of stats.rows) {
    lines.push(`${r.metric.padEnd(30)}${String(r.count).padStart(6)}${fmt(r.p50)}${fmt(r.p90)}${fmt(r.p95)}${fmt(r.max)}`);
  }
  if (stats.rows.length === 0) lines.push('(no timed turns yet)');
  return lines;
}

function rank(channel: string): number {
  const i = CHANNEL_ORDER.indexOf(channel);
  return i === -1 ? CHANNEL_ORDER.length : i;
}

function fmt(ms: number): string {
  return String(Math.round(ms)).padStart(8);
}
