import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LevelStats } from '../observability/level-histogram.js';
import { type PercentileRow, type TurnSummary, latencyPercentiles, percentile } from '../observability/turn-metrics.js';

export interface TurnStats {
  turns: number;
  byOutcome: Record<string, number>;
  falseInterruptions: number;
  rows: PercentileRow[];
  bargeIn: BargeInTotals;
  line: LineTotals;
}

/** Sums of the turns' `barge_in` counts (turns logged before 2026-11-02 have none). */
export interface BargeInTotals {
  /** Turns in which VAD or STT heard the caller while Mujeeb spoke. */
  turns: number;
  /** Of those, turns where VAD fired but no transcript came: noise, echo, or speech the STT missed. */
  vadOnlyTurns: number;
  vadStarts: number;
  transcripts: number;
  ignored: { echo: number; backchannel: number; empty: number };
  candidates: number;
  /** Interrupted turns by words in the first transcript of the interrupting speech ('1', '2', '3+'). */
  firstWords: Record<string, number>;
}

/** The turns' `line` levels and VAD segments (turns logged before 2026-11-03 have none). */
export interface LineTotals {
  /** Each turn's percentiles, then the median of each across turns (max: the highest). dBFS. */
  playing?: LevelTotals;
  quiet?: LevelTotals;
  /** Median of the VAD's speech threshold at the turns' ends. */
  thresholdDb?: number;
  /** VAD segments that began while Mujeeb spoke, by length: in turns that ended normally, and in interrupted turns. */
  segments: { completed: Record<SegmentBucket, number>; interrupted: Record<SegmentBucket, number> };
  /** How long the sound rose above the noise floor before each of those segments crossed the threshold. */
  leadMs?: { count: number; p50: number; p90: number; max: number };
}

export interface LevelTotals {
  turns: number;
  p10_db: number;
  p50_db: number;
  p90_db: number;
  max_db: number;
}

export type SegmentBucket = '<300' | '300-600' | '600-1000' | '1000+';

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
  const bargeIn: BargeInTotals = { turns: 0, vadOnlyTurns: 0, vadStarts: 0, transcripts: 0, ignored: { echo: 0, backchannel: 0, empty: 0 }, candidates: 0, firstWords: {} };
  for (const s of summaries) {
    byOutcome[s.outcome] = (byOutcome[s.outcome] ?? 0) + 1;
    falseInterruptions += s.false_interruptions;
    const b = s.barge_in;
    if (!b) continue;
    bargeIn.turns += 1;
    if (b.vad_starts > 0 && b.transcripts === 0) bargeIn.vadOnlyTurns += 1;
    bargeIn.vadStarts += b.vad_starts;
    bargeIn.transcripts += b.transcripts;
    bargeIn.ignored.echo += b.ignored.echo;
    bargeIn.ignored.backchannel += b.ignored.backchannel;
    bargeIn.ignored.empty += b.ignored.empty;
    bargeIn.candidates += b.candidates;
    if (b.first_words !== undefined) {
      const key = b.first_words >= 3 ? '3+' : String(b.first_words);
      bargeIn.firstWords[key] = (bargeIn.firstWords[key] ?? 0) + 1;
    }
  }
  return { turns: summaries.length, byOutcome, falseInterruptions, rows: latencyPercentiles(summaries), bargeIn, line: summarizeLine(summaries) };
}

function summarizeLine(summaries: readonly TurnSummary[]): LineTotals {
  const segments = { completed: emptyBuckets(), interrupted: emptyBuckets() };
  const leads: number[] = [];
  for (const s of summaries) {
    const buckets = s.outcome === 'completed' ? segments.completed : s.outcome === 'interrupted' ? segments.interrupted : undefined;
    for (const segment of s.barge_in?.vad_segments ?? []) {
      leads.push(segment.lead_ms);
      if (buckets) buckets[segmentBucket(segment.ms)] += 1;
    }
  }
  leads.sort((a, b) => a - b);
  const thresholds = summaries.flatMap((s) => (s.line ? [s.line.threshold_db] : [])).sort((a, b) => a - b);
  const playing = levelTotals(summaries.flatMap((s) => (s.line?.playing ? [s.line.playing] : [])));
  const quiet = levelTotals(summaries.flatMap((s) => (s.line?.quiet ? [s.line.quiet] : [])));
  return {
    ...(playing ? { playing } : {}),
    ...(quiet ? { quiet } : {}),
    ...(thresholds.length > 0 ? { thresholdDb: percentile(thresholds, 50) } : {}),
    segments,
    ...(leads.length > 0 ? { leadMs: { count: leads.length, p50: percentile(leads, 50), p90: percentile(leads, 90), max: leads[leads.length - 1] ?? 0 } } : {}),
  };
}

function levelTotals(stats: readonly LevelStats[]): LevelTotals | undefined {
  if (stats.length === 0) return undefined;
  const median = (pick: (s: LevelStats) => number): number => percentile(stats.map(pick).sort((a, b) => a - b), 50);
  return {
    turns: stats.length,
    p10_db: median((s) => s.p10_db),
    p50_db: median((s) => s.p50_db),
    p90_db: median((s) => s.p90_db),
    max_db: Math.max(...stats.map((s) => s.max_db)),
  };
}

function emptyBuckets(): Record<SegmentBucket, number> {
  return { '<300': 0, '300-600': 0, '600-1000': 0, '1000+': 0 };
}

function segmentBucket(ms: number): SegmentBucket {
  if (ms < 300) return '<300';
  if (ms < 600) return '300-600';
  if (ms < 1000) return '600-1000';
  return '1000+';
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
  const b = stats.bargeIn;
  if (b.turns > 0) {
    lines.push(
      '',
      `heard while speaking: turns ${b.turns} (VAD only ${b.vadOnlyTurns})  VAD starts ${b.vadStarts}  transcripts ${b.transcripts}  ` +
        `ignored echo ${b.ignored.echo} / backchannel ${b.ignored.backchannel} / empty ${b.ignored.empty}  candidates ${b.candidates}`,
    );
    const words = Object.entries(b.firstWords).sort(([x], [y]) => x.localeCompare(y));
    if (words.length > 0) lines.push(`first words of interrupting speech: ${words.map(([k, n]) => `${k}×${n}`).join(', ')}`);
  }
  lines.push(...formatLine(stats.line));
  return lines;
}

function formatLine(line: LineTotals): string[] {
  const lines: string[] = [];
  const level = (name: string, l: LevelTotals | undefined): void => {
    if (l) lines.push(`line level ${name} (dBFS, median of ${l.turns} turns): p10 ${l.p10_db}  p50 ${l.p50_db}  p90 ${l.p90_db}  max ${l.max_db}`);
  };
  level('while Mujeeb played', line.playing);
  level('while Mujeeb was quiet', line.quiet);
  if (line.thresholdDb !== undefined) lines.push(`VAD threshold (median): ${line.thresholdDb} dBFS`);
  const buckets = (b: Record<SegmentBucket, number>): string => Object.entries(b).map(([k, n]) => `${k}ms ${n}`).join(' · ');
  const counted = (b: Record<SegmentBucket, number>): number => Object.values(b).reduce((sum, n) => sum + n, 0);
  if (counted(line.segments.completed) + counted(line.segments.interrupted) > 0) {
    lines.push(`VAD segments while Mujeeb played, not interrupted: ${buckets(line.segments.completed)}`);
    lines.push(`VAD segments while Mujeeb played, interrupted turns: ${buckets(line.segments.interrupted)}`);
  }
  if (line.leadMs) lines.push(`VAD onset lead: n ${line.leadMs.count}  p50 ${line.leadMs.p50}  p90 ${line.leadMs.p90}  max ${line.leadMs.max} ms`);
  return lines.length > 0 ? ['', ...lines] : [];
}

function rank(channel: string): number {
  const i = CHANNEL_ORDER.indexOf(channel);
  return i === -1 ? CHANNEL_ORDER.length : i;
}

function fmt(ms: number): string {
  return String(Math.round(ms)).padStart(8);
}
