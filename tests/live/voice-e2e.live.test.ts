import { afterAll, describe, expect, it } from 'vitest';
import { ElevenLabsTts } from '../../src/adapters/elevenlabs/multi-context-tts.js';
import { spokenDateTime, spokenDigits } from '../../src/agent/tools/spoken-arabic.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { buildSessionConfig, createProviders } from '../../src/app/container.js';
import { type DevServer, startDevServer } from '../../src/app/dev-server.js';
import { describeSettings, loadSettings } from '../../src/config/settings.js';
import { pcm16 } from '../../src/core/audio.js';
import { silentLogger } from '../../src/core/logger.js';
import type { TurnSummary } from '../../src/observability/turn-metrics.js';
import type { TextToSpeech, TtsSession, TtsSpeakOptions } from '../../src/ports/text-to-speech.js';
import { LIVE_MEDPLUM_ENABLED, type LiveMedplum, connectLiveMedplum } from '../support/live-medplum.js';
import { WsBrowserClient } from '../support/ws-browser-client.js';

/**
 * The whole local voice MVP, end to end and in real time: the dev server as `npm run dev` composes it
 * (ElevenLabs realtime STT → OpenAI → Mujeeb tools → Medplum sandbox → ElevenLabs TTS), driven over the
 * browser page's WebSocket protocol by a client that streams a synthesized caller voice and acknowledges
 * playback like the page does. The exact text sent to ElevenLabs TTS is recorded. Paid and opt-in:
 *
 *   MUJEEB_LIVE_MEDPLUM=1 MEDPLUM_CLIENT_ID=… MEDPLUM_CLIENT_SECRET=… npx vitest run --config vitest.live.config.ts tests/live/voice-e2e.live.test.ts
 *
 * Not covered here (manual browser test): the real microphone, speakers and the page's audio worklets.
 */

const env = process.env;
const ENABLED =
  LIVE_MEDPLUM_ENABLED && Boolean(env['OPENAI_API_KEY'] && env['MUJEEB_LLM_MODEL'] && env['ELEVENLABS_API_KEY'] && env['MUJEEB_STT_MODEL'] && env['MUJEEB_TTS_MODEL'] && env['MUJEEB_TTS_VOICE_ID']);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

/** Records every text segment the session sends to the TTS provider, per utterance (= turn id). */
class RecordingTts implements TextToSpeech {
  readonly name: string;
  readonly segments: { utteranceId: string; text: string }[] = [];
  constructor(private readonly inner: TextToSpeech) {
    this.name = inner.name;
  }
  async open(options: Parameters<TextToSpeech['open']>[0]): Promise<TtsSession> {
    const session = await this.inner.open(options);
    const segments = this.segments;
    async function* record(utteranceId: string, text: AsyncIterable<string>): AsyncGenerator<string> {
      for await (const t of text) {
        segments.push({ utteranceId, text: t });
        yield t;
      }
    }
    return {
      speak: (o: TtsSpeakOptions) => session.speak({ ...o, text: record(o.utteranceId, o.text) }),
      close: () => session.close(),
    };
  }
  textOf(turnId: string): string {
    return this.segments
      .filter((s) => s.utteranceId === turnId)
      .map((s) => s.text)
      .join(' ');
  }
}

interface Turn {
  said: string;
  heardAs: string;
  summary: TurnSummary;
  tts: string;
}

const tools = (t: Turn) => t.summary.tool_calls ?? [];
const has = (t: Turn, name: string, outcome?: string) => tools(t).some((c) => c.name === name && (outcome === undefined || c.outcome === outcome));

describe.skipIf(!ENABLED)('live: the local voice MVP end to end (ElevenLabs + OpenAI + Medplum)', () => {
  let m: LiveMedplum | undefined;
  let server: DevServer | undefined;
  let client: WsBrowserClient | undefined;
  let callerVoice: TtsSession | undefined;

  afterAll(async () => {
    client?.close();
    await server?.close();
    await callerVoice?.close();
    if (m) process.stdout.write(`\n[voice-e2e] cleanup: ${(await m.cleanup()).cancelled} leftover appointment(s) cancelled\n`);
  });

  it('books, reschedules and cancels by voice, with the deterministic read-back and the result Medplum holds', async () => {
    m = await connectLiveMedplum();
    const caller = await m.registerTestPatient('صوتي');
    const settings = loadSettings({ ...env, MUJEEB_SCHEDULING_PROVIDER: 'medplum' });
    const profile = await loadAgentProfile(settings.agentProfilePath);
    const providers = createProviders(settings);
    const tts = new RecordingTts(providers.tts);
    const summaries: TurnSummary[] = [];
    server = await startDevServer({
      host: '127.0.0.1',
      port: 0,
      staticDir: 'web/dev-client',
      maxSessions: 1,
      profile,
      providers: { ...providers, tts },
      sessionConfig: buildSessionConfig(settings),
      metrics: { write: (s) => void summaries.push(s), close: () => Promise.resolve() },
      log: silentLogger,
      displayConfig: describeSettings(settings),
      scheduling: { system: m.guarded, readTimeoutMs: settings.scheduling.readTimeoutMs, writeTimeoutMs: settings.scheduling.writeTimeoutMs, confirmGraceMs: settings.voice.toolConfirmGraceMs },
    });

    // The caller's voice: synthesized once per sentence (same TTS provider, its own connection).
    const voice = new ElevenLabsTts({
      apiKey: settings.elevenlabs.apiKey ?? '',
      baseUrl: settings.elevenlabs.baseUrl,
      model: settings.tts.model ?? '',
      voiceId: settings.tts.voiceId ?? '',
      zeroRetention: settings.elevenlabs.zeroRetention,
    });
    callerVoice = await voice.open({ format: pcm16(16000), log: silentLogger });
    let utterance = 0;
    const synth = async (text: string): Promise<Uint8Array> => {
      const parts: Uint8Array[] = [];
      for await (const chunk of (callerVoice as TtsSession).speak({ utteranceId: `caller-${(utterance += 1)}`, text: (async function* () { await Promise.resolve(); yield text; })(), signal: AbortSignal.timeout(30_000) })) parts.push(chunk.data);
      return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    };

    client = await WsBrowserClient.connect(server.url);
    const c = client;
    const userTurns = () => summaries.filter((s) => s.kind === 'user' && s.outcome !== 'cancelled');
    const committedText = (turnId: string) =>
      c.events.filter((e) => e.type === 'user_committed' && e['turnId'] === turnId).map((e) => String(e['text'])).join(' ');
    const transcript: Turn[] = [];
    const record = (said: string, summary: TurnSummary): Turn => {
      const t = { said, heardAs: committedText(summary.turn_id), summary, tts: tts.textOf(summary.turn_id) };
      transcript.push(t);
      const d = summary.durations_ms;
      process.stdout.write(
        `\n[voice-e2e] caller: ${said.replace(/\d{6,}/g, '…')}\n  STT heard: ${t.heardAs.replace(/\d{6,}/g, '…')}\n` +
          `  tools: ${tools(t).map((x) => `${x.name}→${x.outcome}`).join(', ') || '-'} | outcome ${summary.outcome} | rounds ${summary.llm_rounds ?? 0}\n` +
          `  ms: stt_finalize ${d.stt_finalize_ms ?? '-'} · llm_ttft ${d.llm_ttft_ms ?? '-'} · tools ${d.tools_ms ?? 0} · llm_total ${d.llm_total_ms ?? '-'} · tts_ttfb ${d.tts_ttfb_ms ?? '-'} · first_audio_after_commit ${d.first_audio_after_commit_ms ?? '-'} · e2e ${d.e2e_ms ?? '-'}\n` +
          `  TTS ← ${t.tts.replace(/\d{6,}/g, '…')}\n`,
      );
      return t;
    };
    const idle = () => !c.playing && summaries.length > 0 && c.events.filter((e) => e.type === 'state').at(-1)?.['state'] === 'listening';

    /** The caller says one sentence once Mujeeb is quiet; resolves with the turn that answered it. */
    const say = async (text: string): Promise<Turn> => {
      await waitFor(idle, 60_000, 'Mujeeb to finish speaking');
      await delay(500);
      const before = userTurns().length;
      await c.say(await synth(text));
      await waitFor(() => userTurns().length > before && idle(), 120_000, `the answer to "${text}"`);
      return record(text, userTurns().at(-1) as TurnSummary);
    };
    const until = async (goal: (t: Turn) => boolean, sentences: string[]): Promise<Turn> => {
      for (const s of sentences) {
        const t = await say(s);
        if (goal(t)) return t;
      }
      throw new Error(`goal not reached after ${sentences.length} sentences`);
    };

    await waitFor(() => summaries.some((s) => s.kind === 'greeting') && idle(), 60_000, 'the greeting');
    process.stdout.write(`\n[voice-e2e] greeting TTS ← ${tts.segments.map((s) => s.text).join(' ')}\n`);

    // 1. Services and doctors.
    const directory = await say('السلام عليكم، وش التخصصات اللي عندكم؟');
    expect(has(directory, 'search_clinic_directory')).toBe(true);

    // 2. Booking: identity, real availability from Medplum, the read-back, a spoken yes, the real result.
    const id = `رقم هويتي ${spokenDigits(caller.nationalId)}، وتاريخ ميلادي ثلاثة فبراير ألف وتسعمية وواحد وتسعين`;
    const proposed = await until((t) => has(t, 'propose_booking', 'confirmation_required'), [
      `أبي أحجز موعد في الجلدية. ${id}`,
      'أي وقت يناسبني، اختار لي أقرب موعد متاح',
      'الوقت الأول تمام',
      'إيه الأول',
    ]);
    expect(proposed.tts).toContain('للتأكيد: موعد');
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toEqual([]);
    const booked = await say('إيه');
    expect(has(booked, 'confirm_pending_action', 'done')).toBe(true);
    const [appointment] = await m.system.listAppointments(m.ctx(), { patientId: caller.record.id });
    expect(appointment).toMatchObject({ status: 'booked', serviceName: 'الجلدية' });
    const bookedAt = spokenDateTime(appointment?.start ?? new Date(0), m.timeZone, new Date());
    expect(proposed.tts).toContain(bookedAt); // what the caller confirmed is what Medplum holds
    expect(booked.tts).toContain(`تم الحجز`);
    expect(booked.tts).toContain(bookedAt);

    // 3. Rescheduling.
    await until((t) => has(t, 'propose_reschedule', 'confirmation_required'), ['أبي أغيّر الموعد ليوم ثاني', 'أي وقت ثاني متاح يناسبني، الأقرب', 'الأول تمام']);
    const moved = await say('إيه');
    expect(has(moved, 'confirm_pending_action', 'done')).toBe(true);
    const [after] = await m.system.listAppointments(m.ctx(), { patientId: caller.record.id });
    expect(after?.id).toBe(appointment?.id);
    expect(after?.start.getTime()).not.toBe(appointment?.start.getTime());
    expect(moved.tts).toContain(spokenDateTime(after?.start ?? new Date(0), m.timeZone, new Date()));

    // 4. Cancellation, with the caller barging in over the read-back: that yes must not count.
    let bargedTurn: string | undefined;
    const bargeIn = await synth('إيه ألغيه لو سمحت');
    const readingBackCancellation = () => {
      const turnId = tts.segments.at(-1)?.utteranceId;
      return turnId !== undefined && tts.textOf(turnId).includes('للتأكيد: بلغي') && c.playing ? turnId : undefined;
    };
    for (const sentence of ['خلاص أبي ألغي موعدي', 'أبي ألغي الموعد اللي عندي']) {
      await waitFor(idle, 60_000, 'Mujeeb to finish speaking');
      await delay(500);
      const before = userTurns().length;
      await c.say(await synth(sentence));
      // Either the read-back starts playing (barge in over it) or the turn ends without one (try again).
      await waitFor(() => readingBackCancellation() !== undefined || (userTurns().length > before && idle()), 120_000, 'a cancellation read-back');
      bargedTurn = readingBackCancellation();
      if (bargedTurn === undefined) {
        record(sentence, userTurns().at(-1) as TurnSummary);
        continue;
      }
      await delay(700); // part of the read-back has played, not all of it
      await c.say(bargeIn);
      await waitFor(() => summaries.some((s) => s.turn_id === bargedTurn), 60_000, 'the interrupted read-back turn');
      record(sentence, summaries.find((s) => s.turn_id === bargedTurn) as TurnSummary);
      await waitFor(() => userTurns().at(-1)?.turn_id !== bargedTurn && idle(), 120_000, 'the reply to the barge-in');
      break;
    }
    expect(bargedTurn).toBeDefined();
    const interrupted = transcript.at(-1) as Turn;
    expect(interrupted.summary.outcome).toBe('interrupted');
    expect(has(interrupted, 'propose_cancellation', 'confirmation_required')).toBe(true);
    const overTalk = record('إيه ألغيه لو سمحت', userTurns().at(-1) as TurnSummary);
    expect(has(overTalk, 'confirm_pending_action', 'done')).toBe(false); // heard only partly: not consent
    expect(has(overTalk, 'confirm_pending_action', 'read_back_required')).toBe(true);
    expect(overTalk.tts).toContain('للتأكيد: بلغي');
    expect((await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).map((a) => a.id)).toEqual([appointment?.id]);
    const cancelled = await say('إيه');
    expect(has(cancelled, 'confirm_pending_action', 'done')).toBe(true);
    expect(await m.system.listAppointments(m.ctx(), { patientId: caller.record.id })).toEqual([]);

    // Mujeeb never announced a result the scheduling system had not confirmed.
    for (const t of transcript) {
      if (/تم الحجز|انحجز|تم تغيير|تم إلغاء|انلغى/.test(t.tts)) expect(has(t, 'confirm_pending_action', 'done')).toBe(true);
    }

    // Latency summary (user turns that produced audio).
    const audible = transcript.filter((t) => t.summary.durations_ms.e2e_ms !== undefined);
    const stat = (key: keyof TurnSummary['durations_ms']) => {
      const values = audible.map((t) => t.summary.durations_ms[key]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
      return values.length === 0 ? '-' : `median ${values[Math.floor(values.length / 2)]} / max ${values.at(-1)}`;
    };
    process.stdout.write(
      `\n[voice-e2e] ${audible.length} audible turns — e2e_ms ${stat('e2e_ms')} · stt_finalize_ms ${stat('stt_finalize_ms')} · llm_ttft_ms ${stat('llm_ttft_ms')} · ` +
        `tools_ms ${stat('tools_ms')} · llm_total_ms ${stat('llm_total_ms')} · tts_ttfb_ms ${stat('tts_ttfb_ms')} · first_audio_after_commit_ms ${stat('first_audio_after_commit_ms')}\n`,
    );
  }, 900_000);
});
