import { describe, expect, it } from 'vitest';
import { ElevenLabsTts } from '../../src/adapters/elevenlabs/multi-context-tts.js';
import { ElevenLabsRealtimeStt } from '../../src/adapters/elevenlabs/realtime-stt.js';
import { spokenDateTime } from '../../src/agent/tools/spoken-arabic.js';
import { loadSettings } from '../../src/config/settings.js';
import { pcm16 } from '../../src/core/audio.js';
import { silentLogger } from '../../src/core/logger.js';

/**
 * Paid, opt-in: the deterministic read-back phrases, synthesized by ElevenLabs TTS and transcribed back by
 * ElevenLabs STT (`npm run test:live`). Checks that Saudi forms such as "ثلطعش" are heard as the right day
 * (13, not 15) and that "إلّا ثُلث" is not heard as "إلا ثلاث". Synthetic text only.
 */

const env = process.env;
const ENABLED = Boolean(env['ELEVENLABS_API_KEY'] && env['MUJEEB_STT_MODEL'] && env['MUJEEB_TTS_MODEL'] && env['MUJEEB_TTS_VOICE_ID']);
const FORMAT = pcm16(16000);
const NOW = new Date('2026-10-13T06:00:00Z');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* once(text: string): AsyncGenerator<string> {
  await Promise.resolve();
  yield text;
}

describe.skipIf(!ENABLED)('live: spoken appointment dates survive ElevenLabs TTS → STT', () => {
  it('is heard with the right day, month and time', async () => {
    const s = loadSettings({ ...env, MUJEEB_LLM_PROVIDER: 'fake', MUJEEB_SCHEDULING_PROVIDER: 'none' });
    const key = s.elevenlabs.apiKey ?? '';
    const tts = new ElevenLabsTts({ apiKey: key, baseUrl: s.elevenlabs.baseUrl, model: s.tts.model ?? '', voiceId: s.tts.voiceId ?? '', zeroRetention: s.elevenlabs.zeroRetention });
    const cases: { at: string; expect: RegExp[] }[] = [
      { at: '2026-10-13T13:00:00Z', expect: [/13|ثلطعش|ثلتاش|ثلاثطعش/, /أكتوبر/, /أربع/] }, // Tue 13 Oct, 16:00 — the date the model once misread as the 15th
      { at: '2026-10-15T14:00:00Z', expect: [/15|خمسطعش|خمستاش/, /أكتوبر/, /خمس/] }, // Thu 15 Oct, 17:00
      { at: '2026-10-14T13:40:00Z', expect: [/14|أربعطعش|أربعتاش/, /إلا ثلث|4:40|16:40/] }, // Wed 14 Oct, 16:40
    ];
    const session = await tts.open({ format: FORMAT, log: silentLogger });
    try {
      for (const [i, c] of cases.entries()) {
        const phrase = spokenDateTime(new Date(c.at), 'Asia/Riyadh', NOW);
        const audio: Uint8Array[] = [];
        for await (const chunk of session.speak({ utteranceId: `live-date-${i}`, text: once(phrase), signal: AbortSignal.timeout(20_000) })) audio.push(chunk.data);
        const transcript = await transcribe(s, key, audio);
        process.stdout.write(`\n[live] TTS: ${phrase}\n[live] STT: ${transcript}\n`);
        for (const pattern of c.expect) expect(transcript).toMatch(pattern);
        expect(transcript).not.toMatch(/إلا ثلاث/);
      }
    } finally {
      await session.close();
    }
  }, 120_000);
});

async function transcribe(s: ReturnType<typeof loadSettings>, apiKey: string, audio: Uint8Array[]): Promise<string> {
  const stt = new ElevenLabsRealtimeStt({
    apiKey,
    baseUrl: s.elevenlabs.baseUrl,
    model: s.stt.model ?? '',
    languageCode: s.stt.languageCode,
    commitStrategy: 'vad',
    vadSilenceSecs: s.stt.vadSilenceSecs,
    zeroRetention: s.elevenlabs.zeroRetention,
  });
  const committed: string[] = [];
  const stream = await stt.open({
    format: FORMAT,
    onEvent: (e) => {
      if (e.type === 'committed' && e.text.trim() !== '') committed.push(e.text.trim());
    },
    signal: AbortSignal.timeout(30_000),
    log: silentLogger,
  });
  const all = Buffer.concat(audio.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  for (let o = 0; o < all.length; o += 3200) {
    stream.sendAudio(new Uint8Array(all.subarray(o, o + 3200)));
    await delay(20);
  }
  for (let k = 0; k < 25; k += 1) {
    stream.sendAudio(new Uint8Array(3200)); // silence → VAD commit
    await delay(20);
  }
  const deadline = Date.now() + 8000;
  while (committed.length === 0 && Date.now() < deadline) await delay(50);
  await stream.close();
  return committed.join(' ');
}
