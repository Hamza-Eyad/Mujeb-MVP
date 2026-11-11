import { afterEach, describe, expect, it } from 'vitest';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { FakeSpeechToText } from '../../src/adapters/fakes/fake-stt.js';
import { FakeTextToSpeech } from '../../src/adapters/fakes/fake-tts.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { type AgentRuntime, createVoiceSession } from '../../src/app/session-factory.js';
import { ProviderError } from '../../src/core/errors.js';
import { silentLogger } from '../../src/core/logger.js';
import { MemoryTurnSink } from '../../src/observability/turn-metrics.js';
import type { VoiceSession } from '../../src/voice/session.js';
import { FakeTransport } from '../support/fake-transport.js';
import { TEST_CONFIG, createHarness, delay, frames, toneFrames, waitFor } from '../support/session-harness.js';

const open: VoiceSession[] = [];
function track<T extends { session: VoiceSession }>(h: T): T {
  open.push(h.session);
  return h;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close('test_end')));
});

const summaries = (h: ReturnType<typeof createHarness>) => h.sink.summaries;

describe('VoiceSession — happy path', () => {
  it('runs a full streaming turn and records every latency stage', async () => {
    const h = track(createHarness());
    await h.session.start();
    expect(h.session.currentState).toBe('listening');

    h.transport.feed(frames(true, 15)); // ~300ms of speech
    h.sttStream.partial('السلام عليكم');
    h.transport.feed(frames(false, 20)); // silence → local VAD speech end
    h.sttStream.commit('السلام عليكم ابي اعرف الدوام');

    await waitFor(() => summaries(h).length === 1, 5000, 'turn summary');
    const [summary] = summaries(h);
    expect(summary).toMatchObject({ kind: 'user', outcome: 'completed' });
    for (const mark of ['user_speech_start', 'user_speech_end', 'stt_first_partial', 'stt_committed', 'llm_request', 'llm_first_token', 'llm_done', 'tts_first_text', 'tts_first_audio', 'playback_start', 'playback_end']) {
      expect(summary?.marks_ms, mark).toHaveProperty(mark);
    }
    for (const metric of ['stt_finalize_ms', 'llm_ttft_ms', 'tts_ttfb_ms', 'e2e_ms']) {
      expect(summary?.durations_ms, metric).toHaveProperty(metric);
    }
    expect(h.states()).toEqual(['listening', 'thinking', 'speaking', 'listening']);
    expect(h.sttStream.bytesReceived).toBeGreaterThan(0); // audio streamed to STT while speaking
    expect(h.transport.audioOps(1)).toBeGreaterThan(1); // audio streamed out in chunks
    expect(h.session.history().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.session.history()[1]?.text).toContain('سمعتك تقول');
    // Live telemetry mirrors the timeline: pending marks have no turn yet, the rest carry the turn id.
    const live = h.events.filter((e): e is Extract<typeof e, { type: 'timeline' }> => e.type === 'timeline');
    const turnId = summary?.turn_id;
    expect(live.filter((e) => e.turnId === null).map((e) => e.mark)).toEqual(expect.arrayContaining(['user_speech_start', 'stt_first_partial', 'stt_committed']));
    expect(live.filter((e) => e.turnId === turnId).map((e) => e.mark)).toEqual(expect.arrayContaining(['llm_request', 'llm_first_token', 'tts_first_audio', 'tts_done', 'playback_start', 'playback_end']));
    const firstAudio = live.find((e) => e.mark === 'tts_first_audio')?.t ?? 0;
    const done = live.find((e) => e.mark === 'tts_done')?.t ?? 0;
    expect(done).toBeGreaterThanOrEqual(firstAudio);
    // No transcript text in metrics by default (privacy).
    expect(summary).not.toHaveProperty('user_text');
    expect(summary).not.toHaveProperty('barge_in'); // nothing was heard while Mujeeb spoke
  });

  it('starts LLM→TTS streaming before the LLM finishes (first audio precedes llm_done)', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 25 } }));
    await h.session.start();
    h.sttStream.commit('مرحبا');
    await waitFor(() => summaries(h).length === 1, 5000);
    const marks = summaries(h)[0]?.marks_ms ?? {};
    expect(marks.tts_first_audio).toBeLessThan(marks.llm_done ?? 0);
  });

  it('speaks the configured greeting first and records it in history', async () => {
    const h = track(createHarness({ greeting: 'هلا والله، معك مُجيب.' }));
    await h.session.start();
    await waitFor(() => summaries(h).length === 1);
    expect(summaries(h)[0]).toMatchObject({ kind: 'greeting', outcome: 'completed' });
    expect(h.session.history()).toEqual([{ role: 'assistant', text: 'هلا والله، معك مُجيب.' }]);
  });
});

describe('VoiceSession — barge-in', () => {
  it('interrupts immediately: clears playback, aborts LLM and TTS, keeps only heard text', async () => {
    const llm = new FakeLanguageModel({ tokenDelayMs: 50 });
    const tts = new FakeTextToSpeech({ realtimeFactor: 0.3, msPerChar: 25 });
    const h = track(createHarness({ llm, tts }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking' && h.transport.audioOps(1) >= 3, 3000, 'speaking');

    h.sttStream.partial('لا لحظة ابي اسأل');
    expect(h.transport.ops.some((o) => o.op === 'clear' && o.epoch === 1)).toBe(true); // synchronous
    expect(h.session.currentState).toBe('listening');

    await waitFor(() => summaries(h).length === 1, 2000, 'interrupted summary');
    const [summary] = summaries(h);
    expect(summary).toMatchObject({ outcome: 'interrupted', reason: 'barge_in', heard_text_estimated: false });
    expect(summary?.durations_ms.interrupt_stop_ms).toBeGreaterThanOrEqual(0);
    await waitFor(() => llm.aborted === 1 && tts.utterances[0]?.cancelled === true, 2000, 'provider cancellation');

    await delay(100); // give any straggler a chance to (wrongly) be sent
    expect(h.transport.audioAfterClear(1)).toBe(0);

    const assistant = h.session.history()[1];
    expect(assistant?.text).toContain('[قاطعه المتصل هنا]');
    expect((summary?.assistant_chars_heard ?? 0)).toBeLessThan(summary?.assistant_chars_sent ?? 0);

    // The interrupting utterance becomes the next turn.
    h.sttStream.commit('لا لحظة ابي اسأل عن الاسعار');
    await waitFor(() => summaries(h).length === 2, 10000, 'second turn');
    expect(summaries(h)[1]).toMatchObject({ outcome: 'completed' });
    expect(h.transport.audioOps(2)).toBeGreaterThan(0);
    expect(h.session.history().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('ends an interrupted turn on the clear-ack timeout, without a stop time, and ignores the late confirmation', async () => {
    const transport = new FakeTransport({ clearAckDelayMs: 400 }); // TEST_CONFIG.clearAckTimeoutMs is 200
    const h = track(createHarness({ transport, llm: { tokenDelayMs: 50 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking' && h.transport.audioOps(1) >= 3, 3000, 'speaking');

    h.sttStream.partial('لا لحظة ابي اسأل');
    await waitFor(() => summaries(h).length === 1, 1000, 'interrupted summary on timeout');
    expect(summaries(h)[0]).toMatchObject({ outcome: 'interrupted', reason: 'barge_in' });
    expect(summaries(h)[0]?.durations_ms.interrupt_stop_ms).toBeUndefined(); // the stop was never confirmed

    await delay(300); // the late confirmation arrives
    expect(summaries(h)).toHaveLength(1);
    h.sttStream.commit('لا لحظة ابي اسأل عن الاسعار');
    await waitFor(() => summaries(h).length === 2, 10000, 'next turn');
    expect(summaries(h)[1]).toMatchObject({ outcome: 'completed' });
  });

  it('never forwards audio from a cancelled turn, even if the provider keeps sending', async () => {
    const tts = new FakeTextToSpeech({ ignoreAbort: true, realtimeFactor: 0.3 });
    const h = track(createHarness({ tts, greeting: 'هلا والله، معك مُجيب من العيادة التجريبية، كيف أقدر أساعدك اليوم؟ عندنا عيادات كثيرة.' }));
    await h.session.start();
    await waitFor(() => h.session.currentState === 'speaking' && h.transport.audioOps(1) >= 2, 3000);
    h.sttStream.commit('لا لحظة'); // two words: a single word during the greeting is taken for its echo
    await waitFor(() => h.session.stats.staleChunksDropped >= 1, 2000, 'stale chunk dropped');
    await delay(100);
    expect(h.transport.audioAfterClear(1)).toBe(0);
  });

  it('pauses on an unsure short word, then resumes when not confirmed (false interruption)', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.sttStream.partial('كذا');
    expect(h.transport.count('pause')).toBe(1);
    expect(h.transport.count('clear')).toBe(0);
    await waitFor(() => h.transport.count('resume') === 1, 1000, 'resume');
    expect(h.session.stats.falseInterruptions).toBe(1);

    await waitFor(() => summaries(h).length === 1, 8000);
    expect(summaries(h)[0]).toMatchObject({ outcome: 'completed', false_interruptions: 1 });
  });

  it('keeps the pause while local VAD still hears the caller, then resumes once they stop', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.sttStream.partial('للحظة'); // slow STT: one word, then nothing for a while
    h.transport.feed(frames(true, 10)); // caller is still audibly talking
    await delay(250); // > falseInterruptionTimeoutMs (150) in tests
    expect(h.transport.count('resume')).toBe(0);

    h.transport.feed(frames(false, 20)); // caller stops → VAD speech end
    await waitFor(() => h.transport.count('resume') === 1, 1000, 'resume after silence');
    expect(h.transport.count('clear')).toBe(0);
  });

  it('confirms a paused candidate when more words arrive', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);
    h.sttStream.partial('لا');
    expect(h.transport.count('pause')).toBe(1);
    h.sttStream.partial('لا انتظر');
    expect(h.transport.count('clear')).toBe(1);
    await waitFor(() => summaries(h).length === 1);
    expect(summaries(h)[0]).toMatchObject({ outcome: 'interrupted' });
  });

  it('measures an interruption in parts: VAD segment → first transcript → decision', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.transport.feed(frames(true, 10)); // the caller talks: VAD starts the segment 100ms back
    await delay(120); // STT is slower than VAD
    h.sttStream.partial('لا'); // one word: pause and wait for more
    await delay(80);
    h.sttStream.partial('لا انتظر');
    await waitFor(() => summaries(h).length === 1, 2000, 'interrupted summary');

    const [summary] = summaries(h);
    const m = summary?.marks_ms ?? {};
    const d = summary?.durations_ms ?? {};
    expect(m.barge_in_segment_start).toBe(m.barge_in_speech_start); // one segment: both starts agree
    expect(Math.abs((m.barge_in_candidate ?? 0) - (m.barge_in_first_partial ?? -1))).toBeLessThan(20); // it paused playback, not the second word
    expect(d.barge_in_stt_ms).toBeGreaterThanOrEqual(200);
    expect(d.barge_in_policy_ms).toBeGreaterThanOrEqual(70); // waited for the second word
    // Each duration is rounded to 0.1ms, so the parts may differ from the total by one step.
    expect(Math.abs((d.barge_in_stt_ms ?? 0) + (d.barge_in_policy_ms ?? 0) - (d.barge_in_reaction_segment_ms ?? -1))).toBeLessThan(0.15);
    expect(d.barge_in_reaction_ms).toBe(d.barge_in_reaction_segment_ms);
    expect(m).not.toHaveProperty('barge_in_segment_end'); // still talking when the transcript came
    expect(summary?.barge_in).toEqual({
      vad_starts: 1,
      transcripts: 2,
      ignored: { echo: 0, backchannel: 0, empty: 0 },
      candidates: 1,
      first_words: 1,
      vad_segments: [{ ms: 200, lead_ms: 0, open: true }], // still talking when the turn ended
    });
    expect(JSON.stringify(summary)).not.toContain('انتظر'); // counts only, no text
  });

  it('measures from the VAD segment of the interrupting speech, not from an earlier burst of noise', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.transport.feed([...frames(true, 10), ...frames(false, 20)]); // noise or echo: a VAD segment, no transcript
    await delay(150);
    h.transport.feed(frames(true, 10)); // the caller speaks: a new segment
    await delay(50);
    h.sttStream.partial('لحظة لو سمحت');
    await waitFor(() => summaries(h).length === 1, 2000, 'interrupted summary');

    const [summary] = summaries(h);
    const m = summary?.marks_ms ?? {};
    const d = summary?.durations_ms ?? {};
    expect(m.barge_in_segment_start).toBeGreaterThan((m.barge_in_speech_start ?? 0) + 140);
    expect(d.barge_in_reaction_ms).toBeGreaterThan((d.barge_in_reaction_segment_ms ?? 0) + 140); // the old measure is inflated
    expect(d.barge_in_policy_ms).toBeLessThan(20); // three words: decided on the first transcript
    expect(summary?.barge_in).toMatchObject({ vad_starts: 2, transcripts: 1, candidates: 0, first_words: 3 });
  });

  it('records how long before the first transcript the VAD segment had ended', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.transport.feed(frames(true, 10)); // segment starts 100ms back
    await delay(250);
    h.transport.feed(frames(false, 15)); // and ends 300ms back: 50ms after it started
    await delay(100); // the transcript comes after the caller stopped
    h.sttStream.partial('لا لحظة');
    await waitFor(() => summaries(h).length === 1, 2000, 'interrupted summary');

    const [summary] = summaries(h);
    const m = summary?.marks_ms ?? {};
    const d = summary?.durations_ms ?? {};
    expect(m.barge_in_segment_end).toBeGreaterThan(m.barge_in_segment_start ?? Infinity);
    expect(d.barge_in_segment_gap_ms).toBeGreaterThanOrEqual(330);
    expect(d.barge_in_segment_gap_ms).toBeLessThan(d.barge_in_stt_ms ?? 0);
  });

  it('starts the heard speech at the first transcript with words', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.sttStream.partial('...'); // no words yet
    await delay(60);
    h.sttStream.partial('لا لحظة');
    await waitFor(() => summaries(h).length === 1, 2000, 'interrupted summary');

    const [summary] = summaries(h);
    expect(summary?.durations_ms.barge_in_policy_ms).toBeLessThan(20); // the 60ms wait for words is not policy time
    expect(summary?.barge_in).toMatchObject({ transcripts: 2, ignored: { echo: 0, backchannel: 0, empty: 1 }, first_words: 2 });
  });

  it('starts a new heard utterance after a committed echo', async () => {
    const reply = 'عيادتنا تفتح من الساعة ثمانية الصباح إلى الساعة عشرة المساء طوال أيام الأسبوع ما عدا الجمعة.';
    const h = track(createHarness({ llm: { reply: () => reply, tokenDelayMs: 20 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('متى الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.sttStream.partial('تفتح من الساعة ثمانية');
    h.sttStream.commit('تفتح من الساعة ثمانية'); // echo, ignored: this STT utterance is over
    await delay(60);
    h.sttStream.partial('لا لحظة');
    await waitFor(() => summaries(h).length === 1, 2000, 'interrupted summary');

    const [summary] = summaries(h);
    expect(summary?.durations_ms.barge_in_policy_ms).toBeLessThan(20); // measured from 'لا لحظة', not from the echo 60ms earlier
    expect(summary?.barge_in).toMatchObject({ transcripts: 3, ignored: { echo: 2, backchannel: 0, empty: 0 }, first_words: 2 });
  });

  it('counts what it heard while speaking when nobody interrupts, without new marks', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.transport.feed([...frames(true, 10), ...frames(false, 20)]);
    h.sttStream.partial('اها');
    await waitFor(() => summaries(h).length === 1, 8000);

    const [summary] = summaries(h);
    expect(summary?.outcome).toBe('completed');
    expect(summary?.barge_in).toEqual({ vad_starts: 1, transcripts: 1, ignored: { echo: 0, backchannel: 1, empty: 0 }, candidates: 0, vad_segments: [{ ms: 200, lead_ms: 0 }] });
    expect(summary?.marks_ms).not.toHaveProperty('barge_in_first_partial');
    expect(summary?.marks_ms).not.toHaveProperty('barge_in_segment_start');
  });

  it('measures the line level while Mujeeb plays and while it is quiet, numbers only', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.transport.feed([...frames(false, 10), ...frames(true, 10), ...frames(false, 20)]); // the caller asks
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    // Over the reply: a quiet onset the threshold cuts off, then speech that stops.
    h.transport.feed([...toneFrames(60, 10), ...frames(true, 10), ...frames(false, 20)]);
    await waitFor(() => summaries(h).length === 1, 8000);

    const [summary] = summaries(h);
    expect(summary?.outcome).toBe('completed');
    expect(summary?.barge_in?.vad_segments).toEqual([{ ms: 200, lead_ms: 200 }]);
    expect(summary?.line).toEqual({
      quiet: { frames: 40, p10_db: -100, p50_db: -100, p90_db: -16, max_db: -15.2 }, // silence and the caller's question
      playing: { frames: 40, p10_db: -100, p50_db: -100, p90_db: -16, max_db: -15.2 },
      noise_floor_db: -90,
      threshold_db: -48,
    });
  });

  it('starts the quiet time again after each reply, and leaves a soft pause out of the playing level', async () => {
    const h = track(createHarness({ llm: { tokenDelayMs: 30 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.transport.feed(frames(false, 5));
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);
    h.transport.feed(frames(false, 3));
    h.sttStream.partial('لحظة'); // one word: soft pause
    await waitFor(() => h.events.some((e) => e.type === 'barge_in' && e.action === 'pause'), 2000);
    h.transport.feed(frames(false, 4)); // heard during the pause: nothing plays
    await waitFor(() => summaries(h).length === 1, 8000);
    h.transport.feed(frames(false, 2));
    h.sttStream.commit('طيب');
    await waitFor(() => summaries(h).length === 2, 8000);

    const [first, second] = summaries(h);
    expect(first?.line).toMatchObject({ quiet: { frames: 5 }, playing: { frames: 3 } });
    expect(second?.line).toMatchObject({ quiet: { frames: 6 } }); // the pause and the time after the first reply
  });

  it('ignores backchannels and echoes of its own speech', async () => {
    const reply = 'عيادتنا تفتح من الساعة ثمانية الصباح إلى الساعة عشرة المساء طوال أيام الأسبوع ما عدا الجمعة.';
    const h = track(createHarness({ llm: { reply: () => reply, tokenDelayMs: 20 }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('متى الدوام');
    await waitFor(() => h.session.currentState === 'speaking', 3000);

    h.sttStream.partial('اها');
    h.sttStream.partial('تفتح من الساعة ثمانية');
    h.sttStream.commit('ايه');
    expect(h.transport.count('pause') + h.transport.count('clear')).toBe(0);
    expect(h.session.stats).toMatchObject({ backchannelsIgnored: 2, echoSuppressed: 1 });

    await waitFor(() => summaries(h).length === 1, 8000);
    expect(summaries(h)[0]?.outcome).toBe('completed');
  });

  it('suppresses an echo tail that arrives right after Mujeeb stops talking', async () => {
    const reply = 'الدوام من الساعة ثمانية إلى الساعة عشرة.';
    const h = track(createHarness({ llm: { reply: () => reply } }));
    await h.session.start();
    h.sttStream.commit('متى الدوام');
    await waitFor(() => summaries(h).length === 1, 5000);
    h.sttStream.commit('من الساعة ثمانية الى الساعة عشره');
    expect(h.session.stats.echoSuppressed).toBe(1);
    expect(h.session.currentState).toBe('listening');
    await delay(250); // echo tail (200ms in tests) has passed — same words are now real speech
    h.sttStream.commit('من الساعة ثمانية الى الساعة عشره');
    expect(h.session.currentState).toBe('thinking');
  });
});

describe('VoiceSession — turn taking', () => {
  it('merges speech that continues while Mujeeb is thinking, without duplicate history', async () => {
    const llm = new FakeLanguageModel({ firstTokenDelayMs: 300 });
    const h = track(createHarness({ llm }));
    await h.session.start();
    h.sttStream.commit('ابي موعد');
    expect(h.session.currentState).toBe('thinking');
    await waitFor(() => llm.calls.length === 1, 1000, 'llm request in flight');
    h.sttStream.partial('يوم');
    await waitFor(() => llm.aborted === 1, 1000, 'llm aborted');
    expect(h.session.currentState).toBe('listening');
    h.sttStream.commit('يوم الأحد');
    await waitFor(() => summaries(h).filter((s) => s.outcome === 'completed').length === 1, 5000);
    expect(llm.calls[1]?.messages.at(-1)?.text).toBe('ابي موعد يوم الأحد');
    expect(h.session.history().filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['ابي موعد يوم الأحد']);
    expect(summaries(h)[0]).toMatchObject({ outcome: 'cancelled', reason: 'user_continued' });
  });

  it('waits for the rest of a number dictated in groups, then answers the whole of it once', async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, config: { numberHoldMs: 300 } }));
    await h.session.start();
    h.sttStream.commit('رقم جوالي 0505');
    expect(h.session.currentState).toBe('listening'); // no reply on half a number
    await delay(150);
    h.sttStream.partial('430'); // the caller goes on: the wait is cleared until their next commit
    await delay(400);
    expect(llm.calls.length).toBe(0);
    h.sttStream.commit('430 5530');
    await waitFor(() => llm.calls.length === 1, 2000, 'one request for the whole number');
    expect(llm.calls[0]?.messages.at(-1)?.text).toBe('رقم جوالي 0505 430 5530');
    await waitFor(() => summaries(h).length === 1, 5000);
    expect(h.session.history().filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['رقم جوالي 0505 430 5530']);
  });

  it('answers at once when the words do not end with a number, and after the wait when the number is complete', async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, config: { numberHoldMs: 300 } }));
    await h.session.start();
    h.sttStream.commit('ابي موعد اسنان');
    expect(h.session.currentState).toBe('thinking');
    await waitFor(() => summaries(h).length === 1, 5000);
    h.sttStream.commit('تاريخ ميلادي خمسة نوفمبر الف وتسعمية واربعة وستين');
    expect(h.session.currentState).toBe('listening');
    await waitFor(() => llm.calls.length === 2, 2000, 'answered after the wait');
  });

  it('half-duplex sends silence to STT while speaking', async () => {
    const h = track(createHarness({ config: { duplexMode: 'half' }, tts: { realtimeFactor: 0.3 } }));
    await h.session.start();
    h.sttStream.commit('مرحبا');
    await waitFor(() => h.session.currentState === 'speaking', 3000);
    h.transport.feed(frames(true, 10));
    expect(h.sttStream.lastChunk?.every((b) => b === 0)).toBe(true);
  });
});

describe('VoiceSession — failures keep the session healthy', () => {
  it('recovers from an LLM error', async () => {
    const h = track(createHarness({ llm: { failWith: new ProviderError('fake-llm', 'rate_limit', 'slow down') } }));
    await h.session.start();
    h.sttStream.commit('مرحبا');
    await waitFor(() => summaries(h).length === 1);
    expect(summaries(h)[0]).toMatchObject({ outcome: 'error', error: { error_kind: 'rate_limit' } });
    expect(h.session.currentState).toBe('listening');
    expect(h.events.some((e) => e.type === 'error' && e.code === 'turn_rate_limit')).toBe(true);
    h.sttStream.commit('مرة ثانية');
    await waitFor(() => summaries(h).length === 2);
    expect(h.session.currentState).toBe('listening');
  });

  it('times out when the LLM produces no first token, and cancels the request', async () => {
    const llm = new FakeLanguageModel({ hang: true });
    const h = track(createHarness({ llm, config: { llmFirstTokenTimeoutMs: 80 } }));
    await h.session.start();
    h.sttStream.commit('مرحبا');
    await waitFor(() => summaries(h).length === 1);
    expect(summaries(h)[0]).toMatchObject({ outcome: 'error', error: { error_kind: 'timeout', provider: 'fake-llm' } });
    await waitFor(() => llm.aborted === 1);
  });

  it('times out when TTS produces no audio', async () => {
    const h = track(createHarness({ tts: { hang: true }, config: { ttsFirstAudioTimeoutMs: 80 } }));
    await h.session.start();
    h.sttStream.commit('مرحبا');
    await waitFor(() => summaries(h).length === 1);
    expect(summaries(h)[0]).toMatchObject({ outcome: 'error', error: { error_kind: 'timeout', provider: 'fake-tts' } });
  });

  it('reconnects STT after a transient drop', async () => {
    const h = track(createHarness());
    await h.session.start();
    h.sttStream.drop(new ProviderError('fake-stt', 'unavailable', 'network'));
    await waitFor(() => h.stt.streams.length === 2, 1000, 'reconnect');
    expect(h.session.stats.sttReconnects).toBe(1);
    h.sttStream.commit('مرحبا');
    await waitFor(() => summaries(h).length === 1);
    expect(summaries(h)[0]?.outcome).toBe('completed');
  });

  it('closes cleanly on a non-retryable STT failure', async () => {
    const h = track(createHarness());
    await h.session.start();
    h.sttStream.drop(new ProviderError('fake-stt', 'auth', 'bad key'));
    await waitFor(() => h.transport.closedReason !== undefined);
    expect(h.session.currentState).toBe('closed');
    expect(h.events.some((e) => e.type === 'error' && e.code === 'stt_failed')).toBe(true);
    expect(h.transport.closedReason).toMatch(/stt_failed/);
  });

  it('cancels in-flight work when the session closes mid-turn', async () => {
    const llm = new FakeLanguageModel({ tokenDelayMs: 50 });
    const h = createHarness({ llm, tts: { realtimeFactor: 0.3 } });
    await h.session.start();
    h.sttStream.commit('مرحبا');
    await waitFor(() => h.session.currentState === 'speaking', 3000);
    await h.session.close('caller_hung_up');
    expect(summaries(h)[0]).toMatchObject({ outcome: 'cancelled', reason: 'session_closed' });
    await waitFor(() => llm.aborted === 1);
    expect(h.transport.closedReason).toBe('caller_hung_up');
  });
});

describe('VoiceSession — concurrency', () => {
  it('keeps concurrent sessions isolated while sharing provider adapters', async () => {
    const llm = new FakeLanguageModel({ tokenDelayMs: 10 });
    const tts = new FakeTextToSpeech({ realtimeFactor: 0.2 });
    const harnesses = Array.from({ length: 6 }, (_, i) => track(createHarness({ llm, tts, sessionId: `ses_${i}` })));
    await Promise.all(harnesses.map((h) => h.session.start()));
    harnesses.forEach((h, i) => h.sttStream.commit(`طلب رقم ${i}`));

    // Interrupt one session mid-reply; the others must be unaffected.
    const victim = harnesses[2];
    if (!victim) throw new Error('missing harness');
    await waitFor(() => victim.session.currentState === 'speaking', 3000);
    victim.sttStream.partial('لا وقف لحظة');

    await Promise.all(harnesses.map((h) => waitFor(() => h.sink.summaries.length === 1, 8000)));
    harnesses.forEach((h, i) => {
      const expected = i === 2 ? 'interrupted' : 'completed';
      expect(h.sink.summaries[0]?.outcome, `session ${i}`).toBe(expected);
      expect(h.sink.summaries[0]?.session_id).toBe(`ses_${i}`);
      expect(h.session.history()[0]?.text).toBe(`طلب رقم ${i}`);
      if (i !== 2) expect(h.session.history()[1]?.text).toContain(`طلب رقم ${i}`);
    });
    expect(llm.calls).toHaveLength(6);
  });
});

describe('VoiceSession — connecting before the session is heard (prepare)', () => {
  it('prepare() connects STT and warms TTS without speaking; start() then greets', async () => {
    const h = track(createHarness({ greeting: 'أهلاً وسهلاً' }));
    await h.session.prepare();
    expect(h.stt.attempts.map((a) => a.outcome)).toEqual(['open']);
    await waitFor(() => (h.tts as FakeTextToSpeech).opened === 1, 1000, 'TTS warmed');
    expect(h.session.currentState).toBe('starting');
    expect(h.transport.ops).toHaveLength(0); // nothing is spoken before start()
    await h.session.start();
    await waitFor(() => summaries(h).some((t) => t.kind === 'greeting'), 3000, 'greeting');
    expect(h.stt.attempts).toHaveLength(1); // start() reuses the prepared connection
    expect((h.tts as FakeTextToSpeech).opened).toBe(1);
  });

  it('aborts a stalled STT attempt and retries once (also the browser path: start() without a deadline)', async () => {
    const h = track(createHarness({ stt: { hangOpen: { times: 1 } } }));
    const started = Date.now();
    await h.session.start();
    expect(h.stt.attempts.map((a) => a.outcome)).toEqual(['aborted', 'open']); // the stalled attempt was cancelled, not ignored
    expect(Date.now() - started).toBeGreaterThanOrEqual(140); // the attempt timeout (150ms)
    h.sttStream.commit('مرحبا');
    await waitFor(() => summaries(h).length === 1);
    expect(summaries(h)[0]?.outcome).toBe('completed');
  });

  it('gives up after two attempts, and never retries an authentication error', async () => {
    const stalled = track(createHarness({ stt: { hangOpen: { times: 2 } } }));
    await expect(stalled.session.prepare()).rejects.toMatchObject({ kind: 'timeout', provider: 'fake-stt' });
    expect(stalled.stt.attempts.map((a) => a.outcome)).toEqual(['aborted', 'aborted']);

    const denied = track(createHarness({ stt: { failOpen: { times: 1, error: new ProviderError('fake-stt', 'auth', 'bad key') } } }));
    await expect(denied.session.prepare()).rejects.toMatchObject({ kind: 'auth' });
    expect(denied.stt.attempts.map((a) => a.outcome)).toEqual(['failed']);
    await expect(denied.session.start()).rejects.toMatchObject({ kind: 'auth' }); // start() reports the same failure
  });

  it('stops at the deadline, which bounds both attempts and the pause between them', async () => {
    const h = track(createHarness({ stt: { hangOpen: { times: 2 } } }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('deadline')), 200); // inside the second attempt (150 + 10 + 150)
    const started = Date.now();
    await expect(h.session.prepare(controller.signal)).rejects.toThrow('deadline');
    clearTimeout(timer);
    expect(Date.now() - started).toBeLessThan(290);
    expect(h.stt.attempts.map((a) => a.outcome)).toEqual(['aborted', 'aborted']);
  });

  it('close() during prepare aborts the STT attempt at once and starts nothing', async () => {
    const h = createHarness({ stt: { hangOpen: { times: 1 } }, config: { sttConnect: { attempts: 2, attemptTimeoutMs: 5000, retryDelayMs: 10 } } });
    const preparing = h.session.prepare();
    await delay(20);
    await h.session.close('caller_hung_up');
    await expect(preparing).rejects.toThrow();
    expect(h.stt.attempts.map((a) => a.outcome)).toEqual(['aborted']);
    await delay(50);
    expect(h.stt.attempts).toHaveLength(1); // no retry after close
    expect(h.stt.streams).toHaveLength(0);
  });

  it('a TTS failure while warming up is not fatal: the greeting opens TTS again', async () => {
    const tts = new FakeTextToSpeech({ msPerChar: 25, failOpen: new ProviderError('fake-tts', 'unavailable', 'network'), failOpenTimes: 1 });
    const h = track(createHarness({ tts, greeting: 'أهلاً وسهلاً' }));
    await h.session.start();
    await waitFor(() => summaries(h).some((t) => t.kind === 'greeting'), 3000, 'greeting');
    expect(summaries(h).find((t) => t.kind === 'greeting')?.outcome).toBe('completed');
    expect(tts.opened).toBe(1); // the failed warm-up, then one successful open
  });
});

describe('VoiceSession — a stuck STT commit and speakerphone echo (observed live 2026-11-10)', () => {
  const GREETING = 'هلا والله، معك مُجيب من مجمّع مُجيب الطبي. كيف أقدر أخدمك؟';
  const lastUser = (llm: FakeLanguageModel, call: number) => llm.calls[call]?.messages.at(-1)?.text;

  it('the greeting coming back misheard ("خلوا والله") does not cut the greeting short', async () => {
    const h = track(createHarness({ greeting: GREETING, transport: new FakeTransport({ playbackSpeed: 0.5 }) }));
    await h.session.start();
    await waitFor(() => h.session.currentState === 'speaking', 3000, 'greeting playing');
    h.sttStream.partial('خلوا والله');
    h.sttStream.partial('خلوا والله.');
    await waitFor(() => summaries(h).length === 1, 5000, 'greeting');
    expect(summaries(h)[0]).toMatchObject({ kind: 'greeting', outcome: 'completed' });
  });

  it('a single word heard during the greeting is taken for its echo (observed live: "أنا" on a silent speakerphone line)', async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, greeting: GREETING, transport: new FakeTransport({ playbackSpeed: 0.5 }) }));
    await h.session.start();
    await waitFor(() => h.session.currentState === 'speaking', 3000, 'greeting playing');
    h.sttStream.partial('أنا');
    h.sttStream.commit('أنا');
    await waitFor(() => summaries(h).length === 1, 5000, 'greeting');
    expect(summaries(h)[0]).toMatchObject({ kind: 'greeting', outcome: 'completed' });
    expect(summaries(h)[0]?.barge_in?.candidates ?? 0).toBe(0); // not even a pause
    await delay(300);
    expect(llm.calls).toHaveLength(0);
    expect(h.session.stats.greetingWordsIgnored).toBe(2);
  });

  it("the greeting's one-word echo is not answered when its commit comes after the greeting ended", async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, greeting: GREETING, transport: new FakeTransport({ playbackSpeed: 0.5 }) }));
    await h.session.start();
    await waitFor(() => h.session.currentState === 'speaking', 3000, 'greeting playing');
    h.sttStream.partial('أنا'); // heard during the greeting…
    await waitFor(() => summaries(h).length === 1, 5000, 'greeting');
    await delay(500); // …committed well after it (past the echo tail)
    h.sttStream.commit('أنا');
    await delay(300);
    expect(llm.calls).toHaveLength(0);
    expect(h.session.currentState).toBe('listening');
  });

  it('around the greeting, two words are the caller: they interrupt and get an answer; one word later on is answered', async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, greeting: GREETING, transport: new FakeTransport({ playbackSpeed: 0.5 }) }));
    await h.session.start();
    await waitFor(() => h.session.currentState === 'speaking', 3000, 'greeting playing');
    h.sttStream.partial('ابي موعد');
    await waitFor(() => summaries(h).length === 1, 3000, 'greeting interrupted');
    expect(summaries(h)[0]).toMatchObject({ kind: 'greeting', outcome: 'interrupted' });
    h.sttStream.commit('ابي موعد');
    await waitFor(() => llm.calls.length === 1, 3000, 'answered');
    await waitFor(() => summaries(h).length === 2, 5000);
    await delay(400); // past the greeting's echo tail
    h.sttStream.commit('نعم');
    await waitFor(() => llm.calls.length === 2, 3000, 'one word, answered');
    expect(lastUser(llm, 1)).toBe('نعم');
  });

  it('a single word before the greeting\'s audio starts does not cancel the greeting', async () => {
    const h = track(createHarness({ greeting: GREETING, tts: { msPerChar: 25, firstAudioDelayMs: 400 } }));
    await h.session.start();
    expect(h.session.currentState).toBe('thinking'); // the greeting is being synthesized
    h.sttStream.partial('أنا');
    await waitFor(() => summaries(h).length === 1, 5000, 'greeting');
    expect(summaries(h)[0]).toMatchObject({ kind: 'greeting', outcome: 'completed' });
  });

  it('words the STT never commits are answered once they stop changing, and its late commit is not answered twice', async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, config: { stalePartialCommitMs: 300 } }));
    await h.session.start();
    h.transport.feed([...frames(true, 15), ...frames(false, 40)]); // the caller speaks (the local VAD hears it)
    const said = Date.now();
    h.sttStream.partial('ابي موعد');
    const hum = setInterval(() => h.sttStream.partial('ابي موعد.'), 30); // steady noise: the same partial, no commit
    try {
      await waitFor(() => llm.calls.length === 1, 3000, 'answered without a commit');
      expect(Date.now() - said).toBeGreaterThanOrEqual(280);
      expect(lastUser(llm, 0)).toBe('ابي موعد');
      await waitFor(() => summaries(h).length === 1, 5000);
      h.sttStream.commit('ابي موعد'); // the STT's commit finally comes: already answered
      await delay(300);
    } finally {
      clearInterval(hum);
    }
    expect(llm.calls).toHaveLength(1);
    expect(summaries(h).map((s) => `${s.kind}:${s.outcome}`)).toEqual(['user:completed']);
    expect(h.session.stats.stalePartialCommits).toBe(1);
  });

  it('a late commit with more words passes on only the words past those already answered', async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, config: { stalePartialCommitMs: 200 } }));
    await h.session.start();
    h.transport.feed([...frames(true, 15), ...frames(false, 40)]);
    h.sttStream.partial('ابي موعد');
    await waitFor(() => summaries(h).length === 1, 5000, 'answered');
    h.sttStream.commit('ابي موعد بكرة');
    await waitFor(() => llm.calls.length === 2, 3000, 'the rest');
    expect(lastUser(llm, 1)).toBe('بكره'); // normalized: only the new word
  });

  it('words the STT made out of a silent line are not answered (observed live: "No." with no speech on the line)', async () => {
    const llm = new FakeLanguageModel();
    const h = track(createHarness({ llm, config: { stalePartialCommitMs: 200 } }));
    await h.session.start();
    h.transport.feed(frames(false, 40)); // the line carries only quiet: the local VAD hears no speech
    h.sttStream.partial('No.');
    await delay(600);
    expect(llm.calls).toHaveLength(0);
    expect(h.session.stats.stalePartialCommits).toBe(0);
    expect(h.session.currentState).toBe('listening');
  });

  it('nothing is answered from a partial heard while Mujeeb spoke, or with stalePartialCommitMs 0', async () => {
    const llm = new FakeLanguageModel();
    const speaking = track(createHarness({ llm, greeting: GREETING, config: { stalePartialCommitMs: 300 }, transport: new FakeTransport({ playbackSpeed: 0.5 }) }));
    await speaking.session.start();
    await waitFor(() => speaking.session.currentState === 'speaking', 3000, 'greeting playing');
    speaking.sttStream.partial('هلا والله معك مجيب'); // echo, judged by the barge-in policy
    await waitFor(() => summaries(speaking).length === 1, 5000, 'greeting');
    await delay(500);
    expect(llm.calls).toHaveLength(0);

    const offLlm = new FakeLanguageModel();
    const off = track(createHarness({ llm: offLlm }));
    await off.session.start();
    off.sttStream.partial('ابي موعد');
    await delay(500);
    expect(offLlm.calls).toHaveLength(0);
  });
});

describe('VoiceSession — phone: caller silence and the maximum call length', () => {
  const PROMPT = 'ألو؟ تسمعني؟';
  const GOODBYE = 'يبدو إن الخط فيه مشكلة. نعتذر منك، وتقدر تتصل علينا بأي وقت. مع السلامة.';
  const MAX_GOODBYE = 'نعتذر منك، وصلنا للحد الأقصى لمدة المكالمة. تقدر تتصل علينا مرة ثانية بأي وقت. مع السلامة.';
  const PHONE = { silence: { promptText: PROMPT, goodbyeText: GOODBYE }, maxDurationGoodbyeText: MAX_GOODBYE };
  const ending = (overrides: Partial<{ silencePromptMs: number; silenceHangupMs: number; maxCallMs: number; maxCallTurnGraceMs: number }>) => ({
    callEnding: { silencePromptMs: 200, silenceHangupMs: 150, maxCallMs: 0, maxCallTurnGraceMs: 2000, ...overrides },
  });
  const kinds = (h: ReturnType<typeof createHarness>) => summaries(h).map((s) => `${s.kind}:${s.outcome}`);

  it('checks a silent line, then says goodbye and hangs up (caller_silent)', async () => {
    const h = track(createHarness({ greeting: 'هلا والله', phone: PHONE, config: ending({}) }));
    await h.session.start();
    await waitFor(() => h.session.currentState === 'closed', 5000, 'hang-up');
    expect(kinds(h)).toEqual(['greeting:completed', 'silence_prompt:completed', 'silence_goodbye:completed']);
    expect(h.transport.closedReason).toBe('caller_silent');
    expect(h.session.stats.silencePrompts).toBe(1);
    expect(h.session.history().map((m) => m.text)).toContain(PROMPT); // the model knows it asked
    expect((h.llm as FakeLanguageModel).calls).toHaveLength(0); // fixed words, no model
  });

  it('a caller who answers the check keeps the call, and a later silence is checked again before any goodbye', async () => {
    const h = track(createHarness({ phone: PHONE, config: ending({}) }));
    await h.session.start();
    await waitFor(() => summaries(h).some((s) => s.kind === 'silence_prompt'), 3000, 'first check');
    h.sttStream.commit('إيه معك');
    await waitFor(() => h.session.currentState === 'closed', 6000, 'hang-up');
    expect(kinds(h)).toEqual(['silence_prompt:completed', 'user:completed', 'silence_prompt:completed', 'silence_goodbye:completed']);
    expect(h.session.stats.silencePrompts).toBe(2);
  });

  it('silence means no new words: sound on the line (VAD) does not hold the clock', async () => {
    const h = track(createHarness({ phone: PHONE, config: ending({}) }));
    await h.session.start();
    const started = Date.now();
    h.transport.feed(frames(true, 15)); // sound with no words (an AC hum, a TV), and it never ends
    await waitFor(() => h.states().includes('thinking'), 3000, 'check'); // held by the VAD, it would never come
    expect(Date.now() - started).toBeLessThan(1500);
    await waitFor(() => summaries(h).length === 1, 3000);
    expect(summaries(h)[0]?.kind).toBe('silence_prompt');
  });

  it('a partial the STT keeps repeating is not speech (observed live: an AC hum on speakerphone held one partial ~30 s)', async () => {
    const h = track(createHarness({ phone: PHONE, config: ending({}) }));
    await h.session.start();
    h.sttStream.partial('خلوا والله'); // the first time, these are new words…
    const repeat = setInterval(() => h.sttStream.partial('خلوا والله.'), 30); // …then the same words over and over
    try {
      await waitFor(() => h.session.currentState === 'closed', 5000, 'hang-up despite the repeats');
    } finally {
      clearInterval(repeat);
    }
    // The repeats neither held the clock nor cut the check or the goodbye short.
    expect(kinds(h)).toEqual(['silence_prompt:completed', 'silence_goodbye:completed']);
    expect(h.transport.closedReason).toBe('caller_silent');
    expect(h.session.stats.partialRepeatsIgnored).toBeGreaterThan(5);
  });

  it('new words hold the clock: the check comes only after the caller stops adding words', async () => {
    const h = track(createHarness({ phone: PHONE, config: ending({ silencePromptMs: 500 }) }));
    await h.session.start();
    const words = ['ابي', 'موعد', 'عند', 'دكتور', 'الاسنان', 'يوم', 'الاحد', 'الصبح'];
    let lastWord = Date.now();
    for (let i = 1; i <= words.length; i += 1) {
      h.sttStream.partial(words.slice(0, i).join(' ')); // a slow speaker: a new word every 100 ms, 800 ms in all
      lastWord = Date.now();
      await delay(100);
    }
    expect(summaries(h)).toEqual([]); // 800 ms of words, no check though the limit is 500 ms
    await waitFor(() => h.states().includes('thinking'), 3000, 'check');
    expect(Date.now() - lastWord).toBeGreaterThanOrEqual(480);
  });

  it("Mujeeb's own echo right after it spoke is not the caller", async () => {
    const config = { echoTailMs: 1000, ...ending({ silencePromptMs: 600 }) };
    const h = track(createHarness({ phone: PHONE, config, greeting: 'هلا والله معك مجيب من العيادة' }));
    await h.session.start();
    await waitFor(() => summaries(h).length === 1, 3000, 'greeting');
    const greetingEnd = Date.now();
    await delay(400);
    h.sttStream.partial('هلا والله معك مجيب من العيادة'); // the greeting coming back through the speakerphone
    await waitFor(() => h.states().filter((s) => s === 'thinking').length === 2, 3000, 'check');
    // Counted from the greeting's end (≈600 ms), not restarted by the echo 400 ms later (≈1000 ms).
    const elapsed = Date.now() - greetingEnd;
    expect(elapsed).toBeGreaterThanOrEqual(570);
    expect(elapsed).toBeLessThan(900);
    await waitFor(() => summaries(h).length === 2, 3000);
    expect(summaries(h)[1]?.kind).toBe('silence_prompt');
  });

  it('no check while the caller dictates a number or while Mujeeb is still working on an answer', async () => {
    const held = track(createHarness({ phone: PHONE, config: { numberHoldMs: 400, ...ending({}) } }));
    await held.session.start();
    held.sttStream.commit('رقم الهوية 1234'); // waits 400 ms for the rest, longer than the 200 ms silence limit
    await waitFor(() => summaries(held).length >= 1, 3000);
    expect(summaries(held)[0]?.kind).toBe('user');

    const slow = track(createHarness({ llm: { firstTokenDelayMs: 400 }, phone: PHONE, config: ending({}) }));
    await slow.session.start();
    slow.sttStream.commit('ابي موعد');
    await waitFor(() => summaries(slow).length >= 2, 4000);
    expect(kinds(slow).slice(0, 2)).toEqual(['user:completed', 'silence_prompt:completed']);
  });

  it('a caller who speaks over the goodbye stops the hang-up', async () => {
    const h = track(createHarness({ phone: PHONE, config: ending({}), transport: new FakeTransport({ playbackSpeed: 0.5 }) }));
    await h.session.start();
    await waitFor(
      () => h.session.currentState === 'speaking' && h.events.some((e) => e.type === 'assistant_segment' && GOODBYE.startsWith(e.text)),
      6000,
      'goodbye playing',
    );
    h.sttStream.partial('لا أنا معك موجود');
    h.sttStream.commit('لا أنا معك موجود');
    await waitFor(() => summaries(h).some((s) => s.kind === 'user' && s.outcome === 'completed'), 5000, 'answer');
    expect(kinds(h).slice(0, 2)).toEqual(['silence_prompt:completed', 'silence_goodbye:interrupted']);
    expect(h.transport.closedReason).toBeUndefined();
  });

  it('off for browser sessions (no phone options) and when MUJEEB_SILENCE_PROMPT_MS is 0', async () => {
    const browser = track(createHarness({ greeting: 'هلا', config: ending({ maxCallMs: 150 }) }));
    const off = track(createHarness({ greeting: 'هلا', phone: PHONE, config: ending({ silencePromptMs: 0 }) }));
    await Promise.all([browser.session.start(), off.session.start()]);
    await delay(700);
    for (const h of [browser, off]) {
      expect(kinds(h)).toEqual(['greeting:completed']);
      expect(h.session.currentState).toBe('listening');
    }
  });

  it('at the maximum length while waiting: the goodbye, then the hang-up (max_duration); the caller cannot talk over it', async () => {
    const h = track(createHarness({ phone: { maxDurationGoodbyeText: MAX_GOODBYE }, config: ending({ maxCallMs: 200 }), transport: new FakeTransport({ playbackSpeed: 0.5 }) }));
    await h.session.start();
    await waitFor(() => h.session.currentState === 'speaking', 3000, 'goodbye playing');
    h.sttStream.partial('لحظة لحظة عندي سؤال');
    h.sttStream.commit('لحظة لحظة عندي سؤال');
    await waitFor(() => h.session.currentState === 'closed', 5000, 'hang-up');
    expect(kinds(h)).toEqual(['max_duration_goodbye:completed']);
    expect(h.transport.closedReason).toBe('max_duration');
  });

  it('at the maximum length during an answer: the answer finishes first, then the goodbye', async () => {
    const h = track(createHarness({ llm: { firstTokenDelayMs: 300 }, phone: PHONE, config: ending({ maxCallMs: 100 }) }));
    await h.session.start();
    h.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => h.session.currentState === 'closed', 5000, 'hang-up');
    expect(kinds(h)).toEqual(['user:completed', 'max_duration_goodbye:completed']);
    expect(h.transport.closedReason).toBe('max_duration');
  });

  it('a turn that outlasts the grace is cut off; without goodbye words the call just ends', async () => {
    const stuck = track(createHarness({ llm: { firstTokenDelayMs: 450 }, phone: PHONE, config: ending({ maxCallMs: 100, maxCallTurnGraceMs: 150 }) }));
    await stuck.session.start();
    stuck.sttStream.commit('ابي اعرف الدوام');
    await waitFor(() => stuck.session.currentState === 'closed', 3000, 'forced hang-up');
    expect(stuck.transport.closedReason).toBe('max_duration');
    expect(kinds(stuck)).toEqual(['user:cancelled']);

    const wordless = track(createHarness({ phone: {}, config: ending({ maxCallMs: 150 }) }));
    await wordless.session.start();
    await waitFor(() => wordless.session.currentState === 'closed', 3000, 'hang-up');
    expect(wordless.transport.closedReason).toBe('max_duration');
    expect(summaries(wordless)).toEqual([]);
  });

  it('createVoiceSession turns this on for phone calls only, with the clinic profile words', async () => {
    const profile = await loadAgentProfile('config/agents/showcase-clinic');
    const runtime: AgentRuntime = {
      profile,
      providers: { stt: new FakeSpeechToText({ mode: 'scripted' }), llm: new FakeLanguageModel(), tts: new FakeTextToSpeech({ msPerChar: 5 }) },
      sessionConfig: { ...TEST_CONFIG, ...ending({}) },
      metrics: new MemoryTurnSink(),
    };
    const sessionFor = (channel: 'phone' | 'browser') => {
      const transport = new FakeTransport();
      const session = createVoiceSession(runtime, { sessionId: `ses_${channel}`, channel, transport, log: silentLogger });
      open.push(session);
      return { session, transport };
    };
    const phone = sessionFor('phone');
    const browser = sessionFor('browser');
    await Promise.all([phone.session.start(), browser.session.start()]);
    await waitFor(() => phone.session.currentState === 'closed', 8000, 'phone hang-up');
    expect(phone.transport.closedReason).toBe('caller_silent');
    expect(phone.session.history().map((m) => m.text)).toContain(profile.phone?.silencePromptText);
    expect(browser.session.currentState).toBe('listening');
    expect(browser.session.stats.silencePrompts).toBe(0);
  });
});
