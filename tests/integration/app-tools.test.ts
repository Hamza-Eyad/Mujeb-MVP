import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { runElevenLabsProbe } from '../../src/app/elevenlabs-probe.js';
import { buildLatencyReport, formatLatencyReport } from '../../src/app/latency-report.js';
import { loadSettings } from '../../src/config/settings.js';
import { ConfigError } from '../../src/core/errors.js';
import { silentLogger } from '../../src/core/logger.js';

let http: Server | undefined;
let wss: WebSocketServer | undefined;
afterEach(async () => {
  for (const c of wss?.clients ?? []) c.terminate();
  wss?.close();
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  http = undefined;
});

/**
 * Fake ElevenLabs account that (like the uncertain real case) silently falls back to `vad`
 * when `turn_prediction` is requested and does not apply zero retention.
 */
async function startFakeAccount(): Promise<string> {
  http = createServer();
  wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    wss?.handleUpgrade(req, socket, head, (ws) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.endsWith('/realtime')) {
        // Same shape as the live API (2026-10-08): vad_commit_strategy / disable_logging.
        ws.send(JSON.stringify({ message_type: 'session_started', config: { vad_commit_strategy: true, model_id: url.searchParams.get('model_id'), disable_logging: false } }));
        let chunks = 0;
        ws.on('message', () => {
          chunks += 1;
          if (chunks === 5) ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'مرحبا هذا اختبار قصير من مجيب' }));
        });
      } else {
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          const contextId = msg['context_id'];
          if (typeof msg['text'] === 'string' && msg['text'].trim() !== '') {
            for (let i = 0; i < 4; i += 1) ws.send(JSON.stringify({ audio: Buffer.alloc(3200).toString('base64'), contextId, alignment: { chars: ['م'] } }));
          }
          if (msg['close_context'] === true) ws.send(JSON.stringify({ contextId, isFinal: true }));
        });
      }
    });
  });
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

describe('ElevenLabs probe', () => {
  it('reports what the server actually applied instead of assuming it', async () => {
    const baseUrl = await startFakeAccount();
    const settings = loadSettings({
      ELEVENLABS_API_KEY: 'k',
      MUJEEB_ELEVENLABS_BASE_URL: baseUrl,
      MUJEEB_LLM_PROVIDER: 'fake',
      MUJEEB_STT_MODEL: 'stt-model',
      MUJEEB_TTS_MODEL: 'tts-model',
      MUJEEB_TTS_VOICE_ID: 'voice',
    });
    const result = await runElevenLabsProbe(settings, silentLogger, { timeoutMs: 2000 });
    expect(result.stt.map((c) => [c.requested.commit_strategy, c.requested.zero_retention, c.outcome, c.applied])).toEqual([
      ['vad', false, 'accepted', { commit_strategy: true }],
      ['turn_prediction', false, 'accepted', { commit_strategy: false }],
      ['vad', true, 'accepted', { commit_strategy: true, zero_retention: false }],
    ]);
    expect(result.tts).toMatchObject({ outcome: 'ok', alignment: true, audio_ms: 400 });
    expect(result.roundtrip).toMatchObject({ outcome: 'ok', transcript: 'مرحبا هذا اختبار قصير من مجيب' });
  }, 20_000);
});

/** Account behaving like the real one observed on 2026-10-08: STT key lacks permission, voice needs a paid plan. */
async function startRestrictedAccount(): Promise<string> {
  http = createServer((req, res) => {
    res.writeHead(req.url?.startsWith('/v1/single-use-token') ? 401 : 402, { 'content-type': 'application/json' });
    const message = req.url?.startsWith('/v1/single-use-token')
      ? 'The API key you used is missing the permission speech_to_text to execute this operation.'
      : 'Free users cannot use library voices via the API.';
    res.end(JSON.stringify({ detail: { status: 'x', message } }));
  });
  wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    wss?.handleUpgrade(req, socket, head, (ws) => {
      if (req.url?.includes('/realtime')) {
        ws.send(JSON.stringify({ message_type: 'auth_error', error: 'You must be authenticated to use this endpoint.' }));
        return;
      }
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['context_id']) ws.send(JSON.stringify({ audio: null, isFinal: true, contextId: msg['context_id'] }));
      });
    });
  });
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

describe('ElevenLabs probe diagnostics', () => {
  it('names the real reason when the WebSockets fail opaquely', async () => {
    const baseUrl = await startRestrictedAccount();
    const settings = loadSettings({
      ELEVENLABS_API_KEY: 'k',
      MUJEEB_ELEVENLABS_BASE_URL: baseUrl,
      MUJEEB_LLM_PROVIDER: 'fake',
      MUJEEB_STT_MODEL: 'stt-model',
      MUJEEB_TTS_MODEL: 'tts-model',
      MUJEEB_TTS_VOICE_ID: 'voice',
    });
    const result = await runElevenLabsProbe(settings, silentLogger, { timeoutMs: 2000 });
    expect(result.stt[0]).toMatchObject({ outcome: 'rejected', diagnosis: expect.stringContaining('missing the permission speech_to_text') as unknown });
    expect(result.tts).toMatchObject({ outcome: 'error', diagnosis: expect.stringContaining('HTTP 402') as unknown });
    expect(result.roundtrip).toBeUndefined();
  }, 20_000);
});

describe('latency report', () => {
  it('computes percentiles and outcomes from turn JSONL files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mujeeb-report-'));
    const lines = [
      { outcome: 'completed', false_interruptions: 0, durations_ms: { e2e_ms: 900, llm_ttft_ms: 300 } },
      { outcome: 'completed', false_interruptions: 1, durations_ms: { e2e_ms: 1100, llm_ttft_ms: 500 } },
      { outcome: 'interrupted', false_interruptions: 0, durations_ms: { interrupt_stop_ms: 40 } },
    ];
    writeFileSync(join(dir, 'turns-2026-10-08.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"broken`);
    const report = await buildLatencyReport(dir);
    expect(report.turns).toBe(3);
    expect(report.byOutcome).toEqual({ completed: 2, interrupted: 1 });
    expect(report.falseInterruptions).toBe(1);
    expect(report.rows.find((r) => r.metric === 'e2e_ms')).toMatchObject({ count: 2, p50: 900, p95: 1100 });
    expect(formatLatencyReport(report)).toContain('interrupt_stop_ms');
    expect(report.byChannel).toEqual({ unknown: expect.objectContaining({ turns: 3 }) as unknown });
    expect(formatLatencyReport(report)).not.toContain('── channel:');
  });

  it('reports phone and browser turns separately, and older turns without a channel as unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mujeeb-report-'));
    const lines = [
      { channel: 'browser', outcome: 'completed', false_interruptions: 0, durations_ms: { e2e_ms: 2000 } },
      { channel: 'phone', call_id: '1700.1', outcome: 'completed', false_interruptions: 0, durations_ms: { e2e_ms: 3000 } },
      { channel: 'phone', call_id: '1700.1', outcome: 'completed', false_interruptions: 0, durations_ms: { e2e_ms: 3400 } },
      { outcome: 'completed', false_interruptions: 0, durations_ms: { e2e_ms: 9000 } },
    ];
    writeFileSync(join(dir, 'turns-2026-10-28.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const report = await buildLatencyReport(dir);
    expect(Object.keys(report.byChannel)).toEqual(['phone', 'browser', 'unknown']);
    expect(report.byChannel['phone']?.rows.find((r) => r.metric === 'e2e_ms')).toMatchObject({ count: 2, p50: 3000, p95: 3400 });
    expect(report.byChannel['browser']?.turns).toBe(1);
    expect(report.turns).toBe(4);
    const text = formatLatencyReport(report);
    expect(text).toContain('channels: phone 2, browser 1, unknown 1');
    expect(text.indexOf('── channel: phone')).toBeLessThan(text.indexOf('── channel: browser'));
  });
});

describe('agent profile loader', () => {
  it('loads the demo clinic profile', async () => {
    const profile = await loadAgentProfile('config/agents/demo-clinic');
    expect(profile).toMatchObject({ tenantId: 'demo', agentId: 'demo-clinic', languageCode: 'ar' });
    expect(profile.instructions).toContain('مُجيب');
    expect(profile.greeting).toBeTruthy();
  });

  it('refuses instructions outside the profile directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mujeeb-profile-'));
    writeFileSync(
      join(dir, 'profile.json'),
      JSON.stringify({ tenantId: 't', agentId: 'a', displayName: 'd', languageCode: 'ar', instructionsFile: '../secret.md' }),
    );
    await expect(loadAgentProfile(dir)).rejects.toBeInstanceOf(ConfigError);
  });
});
