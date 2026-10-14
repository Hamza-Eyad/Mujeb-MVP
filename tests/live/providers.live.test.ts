import { describe, expect, it } from 'vitest';
import { OpenAiResponsesModel } from '../../src/adapters/openai/responses-model.js';
import { runElevenLabsProbe } from '../../src/app/elevenlabs-probe.js';
import { loadSettings } from '../../src/config/settings.js';
import { createJsonLogger } from '../../src/observability/logger.js';

/**
 * Paid, opt-in checks against the real providers: `npm run test:live` (reads `.env`).
 * Never part of `npm test`. Uses synthetic text only — no patient data.
 */

const env = process.env;
const hasOpenAi = Boolean(env['OPENAI_API_KEY'] && env['MUJEEB_LLM_MODEL']);
const hasElevenLabs = Boolean(env['ELEVENLABS_API_KEY'] && env['MUJEEB_STT_MODEL'] && env['MUJEEB_TTS_MODEL'] && env['MUJEEB_TTS_VOICE_ID']);

describe.skipIf(!hasOpenAi)('live: OpenAI Responses streaming', () => {
  it('streams an Arabic reply and reports time to first token', async () => {
    const settings = loadSettings({ ...env, MUJEEB_STT_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake' });
    const model = new OpenAiResponsesModel({
      apiKey: settings.llm.apiKey ?? '',
      model: settings.llm.model ?? '',
      ...(settings.llm.reasoningEffort ? { reasoningEffort: settings.llm.reasoningEffort } : {}),
      maxOutputTokens: settings.llm.maxOutputTokens ?? 200,
    });
    const started = performance.now();
    let firstToken: number | undefined;
    let text = '';
    for await (const event of model.stream(
      { instructions: 'رد بجملة قصيرة باللهجة السعودية.', messages: [{ role: 'user', text: 'هلا، كيف الحال؟' }] },
      { signal: AbortSignal.timeout(30_000) },
    )) {
      if (event.type === 'text_delta') {
        firstToken ??= performance.now() - started;
        text += event.text;
      }
    }
    process.stdout.write(`\n[live] openai ttft_ms=${Math.round(firstToken ?? -1)} chars=${text.length}\n`);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasElevenLabs)('live: ElevenLabs probe', () => {
  it('verifies commit strategy / zero retention / TTS→STT round trip on this account', async () => {
    const settings = loadSettings({ ...env, MUJEEB_LLM_PROVIDER: 'fake' });
    const result = await runElevenLabsProbe(settings, createJsonLogger({ level: 'warn' }));
    process.stdout.write(`\n[live] ${JSON.stringify(result, null, 2)}\n`);
    expect(result.stt[0]?.outcome).toBe('accepted');
    expect(result.tts?.outcome).toBe('ok');
  });
});
