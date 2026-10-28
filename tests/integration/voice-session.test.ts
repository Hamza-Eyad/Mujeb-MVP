import { afterEach, describe, expect, it } from 'vitest';
import { FakeLanguageModel } from '../../src/adapters/fakes/fake-llm.js';
import { FakeTextToSpeech } from '../../src/adapters/fakes/fake-tts.js';
import { ProviderError } from '../../src/core/errors.js';
import type { VoiceSession } from '../../src/voice/session.js';
import { FakeTransport } from '../support/fake-transport.js';
import { createHarness, delay, frames, waitFor } from '../support/session-harness.js';

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
    h.sttStream.commit('لا');
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
