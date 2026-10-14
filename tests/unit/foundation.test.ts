import { describe, expect, it } from 'vitest';
import { AsyncQueue, raceAbort, sleep } from '../../src/core/async.js';
import { durationMs, pcm16, pcm16Samples } from '../../src/core/audio.js';
import { CancelledError, ProviderError } from '../../src/core/errors.js';
import { createJsonLogger } from '../../src/observability/logger.js';
import { latencyPercentiles } from '../../src/observability/turn-metrics.js';
import { TurnTimeline } from '../../src/observability/turn-timeline.js';

describe('AsyncQueue', () => {
  it('delivers pushed items in order and ends', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => {
      q.push(2);
      q.end();
    }, 5);
    const seen: number[] = [];
    for await (const n of q) seen.push(n);
    expect(seen).toEqual([1, 2]);
  });

  it('propagates failures to the consumer', async () => {
    const q = new AsyncQueue<number>();
    setTimeout(() => q.fail(new Error('boom')), 5);
    await expect(async () => {
      for await (const _ of q) {
        /* drain */
      }
    }).rejects.toThrow('boom');
  });
});

describe('abort helpers', () => {
  it('sleep rejects with the abort reason', async () => {
    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);
    controller.abort(new CancelledError('test'));
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('raceAbort rejects even if the promise never settles', async () => {
    const controller = new AbortController();
    const pending = raceAbort(new Promise<never>(() => {}), controller.signal);
    controller.abort(new CancelledError('stop'));
    await expect(pending).rejects.toThrow('cancelled: stop');
  });
});

describe('audio helpers', () => {
  it('computes durations and handles unaligned buffers', () => {
    expect(durationMs(640, pcm16(16000))).toBe(20);
    const raw = new Uint8Array([0, 1, 0, 2, 0]);
    const unaligned = raw.subarray(1, 5); // byteOffset 1
    expect(Array.from(pcm16Samples(unaligned))).toEqual([1, 2]); // bytes [1,0,2,0] little-endian
  });
});

describe('ProviderError', () => {
  it('derives retryability from kind', () => {
    expect(new ProviderError('x', 'timeout', 'slow').retryable).toBe(true);
    expect(new ProviderError('x', 'auth', 'nope').retryable).toBe(false);
  });
});

describe('JSON logger', () => {
  it('redacts secret-looking keys at any depth and respects level', () => {
    const lines: string[] = [];
    const log = createJsonLogger({ level: 'info', write: (l) => lines.push(l) }).child({ session_id: 's1' });
    log.debug('hidden');
    log.info('provider.config', { apiKey: 'sk-123', nested: { authorization: 'Bearer x', ok: 1 } });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({ event: 'provider.config', session_id: 's1', apiKey: '[redacted]' });
    expect(record['nested']).toEqual({ authorization: '[redacted]', ok: 1 });
    expect(lines[0]).not.toContain('sk-123');
  });
});

describe('TurnTimeline', () => {
  it('derives stage durations from monotonic marks', () => {
    let now = 0;
    const t = new TurnTimeline(() => now);
    t.mark('user_speech_end', { at: 100 });
    t.mark('stt_committed', { at: 400 });
    t.mark('llm_request', { at: 405 });
    t.mark('llm_first_token', { at: 705 });
    t.mark('tts_first_text', { at: 750 });
    t.mark('tts_first_audio', { at: 950 });
    now = 1000;
    t.mark('playback_start');
    t.mark('playback_start', { at: 5000 }); // first write wins
    expect(t.durations()).toEqual({
      stt_finalize_ms: 300,
      llm_ttft_ms: 300,
      tts_ttfb_ms: 200,
      first_audio_after_commit_ms: 550,
      playback_buffer_ms: 50,
      e2e_ms: 900,
    });
    expect(t.relativeMarks()['playback_start']).toBe(900);
  });

  it('allows overwrite for moving marks', () => {
    const t = new TurnTimeline(() => 0);
    t.mark('user_speech_end', { at: 10 });
    t.mark('user_speech_end', { at: 20, overwrite: true });
    expect(t.get('user_speech_end')).toBe(20);
  });
});

describe('latencyPercentiles', () => {
  it('computes nearest-rank percentiles per metric', () => {
    const rows = latencyPercentiles(
      Array.from({ length: 20 }, (_, i) => ({ durations_ms: { e2e_ms: (i + 1) * 100 } })),
    );
    expect(rows).toEqual([{ metric: 'e2e_ms', count: 20, p50: 1000, p90: 1800, p95: 1900, max: 2000 }]);
  });
});
