import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { TurnDurations, TurnMark } from './turn-timeline.js';
import { DURATION_KEYS } from './turn-timeline.js';

export type TurnOutcome = 'completed' | 'interrupted' | 'cancelled' | 'error';

export interface TurnSummary {
  session_id: string;
  turn_id: string;
  tenant_id: string;
  kind: 'user' | 'greeting';
  outcome: TurnOutcome;
  reason?: string;
  marks_ms: Partial<Record<TurnMark, number>>;
  durations_ms: TurnDurations;
  transport_rtt_ms?: number;
  user_chars: number;
  assistant_chars_sent: number;
  assistant_chars_heard?: number;
  heard_text_estimated?: boolean;
  false_interruptions: number;
  /** Tool-using turns: model rounds, and each tool call's name, outcome status and duration. */
  llm_rounds?: number;
  tool_calls?: { name: string; outcome: string; ms: number }[];
  error?: { error_name: string; error_kind?: string; provider?: string; message: string };
  user_text?: string;
  assistant_text?: string;
}

export interface TurnSummarySink {
  write(summary: TurnSummary): void;
  close(): Promise<void>;
}

export class JsonlTurnSink implements TurnSummarySink {
  private readonly stream: WriteStream;

  constructor(logDir: string, date = new Date()) {
    mkdirSync(logDir, { recursive: true });
    const day = date.toISOString().slice(0, 10);
    this.stream = createWriteStream(join(logDir, `turns-${day}.jsonl`), { flags: 'a' });
  }

  write(summary: TurnSummary): void {
    this.stream.write(`${JSON.stringify(summary)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

export class MemoryTurnSink implements TurnSummarySink {
  readonly summaries: TurnSummary[] = [];

  write(summary: TurnSummary): void {
    this.summaries.push(summary);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface PercentileRow {
  metric: keyof TurnDurations;
  count: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
}

/** Distribution per duration metric (nearest-rank percentiles). */
export function latencyPercentiles(summaries: readonly Pick<TurnSummary, 'durations_ms'>[]): PercentileRow[] {
  const rows: PercentileRow[] = [];
  for (const metric of DURATION_KEYS) {
    const values = summaries
      .map((s) => s.durations_ms[metric])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (values.length === 0) continue;
    rows.push({
      metric,
      count: values.length,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      p95: percentile(values, 95),
      max: values[values.length - 1] ?? 0,
    });
  }
  return rows;
}

function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}
