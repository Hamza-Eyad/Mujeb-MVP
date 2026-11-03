import { vi } from 'vitest';
import { buildSessionConfig } from '../../src/app/container.js';
import { loadSettings } from '../../src/config/settings.js';
import type { SessionEvent } from '../../src/voice/session.js';
import { FakeTransport } from './fake-transport.js';
import { createHarness, frame } from './session-harness.js';

/**
 * Barge-in bench (plan 2026-10-29, Q2): the real VoiceSession with the app's default settings, fake providers,
 * and a virtual clock. A caller interrupts Mujeeb in scripted ways. Audio frames drive the local VAD, and a timed
 * STT turns the caller's words into transcripts. Each run reports the parts of the interruption delay against the
 * moment the caller really started speaking, which only a bench knows.
 *
 * The STT timing is a model, not a measurement: its defaults come from the logs (phone first transcript p50 about
 * 1.5 s, p90 about 3.4 s; stt_finalize_ms p50 about 1.3 s). Real ElevenLabs timing can only be measured on paid calls.
 */

const FRAME_MS = 20;
/** Mujeeb has been speaking this long when the bench starts listening for the caller. */
const LEAD_IN_MS = 1000;
/** From then, the caller starts speaking this much later (room for a burst of noise first). */
const SPEECH_AT_MS = 2500;
/** A burst of noise or echo, long enough for the VAD (minSpeechMs 100) and too short to transcribe. */
const NOISE_BURST_MS = 200;
/** How long after the caller starts speaking the bench keeps listening. */
const OBSERVE_MS = 8000;

/** Long enough to keep Mujeeb speaking through every scenario. None of the callers' words are in it. */
export const BENCH_REPLY =
  'عيادتنا تفتح من الساعة ثمانية الصباح إلى الساعة عشرة المساء من الأحد إلى الخميس، ويوم السبت من الساعة أربعة العصر إلى الساعة عشرة المساء. ' +
  'عندنا عيادات الأسنان والجلدية والأطفال والباطنية، وكل عيادة لها طبيب مناوب. تقدر تحجز عن طريق الاتصال أو من خلال التطبيق، ونرسل لك تذكير قبل الزيارة بيوم كامل. ' +
  'وإذا عندك تأمين نتعامل مع أغلب شركات التأمين المعروفة في المملكة.';

/** How the timed STT turns the caller's speech into transcripts (ms). */
export interface SttTiming {
  /** Start of the audio it transcribes → first partial. */
  firstPartialMs: number;
  /** Words in the first partial. */
  firstWords: number;
  /** The caller's pace, and the time between partials: each later partial adds one word. */
  wordMs: number;
  /** End of speech → committed transcript, and at least one word interval after the last partial. */
  commitAfterEndMs: number;
}

export const DEFAULT_STT_TIMING: SttTiming = { firstPartialMs: 1400, firstWords: 2, wordMs: 350, commitAfterEndMs: 1300 };

export interface BenchScenario {
  name: string;
  /** The caller's words, spoken from the moment the caller starts. */
  words: readonly string[];
  /**
   * Mujeeb's own words, heard back on the caller's line right before the caller speaks: the VAD hears them, and
   * the STT transcribes them at the start of the same transcript.
   */
  echoPrefix?: readonly string[];
  /** A burst of noise or echo this long before the caller speaks: VAD only, no transcript. */
  noiseLeadMs?: number;
  /** What the policy should do. */
  expect: 'interrupt' | 'ignore';
}

export interface BenchResult {
  scenario: string;
  timing: SttTiming;
  noiseLeadMs?: number;
  interrupted: boolean;
  /** All relative to the moment the caller really started speaking. Negative: before it. */
  vadMs?: number;
  /** (b) barge_in_stt_ms and (c) barge_in_policy_ms, from the turn summary. */
  sttMs?: number;
  policyMs?: number;
  /** Caller starts → interrupt decision. */
  totalMs?: number;
  /** Caller starts → Mujeeb goes quiet: the first pause or the interruption, whichever came first. */
  quietMs?: number;
  /** barge_in_reaction_ms (from the first VAD start while Mujeeb spoke). */
  oldMs?: number;
  pauses: number;
  falseInterruptions: number;
}

/** The app's defaults (settings with an empty environment), as the dev server and the telephony gateway use them. */
export function benchSessionConfig() {
  return buildSessionConfig(loadSettings({}, { forceFakeProviders: true }));
}

export async function runBargeInScenario(scenario: BenchScenario, timing: SttTiming = DEFAULT_STT_TIMING): Promise<BenchResult> {
  vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  try {
    return await runOnVirtualClock(scenario, timing);
  } finally {
    vi.useRealTimers();
  }
}

async function runOnVirtualClock(scenario: BenchScenario, timing: SttTiming): Promise<BenchResult> {
  const h = createHarness({
    config: benchSessionConfig(),
    now: () => Date.now(),
    transport: new FakeTransport({ playbackSpeed: 1 }), // Mujeeb's audio plays in (virtual) real time
    llm: { reply: () => BENCH_REPLY, tokenDelayMs: 20 },
    tts: { msPerChar: 60, realtimeFactor: 0.1 },
  });
  const starting = h.session.start();
  await vi.advanceTimersByTimeAsync(50);
  await starting;
  h.sttStream.commit('متى تفتحون');
  const turnId = h.events.find((e): e is Extract<SessionEvent, { type: 'user_committed' }> => e.type === 'user_committed')?.turnId;
  if (turnId === undefined) throw new Error('the question did not start a turn');
  for (let waited = 0; h.session.currentState !== 'speaking'; waited += FRAME_MS) {
    if (waited > 10_000) throw new Error('Mujeeb never started speaking');
    await feedFrame(h.transport, false);
  }

  const speechAt = Date.now() + LEAD_IN_MS + SPEECH_AT_MS;
  const echo = scenario.echoPrefix ?? [];
  const audioAt = speechAt - echo.length * timing.wordMs; // the echo runs straight into the caller's words
  const speechEnd = speechAt + scenario.words.length * timing.wordMs;
  const noiseAt = scenario.noiseLeadMs !== undefined ? speechAt - scenario.noiseLeadMs : undefined;
  const loud = (t: number): boolean =>
    (t >= audioAt && t < speechEnd) || (noiseAt !== undefined && t >= noiseAt && t < noiseAt + NOISE_BURST_MS);
  scheduleTranscripts(h.sttStream, [...echo, ...scenario.words], audioAt, speechEnd, timing);

  const turnEnded = (): boolean => h.sink.summaries.some((s) => s.turn_id === turnId);
  while (Date.now() < speechAt + OBSERVE_MS && !turnEnded()) {
    await feedFrame(h.transport, loud(Date.now()));
  }
  const closing = h.session.close('bench_end'); // finalizes a turn still speaking, so its counts are logged
  await vi.advanceTimersByTimeAsync(100);
  await closing;

  const marks = new Map<string, number>();
  for (const e of h.events) if (e.type === 'timeline' && e.turnId === turnId) marks.set(e.mark, e.t);
  const at = (mark: string): number | undefined => {
    const t = marks.get(mark);
    return t === undefined ? undefined : t - speechAt;
  };
  const summary = h.sink.summaries.find((s) => s.turn_id === turnId);
  const d = summary?.durations_ms ?? {};
  const decision = at('interrupt_requested');
  const pause = at('barge_in_candidate');
  const quiet = [pause, decision].filter((v): v is number => v !== undefined);
  return {
    scenario: scenario.name,
    timing,
    ...(scenario.noiseLeadMs !== undefined ? { noiseLeadMs: scenario.noiseLeadMs } : {}),
    interrupted: summary?.outcome === 'interrupted',
    ...optional('vadMs', at('barge_in_segment_start')),
    ...optional('sttMs', d.barge_in_stt_ms),
    ...optional('policyMs', d.barge_in_policy_ms),
    ...optional('totalMs', decision),
    ...optional('quietMs', quiet.length > 0 ? Math.min(...quiet) : undefined),
    ...optional('oldMs', d.barge_in_reaction_ms),
    pauses: summary?.barge_in?.candidates ?? 0,
    falseInterruptions: summary?.false_interruptions ?? 0,
  };
}

/** One 20 ms frame of caller audio, delivered when it is complete (as a capture device would). */
async function feedFrame(transport: FakeTransport, loud: boolean): Promise<void> {
  await vi.advanceTimersByTimeAsync(FRAME_MS);
  transport.feed([frame(loud)]);
}

/** Partials grow one word at a time from the first one; the commit follows the end of speech. */
function scheduleTranscripts(
  stream: { partial(text: string): void; commit(text: string): void },
  words: readonly string[],
  audioAt: number,
  speechEnd: number,
  timing: SttTiming,
): void {
  const at = (t: number, fn: () => void): void => void setTimeout(fn, t - Date.now());
  const first = Math.min(timing.firstWords, words.length);
  let last = audioAt;
  for (let n = first; n <= words.length; n += 1) {
    last = audioAt + timing.firstPartialMs + (n - first) * timing.wordMs;
    const text = words.slice(0, n).join(' ');
    at(last, () => stream.partial(text));
  }
  at(Math.max(speechEnd + timing.commitAfterEndMs, last + timing.wordMs), () => stream.commit(words.join(' ')));
}

function optional<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

// ───────────────────────────── scenarios ─────────────────────────────

const SENTENCE = ['لا', 'لحظة', 'ابي', 'اسأل'];
const FIRST_PARTIAL_MS = [1000, 1400, 2000, 3400];

/** One run per scenario and STT timing: the plan's scenarios, across the first-transcript delays seen in the logs. */
export function benchSweep(): { scenario: BenchScenario; timing: SttTiming }[] {
  const runs: { scenario: BenchScenario; timing: SttTiming }[] = [];
  const timings = (firstWords: readonly number[]) =>
    FIRST_PARTIAL_MS.flatMap((firstPartialMs) => firstWords.map((w) => ({ ...DEFAULT_STT_TIMING, firstPartialMs, firstWords: w })));
  for (const timing of timings([2, 1])) runs.push({ scenario: { name: 'sentence', words: SENTENCE, expect: 'interrupt' }, timing });
  for (const timing of timings([1])) runs.push({ scenario: { name: 'one-word', words: ['لا'], expect: 'interrupt' }, timing });
  for (const timing of timings([1])) {
    runs.push({ scenario: { name: 'backchannel-then-speech', words: ['ايه', 'بس', 'ابي', 'موعد'], expect: 'interrupt' }, timing });
  }
  for (const noiseLeadMs of [500, 1000, 2000]) {
    runs.push({ scenario: { name: 'noise-first', words: SENTENCE, noiseLeadMs, expect: 'interrupt' }, timing: DEFAULT_STT_TIMING });
  }
  for (const timing of timings([2])) {
    runs.push({ scenario: { name: 'echo-then-speech', words: ['لا', 'لحظة', 'ابي'], echoPrefix: ['تفتح', 'من', 'الساعة', 'ثمانية'], expect: 'interrupt' }, timing });
  }
  runs.push({ scenario: { name: 'backchannel-only', words: ['ايه'], expect: 'ignore' }, timing: { ...DEFAULT_STT_TIMING, firstWords: 1 } });
  return runs;
}

export function formatBenchTable(results: readonly BenchResult[]): string {
  const ms = (v: number | undefined): string => (v === undefined ? '—' : String(Math.round(v)));
  const lines = [
    '| scenario | first partial | words | noise lead | interrupted | (a) VAD | (b) STT | (c) policy | total | quiet | old | pauses | false |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.scenario} | ${r.timing.firstPartialMs} | ${r.timing.firstWords} | ${ms(r.noiseLeadMs)} | ${r.interrupted ? 'yes' : 'no'} | ` +
        `${ms(r.vadMs)} | ${ms(r.sttMs)} | ${ms(r.policyMs)} | ${ms(r.totalMs)} | ${ms(r.quietMs)} | ${ms(r.oldMs)} | ${r.pauses} | ${r.falseInterruptions} |`,
    );
  }
  return lines.join('\n');
}
