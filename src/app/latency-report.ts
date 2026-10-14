import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type PercentileRow, type TurnSummary, latencyPercentiles } from '../observability/turn-metrics.js';

export interface LatencyReport {
  files: string[];
  turns: number;
  byOutcome: Record<string, number>;
  falseInterruptions: number;
  rows: PercentileRow[];
}

export function summarizeTurns(summaries: readonly TurnSummary[]): Omit<LatencyReport, 'files'> {
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
  return { files: names, ...summarizeTurns(summaries) };
}

export function formatLatencyReport(report: LatencyReport): string {
  const lines = [
    `files: ${report.files.length > 0 ? report.files.join(', ') : '(none)'}`,
    `turns: ${report.turns}  outcomes: ${JSON.stringify(report.byOutcome)}  false interruptions: ${report.falseInterruptions}`,
    '',
    `${'metric'.padEnd(30)}${'n'.padStart(6)}${'p50'.padStart(8)}${'p90'.padStart(8)}${'p95'.padStart(8)}${'max'.padStart(8)}`,
  ];
  for (const r of report.rows) {
    lines.push(`${r.metric.padEnd(30)}${String(r.count).padStart(6)}${fmt(r.p50)}${fmt(r.p90)}${fmt(r.p95)}${fmt(r.max)}`);
  }
  if (report.rows.length === 0) lines.push('(no timed turns yet)');
  return lines.join('\n');
}

function fmt(ms: number): string {
  return String(Math.round(ms)).padStart(8);
}
