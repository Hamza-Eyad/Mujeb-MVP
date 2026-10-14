/**
 * Per-turn monotonic timeline. Marks are first-write-wins unless `overwrite` is requested
 * (e.g. the user's speech end moves forward while they keep talking).
 */

export const TURN_MARKS = [
  'user_speech_start',
  'user_speech_end',
  'stt_first_partial',
  'stt_committed',
  'llm_request',
  'llm_first_token',
  'llm_done',
  'tts_first_text',
  'tts_first_audio',
  'playback_start',
  'playback_end',
  'barge_in_speech_start',
  'barge_in_candidate',
  'interrupt_requested',
  'playback_stopped',
  'error',
] as const;

export type TurnMark = (typeof TURN_MARKS)[number];

export interface TurnDurations {
  stt_finalize_ms?: number;
  llm_ttft_ms?: number;
  llm_total_ms?: number;
  tts_ttfb_ms?: number;
  first_audio_after_commit_ms?: number;
  playback_buffer_ms?: number;
  e2e_ms?: number;
  barge_in_reaction_ms?: number;
  interrupt_stop_ms?: number;
  /** Sum of tool execution times in a tool-using turn (set by the session, not derived from marks). */
  tools_ms?: number;
}

export const DURATION_KEYS: readonly (keyof TurnDurations)[] = [
  'stt_finalize_ms',
  'llm_ttft_ms',
  'llm_total_ms',
  'tts_ttfb_ms',
  'first_audio_after_commit_ms',
  'playback_buffer_ms',
  'e2e_ms',
  'barge_in_reaction_ms',
  'interrupt_stop_ms',
  'tools_ms',
];

export type MarkListener = (timeline: TurnTimeline, name: TurnMark, at: number) => void;

export class TurnTimeline {
  /** Set once the timeline belongs to a turn (marks recorded before that have no turn yet). */
  turnId: string | null = null;
  private readonly marks = new Map<TurnMark, number>();
  private readonly now: () => number;
  private readonly onMark: MarkListener | undefined;

  constructor(now: () => number, onMark?: MarkListener) {
    this.now = now;
    this.onMark = onMark;
  }

  mark(name: TurnMark, options?: { at?: number; overwrite?: boolean }): void {
    if (this.marks.has(name) && !options?.overwrite) return;
    const at = options?.at ?? this.now();
    this.marks.set(name, at);
    this.onMark?.(this, name, at);
  }

  has(name: TurnMark): boolean {
    return this.marks.has(name);
  }

  get(name: TurnMark): number | undefined {
    return this.marks.get(name);
  }

  durations(): TurnDurations {
    const span = (from: TurnMark, to: TurnMark): number | undefined => {
      const a = this.marks.get(from);
      const b = this.marks.get(to);
      return a === undefined || b === undefined ? undefined : round(b - a);
    };
    const result: TurnDurations = {
      stt_finalize_ms: span('user_speech_end', 'stt_committed'),
      llm_ttft_ms: span('llm_request', 'llm_first_token'),
      llm_total_ms: span('llm_request', 'llm_done'),
      tts_ttfb_ms: span('tts_first_text', 'tts_first_audio'),
      first_audio_after_commit_ms: span('stt_committed', 'tts_first_audio'),
      playback_buffer_ms: span('tts_first_audio', 'playback_start'),
      e2e_ms: span('user_speech_end', 'playback_start'),
      barge_in_reaction_ms: span('barge_in_speech_start', 'interrupt_requested'),
      interrupt_stop_ms: span('interrupt_requested', 'playback_stopped'),
    };
    for (const key of DURATION_KEYS) if (result[key] === undefined) delete result[key];
    return result;
  }

  /** Marks relative to the earliest mark, in ms. */
  relativeMarks(): Partial<Record<TurnMark, number>> {
    const values = [...this.marks.values()];
    if (values.length === 0) return {};
    const origin = Math.min(...values);
    const out: Partial<Record<TurnMark, number>> = {};
    for (const name of TURN_MARKS) {
      const at = this.marks.get(name);
      if (at !== undefined) out[name] = round(at - origin);
    }
    return out;
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
