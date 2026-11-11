import { type AgentToolEvent, type AgentToolbox, AgentTurn } from '../agent/agent-turn.js';
import { Conversation } from '../agent/conversation.js';
import { WaitPhrasePicker } from '../agent/wait-phrases.js';
import { abortReason, raceAbort, sleep, withDeadline } from '../core/async.js';
import { bytesForDuration, concatBytes, durationMs, pcm16Samples } from '../core/audio.js';
import { CancelledError, ProviderError, errorSummary } from '../core/errors.js';
import { newTurnId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { TenantContext } from '../core/tenant.js';
import { LevelHistogram } from '../observability/level-histogram.js';
import type { BargeInStats, LineLevel, TurnKind, TurnOutcome, TurnSummary, TurnSummarySink, VadSegment } from '../observability/turn-metrics.js';
import { type TurnMark, TurnTimeline } from '../observability/turn-timeline.js';
import type { AudioTransport, TransportEvent } from '../ports/audio-transport.js';
import type { LanguageModel } from '../ports/language-model.js';
import type { SpeechToText, SttEvent, SttStream } from '../ports/speech-to-text.js';
import type { TextToSpeech, TtsSession } from '../ports/text-to-speech.js';
import { normalizeArabic, tokenize } from './arabic-text.js';
import { type BargeInDecision, type BargeInPolicy, evaluateBargeIn, isEchoOf } from './barge-in-policy.js';
import { EnergyVad, type EnergyVadOptions } from './energy-vad.js';
import { endsWithNumber } from './number-hold.js';
import { CHUNK_FLUSH, type ChunkerOptions, chunkText } from './text-chunker.js';

/**
 * One live conversation: audio in → STT → LLM → TTS → audio out, with barge-in.
 *
 * Invariant: `current !== null` exactly when state is `thinking` or `speaking`.
 * Every assistant utterance gets a new `epoch`; audio is forwarded only while
 * `activeEpoch === turn.epoch`, so nothing from a cancelled turn can reach the caller.
 */

/** How often a soft pause re-checks whether the caller is still talking before resuming. */
const PAUSE_RECHECK_MS = 250;

/** A caller's first partial lags the start of their speech (≈1.7 s measured live): how far back to look for it. */
const STALE_SPEECH_LEAD_MS = 2000;

const DEFAULT_MAX_TOOL_ROUNDS = 5;
/** Pause before a data-changing tool runs, so a caller who keeps talking ("yes… but") cancels it first. */
const DEFAULT_TOOL_MUTATION_GRACE_MS = 400;
const DEFAULT_TOOL_DRAIN_MS = 10_000;

export type SessionState = 'starting' | 'listening' | 'thinking' | 'speaking' | 'closed';

export interface SessionCounters {
  turns: number;
  interruptions: number;
  falseInterruptions: number;
  echoSuppressed: number;
  backchannelsIgnored: number;
  sttReconnects: number;
  staleChunksDropped: number;
  framesIn: number;
  framesDroppedNoStt: number;
  /** Phone calls: times Mujeeb checked a silent line. */
  silencePrompts: number;
  /** Wait phrases said before a tool (the model's own words not counted). */
  waitPhrasesSpoken: number;
  /** STT partials that repeated the utterance's words (often line noise): ignored. */
  partialRepeatsIgnored: number;
  /** Partials answered without the STT's commit, after their words stopped changing (stalePartialCommitMs). */
  stalePartialCommits: number;
  /** Single words heard around the greeting, ignored as its likely echo (see aroundGreeting). */
  greetingWordsIgnored: number;
}

/** Why a call ends on Mujeeb's side (the `session.close` reason). */
type CallEndReason = 'caller_silent' | 'max_duration';

/** The fixed-text turn that ends the call once it has played, and why. */
const ENDING_TURNS: Partial<Record<TurnKind, CallEndReason>> = { silence_goodbye: 'caller_silent', max_duration_goodbye: 'max_duration' };

/** Phone calls only: the clinic's fixed words for a silent line and for the end of the maximum call length. */
export interface PhoneCallOptions {
  /** Without it, caller silence never ends the call. */
  silence?: { promptText: string; goodbyeText: string };
  /** Said when the call reaches `callEnding.maxCallMs`. Absent: the call is hung up without words. */
  maxDurationGoodbyeText?: string;
}

export type SessionEvent =
  | { type: 'state'; state: SessionState }
  | { type: 'stt_ready'; effective: Record<string, unknown> }
  | { type: 'user_partial'; text: string }
  | { type: 'user_committed'; turnId: string; text: string }
  | { type: 'assistant_segment'; turnId: string; text: string }
  | { type: 'barge_in'; turnId: string; action: 'pause' | 'resume' | 'interrupt' | 'ignored'; reason: string; text?: string }
  | { type: 'turn_summary'; summary: TurnSummary }
  | { type: 'counters'; counters: SessionCounters }
  | { type: 'warning'; code: string; message: string }
  | { type: 'error'; code: string; message: string }
  /** Live telemetry: a timing mark as it happens (session monotonic clock, ms). turnId is null before a turn starts. */
  | { type: 'timeline'; turnId: string | null; mark: TurnMark | 'tts_done'; t: number }
  | { type: 'transport'; rttMs: number }
  /** Marks recorded for a not-yet-started user turn were discarded (echo/noise). */
  | { type: 'pending_reset' }
  /** A tool call started or finished within a turn (name, outcome status, duration). */
  | ({ type: 'tool'; turnId: string } & AgentToolEvent);

export interface VoiceSessionConfig {
  sttChunkMs: number;
  duplexMode: 'full' | 'half';
  falseInterruptionTimeoutMs: number;
  echoTailMs: number;
  llmFirstTokenTimeoutMs: number;
  ttsFirstAudioTimeoutMs: number;
  /** Extra time allowed beyond the audio duration for the far end to confirm playback finished. */
  playbackGraceMs: number;
  clearAckTimeoutMs: number;
  /** Opening STT when the session starts: attempts, each cut off after `attemptTimeoutMs`, with a pause between. */
  sttConnect: { attempts: number; attemptTimeoutMs: number; retryDelayMs: number };
  sttReconnect: { maxAttempts: number; baseDelayMs: number };
  chunker: ChunkerOptions;
  bargeIn: BargeInPolicy;
  vad: EnergyVadOptions;
  logTranscripts: boolean;
  /**
   * Extra wait before answering when the caller's words end with a number (a dictated ID, phone or date usually
   * continues after a pause). Speech in the meantime merges into the same turn. 0 = off.
   */
  numberHoldMs: number;
  /**
   * While Mujeeb waits, a partial whose words have not changed for this long, with no commit from the STT, is
   * answered as if committed (the STT's VAD can take steady noise for speech and hold the commit). 0 = off.
   */
  stalePartialCommitMs: number;
  /**
   * Sessions given `phone` options only. Silence: after `silencePromptMs` without the caller, Mujeeb checks the
   * line; after `silenceHangupMs` more, it says goodbye and hangs up. `maxCallMs`: the longest call, from start();
   * a turn under way gets `maxCallTurnGraceMs` to finish first. 0 = off (silencePromptMs, maxCallMs).
   */
  callEnding: { silencePromptMs: number; silenceHangupMs: number; maxCallMs: number; maxCallTurnGraceMs: number };
}

export interface VoiceSessionDeps {
  sessionId: string;
  tenant: TenantContext;
  agent: {
    instructions: string;
    greeting?: string;
    historyMaxTurns: number;
    /** Rounds per turn that may call tools before the model must answer in text. */
    maxToolRounds?: number;
    toolMutationGraceMs?: number;
    /** How long close() waits for writes still in flight. */
    toolDrainTimeoutMs?: number;
    /** One is said before the first tool of a turn when the model has said nothing yet (e.g. "لحظة أشيك لك."), varied across the call. */
    toolWaitPhrases?: readonly string[];
  };
  /** Phone calls: silence handling and the maximum call length (callEnding). Absent (browser): neither. */
  phone?: PhoneCallOptions;
  transport: AudioTransport;
  stt: SpeechToText;
  llm: LanguageModel;
  tts: TextToSpeech;
  /** Tools for the model (one instance per session). Absent: the text-only path, unchanged. */
  tools?: AgentToolbox;
  config: VoiceSessionConfig;
  log: Logger;
  metrics: TurnSummarySink;
  observer?: (event: SessionEvent) => void;
  now?: () => number;
}

/** Session bookkeeping for one AgentTurn: which of its tool rounds are already in history. */
interface AgentRun {
  readonly agent: AgentTurn;
  /** False when the caller kept talking and the turn is redone with the merged utterance. */
  record: boolean;
  committed: number;
}

/**
 * The STT utterance heard while the turn played: when its first transcript with words arrived, and the VAD segment
 * it began in (its end too, if the segment was already over by then).
 */
interface HeardUtterance {
  readonly firstAt: number;
  readonly words: number;
  readonly segmentStart?: number;
  readonly segmentEnd?: number;
}

interface ActiveTurn {
  readonly id: string;
  readonly kind: TurnKind;
  readonly beganAt: number;
  /** 1, 2, … per caller utterance (a continued utterance keeps its number); 0 for the greeting. */
  readonly userTurn: number;
  agentRun?: AgentRun;
  readonly epoch: number;
  readonly controller: AbortController;
  readonly timeline: TurnTimeline;
  readonly userText: string;
  sentText: string;
  alignedText: string;
  alignmentSeen: boolean;
  heardText: string;
  readonly markText: Map<number, string>;
  lastSentMarkIndex: number;
  ackedMarkIndex: number;
  audioMsSent: number;
  paused: boolean;
  pausedAt: number;
  dismissedTranscript?: string;
  falseInterruptTimer?: NodeJS.Timeout;
  falseInterruptions: number;
  readonly bargeIn: BargeInStats & { vad_segments: VadSegment[] };
  heard?: HeardUtterance;
  /** Incoming frame levels while this turn's audio played, and while nothing played before it. */
  readonly playingLevels: LevelHistogram;
  quietLevels?: LevelHistogram;
  reason?: string;
  finalized: boolean;
}

export class VoiceSession {
  private state: SessionState = 'starting';
  private readonly deps: VoiceSessionDeps;
  private readonly cfg: VoiceSessionConfig;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly lifetime = new AbortController();
  private readonly conversation: Conversation;
  private readonly vad: EnergyVad;
  private readonly sttChunkBytes: number;

  private sttStream: SttStream | undefined;
  private sttGeneration = 0;
  private sttReconnectAttempts = 0;
  private preparing: Promise<void> | undefined;
  private ttsSession: Promise<TtsSession> | undefined;

  private epochCounter = 0;
  private activeEpoch: number | null = null;
  private current: ActiveTurn | null = null;
  private pendingTimeline: TurnTimeline | null = null;
  private carryOverUserText = '';
  /** Caller-turn number of the carried-over text: a continued utterance is still the same turn for confirmations. */
  private carryOverUserTurn: number | undefined;
  /** Waiting for the rest of a dictated number before answering (startOrHoldUserTurn). */
  private numberHoldTimer: NodeJS.Timeout | undefined;
  private userTurnCounter = 0;
  /** The latest tool-using turn; its writes may still be finishing after the turn ended. */
  private lastAgentRun: AgentRun | null = null;
  private lastAssistantText = '';
  private lastPlaybackEndAt = Number.NEGATIVE_INFINITY;
  private lastVadStartAt = Number.NEGATIVE_INFINITY;
  private lastVadEndAt = Number.NEGATIVE_INFINITY;
  /** The VAD segment that began while a turn played, until it ends or that turn does. */
  private vadSegment: { turn: ActiveTurn; segment: VadSegment } | undefined;
  /** Frame levels while nothing played, handed to the next turn whose audio starts. */
  private quietLevels = new LevelHistogram();
  private lastRttMs: number | undefined;
  private sttBuffer: Uint8Array[] = [];
  private sttBufferedBytes = 0;
  /** The current STT utterance's words so far (normalized), to tell new words from a repeated partial. */
  private partialWords: string[] = [];
  /** Words of the current STT utterance already answered without its commit (stale partial): not answered twice. */
  private answeredWords: string[] = [];
  /** When the current STT utterance's first words arrived. */
  private utteranceStartedAt = 0;
  /** The current STT utterance began during the greeting or its echo tail (see aroundGreeting). */
  private utteranceAroundGreeting = false;
  /** When the greeting turn ended (completed, interrupted or cancelled). */
  private greetingEndedAt: number | undefined;
  private stalePartialTimer: NodeJS.Timeout | undefined;
  /** One per session, so the wait phrases vary across the call's turns. */
  private readonly waitPhrases: WaitPhrasePicker | undefined;

  /** Phone calls: what caller silence leads to next (the check, then the goodbye), its timer and when it was set. */
  private silenceStep: 'prompt' | 'goodbye' = 'prompt';
  private silenceTimer: NodeJS.Timeout | undefined;
  private silenceSince = 0;
  /** The call reached its maximum length: it ends as soon as no turn is under way. */
  private maxCallReached = false;
  /** The goodbye that ends the call has started (or the call is being hung up): nothing else starts. */
  private endingCall = false;
  private maxCallGraceTimer: NodeJS.Timeout | undefined;

  private readonly markWaiters = new Map<string, () => void>();
  private readonly awaitingClearAck = new Map<number, ActiveTurn>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly counters: SessionCounters = {
    turns: 0,
    interruptions: 0,
    falseInterruptions: 0,
    echoSuppressed: 0,
    backchannelsIgnored: 0,
    sttReconnects: 0,
    staleChunksDropped: 0,
    framesIn: 0,
    framesDroppedNoStt: 0,
    silencePrompts: 0,
    waitPhrasesSpoken: 0,
    partialRepeatsIgnored: 0,
    stalePartialCommits: 0,
    greetingWordsIgnored: 0,
  };

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps;
    this.cfg = deps.config;
    this.now = deps.now ?? (() => performance.now());
    this.log = deps.log.child({ session_id: deps.sessionId, tenant_id: deps.tenant.tenantId });
    this.conversation = new Conversation({ instructions: deps.agent.instructions, maxTurns: deps.agent.historyMaxTurns });
    this.vad = new EnergyVad(this.cfg.vad);
    this.sttChunkBytes = bytesForDuration(this.cfg.sttChunkMs, deps.transport.inputFormat);
    const phrases = deps.agent.toolWaitPhrases?.filter((p) => p.trim() !== '') ?? [];
    this.waitPhrases = phrases.length > 0 ? new WaitPhrasePicker(phrases, { onPick: () => (this.counters.waitPhrasesSpoken += 1) }) : undefined;
  }

  get currentState(): SessionState {
    return this.state;
  }

  get stats(): Readonly<SessionCounters> {
    return { ...this.counters };
  }

  history(): ReturnType<Conversation['snapshot']> {
    return this.conversation.snapshot();
  }

  /**
   * Connects the providers before anyone hears the session (a phone call is answered only after this).
   * STT must connect: up to `sttConnect.attempts` tries, each aborted after `attemptTimeoutMs` (the attempt's
   * socket is closed, not just ignored), retried only on retryable errors. TTS warms up at the same time,
   * best effort. `deadline` bounds the whole step, pauses included. Rejects when STT cannot connect or the
   * session closes meanwhile. Called again, it returns the same promise.
   */
  prepare(deadline?: AbortSignal): Promise<void> {
    this.preparing ??= this.connectProviders(deadline);
    return this.preparing;
  }

  async start(): Promise<void> {
    await this.prepare();
    if (this.state === 'closed') return;
    const maxCallMs = this.deps.phone ? this.cfg.callEnding.maxCallMs : 0;
    if (maxCallMs > 0) this.setTimer(() => this.onMaxCallLength(), maxCallMs);
    this.setState('listening');
    const greeting = this.deps.agent.greeting;
    if (greeting !== undefined && greeting.trim() !== '') {
      this.beginTurn('greeting', '', this.newTimeline(), greeting);
    }
  }

  async close(reason: string): Promise<void> {
    if (this.state === 'closed') return;
    this.setState('closed');
    this.log.info('session.close', { reason, counters: this.counters });
    this.lifetime.abort(new CancelledError(reason));
    const turn = this.current;
    if (turn) {
      this.current = null;
      this.activeEpoch = null;
      turn.controller.abort(new CancelledError('session_closed'));
      this.finalizeTurn(turn, 'cancelled', 'session_closed');
    }
    for (const pending of this.awaitingClearAck.values()) this.finalizeTurn(pending, 'interrupted', pending.reason);
    this.awaitingClearAck.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.deps.transport.close(reason);
    const closing: Promise<unknown>[] = [];
    if (this.sttStream) closing.push(this.sttStream.close());
    if (this.ttsSession) closing.push(this.ttsSession.then((s) => s.close()));
    await Promise.allSettled(closing);
    if (this.deps.tools) {
      // Writes the caller already confirmed run to completion (and are logged) even though the call ended.
      const stillRunning = await this.deps.tools.drain(this.deps.agent.toolDrainTimeoutMs ?? DEFAULT_TOOL_DRAIN_MS);
      if (stillRunning > 0) this.log.warn('session.closed_with_writes_in_flight', { count: stillRunning });
    }
  }

  // ───────────────────────────── transport ─────────────────────────────

  private onTransportEvent(event: TransportEvent): void {
    if (this.state === 'closed') return;
    switch (event.type) {
      case 'audio':
        this.onAudio(event.data);
        break;
      case 'mark':
        this.onMark(event.name);
        break;
      case 'playback_started':
        if (this.current?.epoch === event.epoch) this.current.timeline.mark('playback_start');
        break;
      case 'playback_cleared':
        this.onPlaybackCleared(event.epoch);
        break;
      case 'rtt':
        this.lastRttMs = event.ms;
        this.emit({ type: 'transport', rttMs: Math.round(event.ms * 10) / 10 });
        break;
      case 'closed':
        void this.close(`transport_closed:${event.reason}`);
        break;
    }
  }

  private onAudio(data: Uint8Array): void {
    this.counters.framesIn += 1;
    const format = this.deps.transport.inputFormat;
    if (format.encoding === 'pcm_s16le') {
      const samples = pcm16Samples(data);
      const vadEvent = this.vad.process(samples, format.sampleRate);
      if (samples.length > 0) this.noteLevel(this.vad.levelDb);
      if (vadEvent?.type === 'speech_start') {
        const at = this.now() - vadEvent.startedMsAgo;
        this.lastVadStartAt = at;
        const speaking = this.state === 'speaking' ? this.current : null;
        if (speaking) {
          speaking.timeline.mark('barge_in_speech_start', { at });
          speaking.bargeIn.vad_starts += 1;
          this.openVadSegment(speaking, vadEvent.onsetMsAgo - vadEvent.startedMsAgo);
        }
        this.ensurePending().mark('user_speech_start', { at });
      } else if (vadEvent?.type === 'speech_end') {
        const at = this.now() - vadEvent.endedMsAgo;
        this.lastVadEndAt = at;
        this.closeVadSegment(vadEvent.lastedMs, false);
        const turn = this.current;
        if (!this.pendingTimeline && turn?.kind === 'user' && !turn.timeline.has('user_speech_end')) {
          turn.timeline.mark('user_speech_end', { at }); // VAD settled after a fast commit
        } else {
          this.ensurePending().mark('user_speech_end', { at, overwrite: true });
        }
      }
    }
    const gate = this.cfg.duplexMode === 'half' && (this.state === 'speaking' || this.withinEchoTail());
    this.bufferForStt(gate ? new Uint8Array(data.byteLength) : data); // half-duplex: keep timing, send silence
  }

  /** Numbers only, never audio: the frame's level goes to the turn whose reply is playing, or to the quiet time before the next one. */
  private noteLevel(db: number): void {
    const playing = this.state === 'speaking' && this.current && !this.current.paused ? this.current : null;
    (playing ? playing.playingLevels : this.quietLevels).add(db);
  }

  private openVadSegment(turn: ActiveTurn, leadMs: number): void {
    const segment: VadSegment = { ms: 0, lead_ms: roundMs(leadMs) };
    turn.bargeIn.vad_segments.push(segment);
    this.vadSegment = { turn, segment };
  }

  /** `open`: the turn ended while the VAD still heard speech, so the length is cut there. */
  private closeVadSegment(lastedMs: number, open: boolean): void {
    const current = this.vadSegment;
    if (!current) return;
    this.vadSegment = undefined;
    current.segment.ms = roundMs(lastedMs);
    if (open) current.segment.open = true;
  }

  private bufferForStt(data: Uint8Array): void {
    this.sttBuffer.push(data);
    this.sttBufferedBytes += data.byteLength;
    if (this.sttBufferedBytes < this.sttChunkBytes) return;
    const chunk = concatBytes(this.sttBuffer);
    this.sttBuffer = [];
    this.sttBufferedBytes = 0;
    if (!this.sttStream) {
      this.counters.framesDroppedNoStt += 1;
      return;
    }
    this.sttStream.sendAudio(chunk);
  }

  private onMark(name: string): void {
    const [epochPart, indexPart] = name.split(':');
    const epoch = Number(epochPart);
    const index = Number(indexPart);
    const turn = this.current;
    if (turn && turn.epoch === epoch && Number.isFinite(index) && index > turn.ackedMarkIndex) {
      turn.ackedMarkIndex = index;
      turn.heardText = turn.markText.get(index) ?? turn.heardText;
    }
    const waiter = this.markWaiters.get(name);
    if (waiter) {
      this.markWaiters.delete(name);
      waiter();
    }
  }

  private onPlaybackCleared(epoch: number): void {
    const turn = this.awaitingClearAck.get(epoch);
    if (!turn) return;
    this.awaitingClearAck.delete(epoch);
    turn.timeline.mark('playback_stopped');
    this.finalizeTurn(turn, 'interrupted', turn.reason);
  }

  // ─────────────────────────────── STT ────────────────────────────────

  private async connectProviders(deadline: AbortSignal | undefined): Promise<void> {
    this.deps.transport.setHandler((event) => this.onTransportEvent(event));
    this.log.info('session.start', {
      input_format: this.deps.transport.inputFormat,
      output_format: this.deps.transport.outputFormat,
      duplex_mode: this.cfg.duplexMode,
      providers: { stt: this.deps.stt.name, llm: this.deps.llm.name, tts: this.deps.tts.name },
    });
    void this.prewarmTts();
    await this.connectStt(deadline);
  }

  /** The first STT connection, with bounded retries. Mid-call reconnects go through scheduleSttReconnect. */
  private async connectStt(deadline: AbortSignal | undefined): Promise<void> {
    const { attempts, attemptTimeoutMs, retryDelayMs } = this.cfg.sttConnect;
    const bound = deadline ? AbortSignal.any([this.lifetime.signal, deadline]) : this.lifetime.signal;
    // Session closed or deadline passed: stop with that reason, never retry.
    const stopped = (): Error | undefined => (this.lifetime.signal.aborted ? abortReason(this.lifetime.signal) : deadline?.aborted ? abortReason(deadline) : undefined);
    for (let attempt = 1; ; attempt += 1) {
      const timeout = withDeadline(bound, attemptTimeoutMs, () => new ProviderError(this.deps.stt.name, 'timeout', `Not connected within ${attemptTimeoutMs} ms`));
      try {
        await this.openStt(timeout.signal);
        return;
      } catch (err) {
        const error = stopped() ?? err;
        if (stopped() || attempt >= attempts || !(error instanceof ProviderError && error.retryable)) throw error;
        this.log.warn('stt.connect_retry', { attempt, ...errorSummary(error) });
      } finally {
        timeout.dispose();
      }
      try {
        await sleep(retryDelayMs, bound);
      } catch (err) {
        throw stopped() ?? err;
      }
    }
  }

  private async openStt(signal: AbortSignal = this.lifetime.signal): Promise<void> {
    const generation = ++this.sttGeneration;
    const opening = this.deps.stt.open({
      format: this.deps.transport.inputFormat,
      signal,
      log: this.log.child({ component: 'stt', provider: this.deps.stt.name }),
      onEvent: (event) => {
        if (generation === this.sttGeneration && this.state !== 'closed') this.onSttEvent(event);
      },
    });
    // Adapters reject when `signal` aborts. A stream that opens anyway after that is closed at once.
    opening.then(
      (late) => {
        if (signal.aborted) void late.close();
      },
      () => undefined,
    );
    const stream = await raceAbort(opening, signal);
    if (this.state === 'closed') {
      await stream.close();
      return;
    }
    this.sttStream = stream;
  }

  private onSttEvent(event: SttEvent): void {
    switch (event.type) {
      case 'ready':
        this.sttReconnectAttempts = 0;
        this.emit({ type: 'stt_ready', effective: event.effective });
        break;
      case 'partial': {
        const text = event.text.trim();
        const words = tokenize(text);
        // The STT repeats an utterance's partial while audio flows, also when that audio is only noise. A partial
        // that repeats words already seen is not the caller saying anything: it neither interrupts nor cancels a
        // reply, nor holds the silence clock (observed live on speakerphone: an AC hum kept one partial alive for
        // ~30 s). Partials without words go on as before (the barge-in policy ignores them, and counts them).
        const startsUtterance = this.partialWords.length === 0;
        if (words.length > 0 && !this.bringsNewWords(words)) {
          this.counters.partialRepeatsIgnored += 1;
          break;
        }
        if (words.length > 0 && startsUtterance) {
          this.utteranceStartedAt = this.now();
          this.utteranceAroundGreeting = this.aroundGreeting();
        }
        if (words.length === 1 && this.utteranceAroundGreeting) {
          this.ignoreGreetingWord(text); // may still grow into real speech: two words go on as usual
          break;
        }
        this.onPartial(text);
        if (words.length > 0) this.armStalePartial(text);
        if (words.length > 0 && !this.isOwnEcho(text)) this.refreshSilenceWatch(); // the caller's words: silence counts from now
        break;
      }
      case 'committed': {
        this.clearStalePartial();
        const answered = this.answeredWords;
        const aroundGreeting = this.utteranceAroundGreeting || this.aroundGreeting();
        this.partialWords = []; // the STT utterance is over: the next partial starts a new one
        this.answeredWords = [];
        this.utteranceAroundGreeting = false;
        // Part of this utterance was already answered from its stale partial: only words past it are new.
        const text = answered.length > 0 ? tokenize(event.text).slice(answered.length).join(' ') : event.text.trim();
        if (answered.length > 0 && text === '') {
          this.log.info('stt.late_commit_already_answered', { words: answered.length });
          break;
        }
        if (aroundGreeting && tokenize(text).length === 1) {
          this.ignoreGreetingWord(text); // its commit often comes after the greeting ended: still the greeting's echo
          if (this.state === 'listening' && this.current === null) this.discardPending();
          break;
        }
        this.onCommitted(text);
        if (text !== '' && !this.isOwnEcho(text)) this.refreshSilenceWatch();
        break;
      }
      case 'warning':
        this.log.warn('stt.warning', errorSummary(event.error));
        this.emit({ type: 'warning', code: `stt_${event.error.kind}`, message: event.error.message });
        break;
      case 'closed':
        this.sttStream = undefined;
        this.partialWords = []; // a reconnected stream starts its utterances afresh
        this.answeredWords = [];
        this.utteranceAroundGreeting = false;
        this.clearStalePartial();
        this.log.warn('stt.closed', event.error ? errorSummary(event.error) : {});
        this.scheduleSttReconnect(event.error);
        break;
    }
  }

  private scheduleSttReconnect(error: ProviderError | undefined): void {
    if (this.state === 'closed') return;
    if (error && !error.retryable) {
      this.emit({ type: 'error', code: 'stt_failed', message: error.message });
      void this.close(`stt_failed:${error.kind}`);
      return;
    }
    if (this.sttReconnectAttempts >= this.cfg.sttReconnect.maxAttempts) {
      this.emit({ type: 'error', code: 'stt_reconnect_exhausted', message: 'Speech recognition connection could not be restored' });
      void this.close('stt_reconnect_exhausted');
      return;
    }
    const delay = this.cfg.sttReconnect.baseDelayMs * 2 ** this.sttReconnectAttempts;
    this.sttReconnectAttempts += 1;
    this.counters.sttReconnects += 1;
    this.emitCounters();
    this.emit({ type: 'warning', code: 'stt_reconnecting', message: `Reconnecting speech recognition (attempt ${this.sttReconnectAttempts})` });
    sleep(delay, this.lifetime.signal)
      .then(() => this.openStt())
      .catch((err: unknown) => {
        if (this.state === 'closed') return;
        this.log.warn('stt.reconnect_failed', errorSummary(err));
        this.scheduleSttReconnect(err instanceof ProviderError ? err : new ProviderError(this.deps.stt.name, 'unavailable', String(err)));
      });
  }

  private onPartial(text: string): void {
    if (text === '') return;
    const turn = this.current;
    if (turn?.kind === 'max_duration_goodbye') return; // the call is ending: the goodbye is not interrupted
    if (turn && this.state === 'speaking') {
      this.handleSpeakingTranscript(turn, text, false);
      return;
    }
    if (turn && this.state === 'thinking') {
      const decision = evaluateBargeIn(text, this.echoTailSpeech(), this.cfg.bargeIn, { final: false });
      if (decision.action === 'ignore') {
        this.countIgnored(turn, decision, text);
        return;
      }
      this.emit({ type: 'user_partial', text });
      this.ensurePending().mark('stt_first_partial');
      this.cancelTurn(turn, 'user_continued'); // the user is still talking — wait for their full utterance
      return;
    }
    this.clearNumberHold(); // the caller is still dictating: the next commit completes the number
    this.emit({ type: 'user_partial', text });
    this.ensurePending().mark('stt_first_partial');
  }

  private onCommitted(text: string): void {
    const turn = this.current;
    if (turn?.kind === 'max_duration_goodbye') return; // the call is ending: the goodbye is not interrupted
    if (turn && this.state === 'speaking') {
      if (text === '') {
        turn.heard = undefined; // the STT utterance ended without words
        return;
      }
      if (this.handleSpeakingTranscript(turn, text, true)) this.startOrHoldUserTurn(text);
      return;
    }
    if (turn && this.state === 'thinking') {
      if (text === '') return;
      const decision = evaluateBargeIn(text, this.echoTailSpeech(), this.cfg.bargeIn, { final: true });
      if (decision.action === 'ignore') {
        this.countIgnored(turn, decision, text);
        return;
      }
      this.cancelTurn(turn, 'user_continued');
      this.startOrHoldUserTurn(text);
      return;
    }
    if (text === '') {
      if (this.carryOverUserText !== '' && this.numberHoldTimer === undefined) this.startUserTurn('');
      return;
    }
    if (this.withinEchoTail() && isEchoOf(text, this.lastAssistantText, this.cfg.bargeIn)) {
      this.counters.echoSuppressed += 1;
      this.discardPending();
      this.log.info('barge_in.echo_tail_suppressed', this.textFields({ text }));
      this.emitCounters();
      return;
    }
    this.startOrHoldUserTurn(text);
  }

  /**
   * Starts the user turn, unless the caller's words so far end with a number: then waits `numberHoldMs` for the rest
   * of a dictated ID, phone or date. Speech in the meantime clears the wait, and its commit merges into this turn.
   */
  private startOrHoldUserTurn(text: string): void {
    this.clearNumberHold();
    const soFar = [this.carryOverUserText, text].filter((part) => part.trim() !== '').join(' ').trim();
    if (this.cfg.numberHoldMs <= 0 || !endsWithNumber(soFar)) {
      this.startUserTurn(text);
      return;
    }
    this.carryOverUserText = soFar;
    this.log.info('turn.number_hold', { ms: this.cfg.numberHoldMs });
    this.numberHoldTimer = this.setTimer(() => {
      this.numberHoldTimer = undefined;
      if (this.state === 'closed') return;
      this.startUserTurn('');
      this.refreshSilenceWatch(); // nothing to answer after all: back to waiting for the caller
    }, this.cfg.numberHoldMs);
    this.refreshSilenceWatch(); // the caller is mid-number: no silence check meanwhile
  }

  private clearNumberHold(): void {
    this.clearTimer(this.numberHoldTimer);
    this.numberHoldTimer = undefined;
  }

  // ───────────────────────────── barge-in ─────────────────────────────

  /** Returns true when the transcript interrupted the current turn. */
  private handleSpeakingTranscript(turn: ActiveTurn, text: string, final: boolean): boolean {
    const agent = { fullText: turn.sentText, spokenSoFar: turn.alignmentSeen ? turn.alignedText : turn.sentText };
    const decision = evaluateBargeIn(text, agent, this.cfg.bargeIn, { final });
    const heard = this.noteHeard(turn, decision);
    if (final) turn.heard = undefined; // a committed transcript ends the STT utterance: what follows is new speech
    if (decision.action === 'ignore') {
      this.countIgnored(turn, decision, text);
      if (final && turn.paused) this.resumeAfterFalseInterruption(turn, `final_${decision.reason}`);
      return false;
    }
    if (decision.action === 'candidate') {
      if (turn.dismissedTranscript === normalizeArabic(text)) return false;
      this.softPause(turn, text);
      return false;
    }
    this.emit({ type: 'user_partial', text });
    this.ensurePending().mark('stt_first_partial');
    if (heard) this.markHeard(turn, heard);
    this.interrupt(turn, final ? 'barge_in_final' : 'barge_in');
    return true;
  }

  /**
   * Measurement only, never a decision: counts the transcript, and opens the utterance it belongs to on its first
   * transcript with words. The utterance's VAD segment is the latest one since the turn began; none if VAD heard
   * nothing new.
   */
  private noteHeard(turn: ActiveTurn, decision: BargeInDecision): HeardUtterance | undefined {
    const stats = turn.bargeIn;
    stats.transcripts += 1;
    const { reason } = decision;
    if (reason === 'echo' || reason === 'backchannel' || reason === 'empty') stats.ignored[reason] += 1;
    if (turn.heard || decision.words === 0) return turn.heard;
    const start = this.lastVadStartAt >= turn.beganAt ? this.lastVadStartAt : undefined;
    turn.heard = {
      firstAt: this.now(),
      words: decision.words,
      ...(start !== undefined ? { segmentStart: start } : {}),
      ...(start !== undefined && this.lastVadEndAt > start ? { segmentEnd: this.lastVadEndAt } : {}),
    };
    return turn.heard;
  }

  /** The interrupting speech, on the turn's timeline: its VAD segment and its first transcript. */
  private markHeard(turn: ActiveTurn, heard: HeardUtterance): void {
    if (heard.segmentStart !== undefined) turn.timeline.mark('barge_in_segment_start', { at: heard.segmentStart });
    if (heard.segmentEnd !== undefined) turn.timeline.mark('barge_in_segment_end', { at: heard.segmentEnd });
    turn.timeline.mark('barge_in_first_partial', { at: heard.firstAt });
    turn.bargeIn.first_words = heard.words;
  }

  private softPause(turn: ActiveTurn, text: string): void {
    if (turn.paused) return;
    turn.paused = true;
    turn.pausedAt = this.now();
    turn.bargeIn.candidates += 1;
    turn.timeline.mark('barge_in_candidate');
    if (this.deps.transport.capabilities.pause) this.deps.transport.pause();
    turn.dismissedTranscript = normalizeArabic(text);
    turn.falseInterruptTimer = this.setTimer(() => this.resumeAfterFalseInterruption(turn, 'timeout'), this.cfg.falseInterruptionTimeoutMs);
    this.log.info('barge_in.pause', this.textFields({ turn_id: turn.id, text }));
    this.emit({ type: 'barge_in', turnId: turn.id, action: 'pause', reason: 'candidate', text });
  }

  private resumeAfterFalseInterruption(turn: ActiveTurn, reason: string): void {
    if (this.current !== turn || !turn.paused) return;
    this.clearTimer(turn.falseInterruptTimer);
    // Observed live: partial transcripts can lag the caller by >1s. While local VAD still hears the
    // caller (no agent audio plays during the pause, so this is not echo), keep waiting — up to 2× the timeout.
    const pausedFor = this.now() - turn.pausedAt;
    if (reason === 'timeout' && this.vad.isSpeaking && pausedFor < 2 * this.cfg.falseInterruptionTimeoutMs) {
      turn.falseInterruptTimer = this.setTimer(() => this.resumeAfterFalseInterruption(turn, 'timeout'), PAUSE_RECHECK_MS);
      return;
    }
    turn.paused = false;
    turn.falseInterruptions += 1;
    this.counters.falseInterruptions += 1;
    if (this.deps.transport.capabilities.pause) this.deps.transport.resume();
    this.log.info('barge_in.false_interruption', { turn_id: turn.id, reason });
    this.emit({ type: 'barge_in', turnId: turn.id, action: 'resume', reason });
    this.emitCounters();
  }

  /** Stop everything for this turn now: playback, LLM, TTS — and never play its audio again. */
  private interrupt(turn: ActiveTurn, reason: string): void {
    if (this.current !== turn) return;
    this.clearTimer(turn.falseInterruptTimer);
    turn.timeline.mark('interrupt_requested');
    turn.reason = reason;
    this.activeEpoch = null; // guard 1: session drops any late chunk for this epoch
    this.deps.transport.clear(turn.epoch); // guard 2: far end flushes its buffer now
    turn.controller.abort(new CancelledError(reason)); // guard 3: cancel LLM request + TTS context
    this.commitHistory(turn, true);
    this.lastAssistantText = turn.alignmentSeen ? turn.alignedText : turn.sentText;
    this.lastPlaybackEndAt = this.now();
    this.current = null;
    this.counters.interruptions += 1;
    this.awaitingClearAck.set(turn.epoch, turn);
    this.setTimer(() => {
      if (this.awaitingClearAck.delete(turn.epoch)) this.finalizeTurn(turn, 'interrupted', reason);
    }, this.cfg.clearAckTimeoutMs);
    this.log.info('barge_in.interrupt', { turn_id: turn.id, reason, heard_chars: turn.heardText.length });
    this.emit({ type: 'barge_in', turnId: turn.id, action: 'interrupt', reason });
    this.emitCounters();
    this.setState('listening');
  }

  /** Abandon a reply that has not started playing (the user kept talking). */
  private cancelTurn(turn: ActiveTurn, reason: string): void {
    if (this.current !== turn) return;
    this.activeEpoch = null;
    if (turn.lastSentMarkIndex >= 0) this.deps.transport.clear(turn.epoch);
    turn.controller.abort(new CancelledError(reason));
    if (turn.kind === 'user') {
      if (turn.agentRun?.agent.sideEffects) {
        // A write may have run: keep this turn as it was instead of merging it into the next utterance.
        this.commitAgentTurn(turn, turn.agentRun, '', false);
      } else {
        if (turn.agentRun) turn.agentRun.record = false; // the merged utterance redoes this turn
        this.carryOverUserText = turn.userText;
        this.carryOverUserTurn = turn.userTurn;
      }
    }
    this.current = null;
    this.log.info('turn.cancelled', { turn_id: turn.id, reason });
    this.finalizeTurn(turn, 'cancelled', reason);
    this.setState('listening');
  }

  private countIgnored(turn: ActiveTurn, decision: BargeInDecision, text: string): void {
    if (decision.reason === 'echo') this.counters.echoSuppressed += 1;
    else if (decision.reason === 'backchannel') this.counters.backchannelsIgnored += 1;
    else return;
    this.emit({ type: 'barge_in', turnId: turn.id, action: 'ignored', reason: decision.reason, text });
    this.emitCounters();
  }

  // ─────────────────────────────── turns ───────────────────────────────

  private startUserTurn(text: string): void {
    const userText = [this.carryOverUserText, text].filter((part) => part.trim() !== '').join(' ').trim();
    const continuedTurn = this.carryOverUserTurn;
    this.carryOverUserText = '';
    this.carryOverUserTurn = undefined;
    if (userText === '') return;
    const timeline = this.pendingTimeline ?? this.newTimeline();
    this.pendingTimeline = null;
    timeline.mark('stt_committed');
    const turn = this.beginTurn('user', userText, timeline, undefined, continuedTurn);
    this.emit({ type: 'user_committed', turnId: turn.id, text: userText });
  }

  private beginTurn(kind: ActiveTurn['kind'], userText: string, timeline: TurnTimeline, fixedText?: string, continuedUserTurn?: number): ActiveTurn {
    const turn: ActiveTurn = {
      id: newTurnId(),
      kind,
      beganAt: this.now(),
      userTurn: kind === 'user' ? (continuedUserTurn ?? ++this.userTurnCounter) : 0,
      epoch: ++this.epochCounter,
      controller: new AbortController(),
      timeline,
      userText,
      sentText: '',
      alignedText: '',
      alignmentSeen: false,
      heardText: '',
      markText: new Map(),
      lastSentMarkIndex: -1,
      ackedMarkIndex: -1,
      audioMsSent: 0,
      paused: false,
      pausedAt: 0,
      falseInterruptions: 0,
      bargeIn: { vad_starts: 0, transcripts: 0, ignored: { echo: 0, backchannel: 0, empty: 0 }, candidates: 0, vad_segments: [] },
      playingLevels: new LevelHistogram(),
      finalized: false,
    };
    timeline.turnId = turn.id;
    this.current = turn;
    this.activeEpoch = turn.epoch;
    this.counters.turns += 1;
    if (kind === 'user') this.silenceStep = 'prompt'; // the caller is there: a later silence is checked again first
    this.log.info('turn.start', this.textFields({ turn_id: turn.id, kind, epoch: turn.epoch, text: userText }));
    this.setState('thinking');
    void this.runTurn(turn, fixedText);
    return turn;
  }

  private async runTurn(turn: ActiveTurn, fixedText?: string): Promise<void> {
    const signal = turn.controller.signal;
    try {
      const tools = turn.kind === 'user' ? this.deps.tools : undefined;
      const source = fixedText !== undefined ? single(fixedText) : tools ? this.agentText(turn, tools, signal) : this.llmText(turn, signal);
      await this.speak(turn, source, signal);
      if (this.current !== turn) return;
      this.completeTurn(turn);
    } catch (err) {
      if (this.current !== turn) return; // interrupted/cancelled/closed: already accounted for
      this.failTurn(turn, err);
    }
  }

  private async *llmText(turn: ActiveTurn, signal: AbortSignal): AsyncGenerator<string> {
    const timeout = new AbortController();
    const timer = this.setTimer(
      () => timeout.abort(new ProviderError(this.deps.llm.name, 'timeout', `No model output within ${this.cfg.llmFirstTokenTimeoutMs}ms`)),
      this.cfg.llmFirstTokenTimeoutMs,
    );
    turn.timeline.mark('llm_request');
    try {
      const request = this.conversation.request(turn.userText);
      for await (const event of this.deps.llm.stream(request, { signal: AbortSignal.any([signal, timeout.signal]) })) {
        if (event.type === 'completed') break;
        if (!turn.timeline.has('llm_first_token')) {
          this.clearTimer(timer);
          turn.timeline.mark('llm_first_token');
        }
        yield event.text;
      }
      turn.timeline.mark('llm_done');
    } catch (err) {
      if (timeout.signal.aborted && !signal.aborted) throw abortReason(timeout.signal);
      throw err;
    } finally {
      this.clearTimer(timer);
    }
  }

  /** Tool-using turn: model ↔ tools until the model answers. Text streams to TTS as it arrives. */
  private async *agentText(turn: ActiveTurn, tools: AgentToolbox, signal: AbortSignal): AsyncGenerator<string> {
    const notes = await this.prepareAgentTurn(tools, signal);
    turn.timeline.mark('llm_request');
    const agent = new AgentTurn({
      llm: this.deps.llm,
      conversation: this.conversation,
      tools,
      userText: turn.userText,
      userTurn: turn.userTurn,
      turnId: turn.id,
      signal,
      maxToolRounds: this.deps.agent.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
      firstEventTimeoutMs: this.cfg.llmFirstTokenTimeoutMs,
      mutationGraceMs: this.deps.agent.toolMutationGraceMs ?? DEFAULT_TOOL_MUTATION_GRACE_MS,
      ...(this.waitPhrases !== undefined ? { waitPhrases: this.waitPhrases } : {}),
      notes,
      onLlmFirstEvent: (round) => {
        if (round === 0) turn.timeline.mark('llm_first_token');
      },
      onTool: (event) => this.emit({ type: 'tool', turnId: turn.id, ...event }),
    });
    const run: AgentRun = { agent, record: true, committed: 0 };
    turn.agentRun = run;
    this.lastAgentRun = run;
    for await (const out of agent.output) yield out.type === 'pause' ? CHUNK_FLUSH : out.text;
    turn.timeline.mark('llm_done');
  }

  /**
   * Before the model sees a new turn: let the previous turn's writes settle and record them (a write
   * confirmed by the caller completes even if they interrupted), then retry any unknown write outcomes.
   * Returns notes telling the model what was resolved, so it can inform the caller.
   */
  private async prepareAgentTurn(tools: AgentToolbox, signal: AbortSignal): Promise<string[]> {
    const previous = this.lastAgentRun;
    if (previous && !previous.agent.finished) await raceAbort(previous.agent.done, signal);
    if (previous) this.recordLateExchanges(previous);
    const resolved = await raceAbort(tools.reconcileUnresolved(), signal);
    return resolved.map(
      (r) => `تحديث من النظام: تأكدنا الآن أن الإجراء ${r.action_ref} (${r.kind}) ${r.applied ? 'تم تنفيذه فعلًا' : 'لم يُنفذ'}. أبلغ المتصل بذلك باختصار.`,
    );
  }

  /** Tool rounds that finished after their turn was committed (e.g. a write still running at barge-in). */
  private recordLateExchanges(run: AgentRun): void {
    if (!run.record) return;
    for (const exchange of run.agent.exchanges.slice(run.committed)) this.conversation.addToolExchange(exchange);
    run.committed = run.agent.exchanges.length;
  }

  private commitAgentTurn(turn: ActiveTurn, run: AgentRun, assistant: string, interrupted: boolean): void {
    this.conversation.commitTurn({ user: turn.userText, exchanges: run.agent.exchanges, assistant, interrupted });
    run.committed = run.agent.exchanges.length;
  }

  private async speak(turn: ActiveTurn, source: AsyncIterable<string>, signal: AbortSignal): Promise<void> {
    const tts = await raceAbort(this.getTtsSession(), signal);
    const timeout = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const segments = this.trackSegments(turn, chunkText(source, this.cfg.chunker), () => {
      turn.timeline.mark('tts_first_text');
      timer = this.setTimer(
        () => timeout.abort(new ProviderError(this.deps.tts.name, 'timeout', `No audio within ${this.cfg.ttsFirstAudioTimeoutMs}ms`)),
        this.cfg.ttsFirstAudioTimeoutMs,
      );
    });
    const outputFormat = this.deps.transport.outputFormat;
    try {
      for await (const chunk of tts.speak({ utteranceId: turn.id, text: segments, signal: AbortSignal.any([signal, timeout.signal]) })) {
        if (signal.aborted || this.activeEpoch !== turn.epoch) {
          this.counters.staleChunksDropped += 1;
          break;
        }
        if (turn.lastSentMarkIndex === -1) {
          this.clearTimer(timer);
          turn.timeline.mark('tts_first_audio');
          turn.quietLevels = this.quietLevels;
          this.quietLevels = new LevelHistogram();
          this.setState('speaking');
        }
        this.deps.transport.sendAudio(turn.epoch, chunk.data);
        turn.audioMsSent += durationMs(chunk.data.byteLength, outputFormat);
        if (chunk.text !== undefined) {
          turn.alignmentSeen = true;
          turn.alignedText += chunk.text;
        }
        const index = turn.lastSentMarkIndex + 1;
        turn.lastSentMarkIndex = index;
        turn.markText.set(index, turn.alignedText);
        this.deps.transport.sendMark(turn.epoch, `${turn.epoch}:${index}`);
      }
    } catch (err) {
      if (timeout.signal.aborted && !signal.aborted) throw abortReason(timeout.signal);
      throw err;
    } finally {
      this.clearTimer(timer);
    }
    if (signal.aborted) throw abortReason(signal);
    this.emit({ type: 'timeline', turnId: turn.id, mark: 'tts_done', t: roundMs(this.now()) }); // all audio for this turn received
    if (turn.lastSentMarkIndex === -1) return; // nothing to say
    await this.waitForPlayback(turn, signal);
  }

  private async *trackSegments(turn: ActiveTurn, segments: AsyncIterable<string>, onFirst: () => void): AsyncGenerator<string> {
    for await (const segment of segments) {
      if (turn.sentText === '') onFirst();
      turn.sentText = turn.sentText === '' ? segment : `${turn.sentText} ${segment}`;
      this.emit({ type: 'assistant_segment', turnId: turn.id, text: segment });
      yield segment;
    }
  }

  private waitForPlayback(turn: ActiveTurn, signal: AbortSignal): Promise<void> {
    const target = turn.lastSentMarkIndex;
    if (turn.ackedMarkIndex >= target) return Promise.resolve();
    const name = `${turn.epoch}:${target}`;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        this.markWaiters.delete(name);
        this.clearTimer(guard);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => finish(abortReason(signal));
      // Never hang if the far end stops acknowledging marks.
      const guard = this.setTimer(() => {
        this.log.warn('playback.ack_timeout', { turn_id: turn.id, audio_ms: Math.round(turn.audioMsSent) });
        finish();
      }, turn.audioMsSent + this.cfg.playbackGraceMs);
      this.markWaiters.set(name, () => finish());
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private completeTurn(turn: ActiveTurn): void {
    turn.timeline.mark('playback_end');
    this.clearTimer(turn.falseInterruptTimer);
    this.commitHistory(turn, false);
    this.lastAssistantText = turn.sentText;
    this.lastPlaybackEndAt = this.now();
    this.current = null;
    this.activeEpoch = null;
    if (turn.paused && this.deps.transport.capabilities.pause) this.deps.transport.resume();
    // Drop a pending timeline that only saw echo/noise during playback (no transcript evidence).
    if (this.pendingTimeline && !this.pendingTimeline.has('stt_first_partial')) this.discardPending();
    this.finalizeTurn(turn, 'completed');
    const endReason = ENDING_TURNS[turn.kind];
    if (endReason !== undefined) {
      void this.close(endReason); // the goodbye has played: hang up
      return;
    }
    this.setState('listening');
  }

  private failTurn(turn: ActiveTurn, err: unknown): void {
    const summary = errorSummary(err);
    this.log.error('turn.failed', { turn_id: turn.id, ...summary });
    turn.timeline.mark('error');
    this.activeEpoch = null;
    if (turn.lastSentMarkIndex >= 0) this.deps.transport.clear(turn.epoch);
    turn.controller.abort(new CancelledError('turn_failed'));
    this.clearTimer(turn.falseInterruptTimer);
    if (turn.agentRun) this.commitAgentTurn(turn, turn.agentRun, '', false);
    else if (turn.kind === 'user') this.conversation.addUser(turn.userText);
    this.current = null;
    this.finalizeTurn(turn, 'error', undefined, summary);
    this.emit({ type: 'error', code: summary.error_kind ? `turn_${summary.error_kind}` : 'turn_failed', message: summary.message });
    const endReason = ENDING_TURNS[turn.kind];
    if (endReason !== undefined) {
      void this.close(endReason); // the goodbye could not be spoken: the call ends anyway
      return;
    }
    this.setState('listening');
  }

  private commitHistory(turn: ActiveTurn, interrupted: boolean): void {
    const heard = interrupted ? (turn.alignmentSeen ? turn.heardText : turn.sentText) : turn.sentText;
    if (turn.agentRun) {
      this.commitAgentTurn(turn, turn.agentRun, heard, interrupted);
      return;
    }
    if (turn.kind === 'user') this.conversation.addUser(turn.userText);
    this.conversation.addAssistant(heard, { interrupted });
  }

  private finalizeTurn(turn: ActiveTurn, outcome: TurnOutcome, reason?: string, error?: TurnSummary['error']): void {
    if (turn.finalized) return;
    turn.finalized = true;
    if (turn.kind === 'greeting') this.greetingEndedAt = this.now();
    this.clearTimer(turn.falseInterruptTimer);
    if (this.vadSegment?.turn === turn) this.closeVadSegment(this.vad.speechMs, true);
    const interrupted = outcome === 'interrupted';
    const line = this.lineLevel(turn);
    const { bargeIn } = turn;
    const agent = turn.agentRun?.agent;
    if (agent) this.deps.tools?.onTurnFinalized(turn.id, turn.ackedMarkIndex >= 0 || turn.timeline.has('playback_start'), playedText(turn));
    const summary: TurnSummary = {
      session_id: this.deps.sessionId,
      turn_id: turn.id,
      tenant_id: this.deps.tenant.tenantId,
      kind: turn.kind,
      outcome,
      ...(reason !== undefined ? { reason } : {}),
      marks_ms: turn.timeline.relativeMarks(),
      durations_ms: { ...turn.timeline.durations(), ...(agent && agent.toolCalls.length > 0 ? { tools_ms: roundMs(agent.toolsMs) } : {}) },
      ...(agent ? { llm_rounds: agent.rounds, tool_calls: [...agent.toolCalls] } : {}),
      ...(this.lastRttMs !== undefined ? { transport_rtt_ms: Math.round(this.lastRttMs * 10) / 10 } : {}),
      user_chars: turn.userText.length,
      assistant_chars_sent: turn.sentText.length,
      ...(interrupted ? { assistant_chars_heard: turn.heardText.length, heard_text_estimated: !turn.alignmentSeen } : {}),
      false_interruptions: turn.falseInterruptions,
      ...(bargeIn.vad_starts > 0 || bargeIn.transcripts > 0
        ? { barge_in: { ...bargeIn, ignored: { ...bargeIn.ignored }, vad_segments: bargeIn.vad_segments.map((s) => ({ ...s })) } }
        : {}),
      ...(line ? { line } : {}),
      ...(error ? { error } : {}),
      ...(this.cfg.logTranscripts ? { user_text: turn.userText, assistant_text: turn.sentText } : {}),
    };
    this.deps.metrics.write(summary);
    this.log.info('turn.summary', { ...summary });
    this.emit({ type: 'turn_summary', summary });
  }

  private lineLevel(turn: ActiveTurn): LineLevel | undefined {
    const playing = turn.playingLevels.stats();
    const quiet = turn.quietLevels?.stats();
    if (!playing && !quiet) return undefined;
    return {
      ...(playing ? { playing } : {}),
      ...(quiet ? { quiet } : {}),
      noise_floor_db: Math.round(this.vad.noiseFloor * 10) / 10,
      threshold_db: Math.round(this.vad.threshold * 10) / 10,
    };
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private getTtsSession(): Promise<TtsSession> {
    if (!this.ttsSession) {
      const opening = this.deps.tts.open({
        format: this.deps.transport.outputFormat,
        log: this.log.child({ component: 'tts', provider: this.deps.tts.name }),
      });
      this.ttsSession = opening;
      opening.catch(() => {
        if (this.ttsSession === opening) this.ttsSession = undefined; // allow a retry on the next turn
      });
    }
    return this.ttsSession;
  }

  private async prewarmTts(): Promise<void> {
    try {
      await this.getTtsSession();
    } catch (err) {
      this.log.warn('tts.prewarm_failed', errorSummary(err));
    }
  }

  private newTimeline(): TurnTimeline {
    return new TurnTimeline(this.now, (timeline, mark, at) => this.emit({ type: 'timeline', turnId: timeline.turnId, mark, t: roundMs(at) }));
  }

  /** Drop marks gathered for a user turn that never happened (echo/noise), and tell observers. */
  private discardPending(): void {
    this.pendingTimeline = null;
    this.emit({ type: 'pending_reset' });
  }

  private ensurePending(): TurnTimeline {
    this.pendingTimeline ??= this.newTimeline();
    return this.pendingTimeline;
  }

  private withinEchoTail(): boolean {
    return this.now() - this.lastPlaybackEndAt <= this.cfg.echoTailMs;
  }

  private echoTailSpeech(): { fullText: string; spokenSoFar: string } {
    const text = this.withinEchoTail() ? this.lastAssistantText : '';
    return { fullText: text, spokenSoFar: text };
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    if (this.state === 'closed') return;
    this.state = state;
    this.emit({ type: 'state', state });
    if (state === 'listening' && this.maxCallReached) {
      this.endCallAtMaxLength(); // the turn that was under way at the limit is done
      return;
    }
    this.refreshSilenceWatch();
  }

  // ───────────────────────── phone: silence and call length ─────────────────────────

  /**
   * True when a partial has words its STT utterance has not shown yet (more words, or a word not in the previous
   * partial), and records them. A repeat of the same words, whatever its punctuation, is false.
   */
  private bringsNewWords(words: readonly string[]): boolean {
    if (words.length === 0) return false;
    const known = new Set(this.partialWords);
    const fresh = words.length > this.partialWords.length || words.some((word) => !known.has(word));
    if (fresh) this.partialWords = [...words];
    return fresh;
  }

  /** Mujeeb's own last words coming back from the line right after it stopped speaking (speakerphone echo). */
  private isOwnEcho(text: string): boolean {
    return this.withinEchoTail() && isEchoOf(text, this.lastAssistantText, this.cfg.bargeIn);
  }

  /**
   * During the greeting or within its echo tail: the call's first seconds, when a phone's echo canceller has not
   * adapted yet and Mujeeb's own voice leaks back most (observed live on speakerphone: the greeting came back as
   * "خلوا والله" on one call and as "أنا" on another, and cut the greeting short).
   */
  private aroundGreeting(): boolean {
    if (this.current?.kind === 'greeting') return true;
    return this.greetingEndedAt !== undefined && this.now() - this.greetingEndedAt <= this.cfg.echoTailMs;
  }

  /**
   * A single word in an utterance that began around the greeting is taken for its echo: it neither pauses nor
   * interrupts the greeting, and is not answered. Two words or more are the caller and go on as usual.
   */
  private ignoreGreetingWord(text: string): void {
    this.counters.greetingWordsIgnored += 1;
    this.log.info('barge_in.greeting_word_ignored', this.textFields({ text }));
    this.emitCounters();
  }

  /** (Re)starts the wait for the STT to commit the caller's latest words; see onStalePartial. */
  private armStalePartial(text: string): void {
    this.clearStalePartial();
    const ms = this.cfg.stalePartialCommitMs;
    if (ms <= 0) return;
    this.stalePartialTimer = this.setTimer(() => this.onStalePartial(text, ms), ms);
  }

  private clearStalePartial(): void {
    this.clearTimer(this.stalePartialTimer);
    this.stalePartialTimer = undefined;
  }

  /**
   * The caller's words stopped changing `ms` ago and the STT still has not committed them (observed live: a steady
   * AC hum held a commit for ~30 s, so the caller heard nothing). While Mujeeb waits, they are answered as if
   * committed. A commit that still comes later only adds the words past them (`answeredWords`). While Mujeeb speaks
   * or thinks, partials are the barge-in policy's to judge, so nothing happens then.
   */
  private onStalePartial(text: string, ms: number): void {
    this.stalePartialTimer = undefined;
    if (this.state !== 'listening' || this.current !== null) return;
    const fresh = this.partialWords.slice(this.answeredWords.length);
    if (fresh.length === 0) return;
    // Only words the line carried as speech: the local VAD heard the caller around them. The STT also makes words
    // out of noise (observed live: "No." on a silent speakerphone line), and those must not get an answer; they
    // are left to the STT's own commit, as before.
    const heardSpeech = this.vad.isSpeaking || this.lastVadEndAt >= this.utteranceStartedAt - STALE_SPEECH_LEAD_MS;
    if (!heardSpeech) {
      this.log.info('stt.stale_partial_without_speech', { stale_ms: ms, words: fresh.length });
      return;
    }
    const answer = this.answeredWords.length === 0 ? text : fresh.join(' ');
    this.answeredWords = [...this.partialWords];
    this.counters.stalePartialCommits += 1;
    this.log.info('stt.stale_partial_answered', { stale_ms: ms, words: fresh.length });
    this.onCommitted(answer);
    if (!this.isOwnEcho(answer)) this.refreshSilenceWatch();
  }

  /**
   * Phone calls: (re)starts the silence timer while Mujeeb waits for the caller, and stops it otherwise. Silence
   * means no new words from the caller — sound alone (noise, an AC hum, breathing) does not count, and neither does
   * a repeated partial or Mujeeb's own echo. Called on state changes, on the caller's new words and around number
   * hold, so silence counts from the last of them. The first silence gets the check (`silence_prompt`); silence
   * after it, the goodbye and hang-up.
   */
  private refreshSilenceWatch(): void {
    this.clearTimer(this.silenceTimer);
    this.silenceTimer = undefined;
    const silence = this.deps.phone?.silence;
    const { silencePromptMs, silenceHangupMs } = this.cfg.callEnding;
    if (!silence || silencePromptMs <= 0) return;
    if (this.state !== 'listening' || this.current !== null || this.maxCallReached || this.endingCall) return;
    if (this.numberHoldTimer !== undefined) return; // the caller is mid-number: the hold ends in a turn
    this.silenceSince = this.now();
    this.silenceTimer = this.setTimer(() => this.onCallerSilent(), this.silenceStep === 'prompt' ? silencePromptMs : silenceHangupMs);
  }

  private onCallerSilent(): void {
    this.silenceTimer = undefined;
    const silence = this.deps.phone?.silence;
    if (!silence || this.state !== 'listening' || this.current !== null) return;
    const silentMs = Math.round(this.now() - this.silenceSince);
    if (this.silenceStep === 'prompt') {
      this.silenceStep = 'goodbye';
      this.counters.silencePrompts += 1;
      this.log.info('call.silence_prompt', { silent_ms: silentMs });
      this.emitCounters();
      this.beginTurn('silence_prompt', '', this.newTimeline(), silence.promptText);
      return;
    }
    // Played to the end, it hangs up (completeTurn). Interrupted by the caller, the call goes on.
    this.log.info('call.silence_goodbye', { silent_ms: silentMs });
    this.beginTurn('silence_goodbye', '', this.newTimeline(), silence.goodbyeText);
  }

  /** Phone calls: the maximum length is reached. Ends the call now if Mujeeb is waiting, else once the turn under way is done. */
  private onMaxCallLength(): void {
    if (this.state === 'closed') return;
    this.maxCallReached = true;
    this.clearTimer(this.silenceTimer);
    this.silenceTimer = undefined;
    this.log.info('call.max_duration', { max_ms: this.cfg.callEnding.maxCallMs, state: this.state });
    if (this.state === 'listening' && this.current === null) {
      this.endCallAtMaxLength();
      return;
    }
    // An answer, or a write the caller confirmed, is under way: let it finish, within a bound.
    const graceMs = this.cfg.callEnding.maxCallTurnGraceMs;
    this.maxCallGraceTimer = this.setTimer(() => {
      this.maxCallGraceTimer = undefined;
      if (this.endingCall) return;
      this.endingCall = true;
      this.log.warn('call.max_duration_forced', { grace_ms: graceMs });
      void this.close('max_duration'); // close() still lets confirmed writes finish
    }, graceMs);
  }

  /** The goodbye at the maximum length (not interruptible), then the hang-up. Without the clinic's words, hangs up at once. */
  private endCallAtMaxLength(): void {
    if (this.endingCall || this.state === 'closed') return;
    this.endingCall = true;
    this.clearTimer(this.maxCallGraceTimer);
    this.maxCallGraceTimer = undefined;
    this.clearNumberHold();
    const text = this.deps.phone?.maxDurationGoodbyeText;
    if (text === undefined || text.trim() === '') {
      void this.close('max_duration');
      return;
    }
    this.beginTurn('max_duration_goodbye', '', this.newTimeline(), text);
  }

  private emit(event: SessionEvent): void {
    try {
      this.deps.observer?.(event);
    } catch (err) {
      this.log.warn('observer.failed', errorSummary(err));
    }
  }

  private emitCounters(): void {
    this.emit({ type: 'counters', counters: { ...this.counters } });
  }

  private textFields(fields: Record<string, unknown> & { text?: string }): Record<string, unknown> {
    if (this.cfg.logTranscripts) return fields;
    const { text, ...rest } = fields;
    return text === undefined ? rest : { ...rest, text_chars: text.length };
  }


  private setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: NodeJS.Timeout | undefined): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }
}

/**
 * What the caller provably heard of a turn: the TTS-aligned text up to the last playback mark the client
 * acknowledged. Without alignment, the whole text only when every mark was acknowledged; otherwise nothing.
 */
function playedText(turn: ActiveTurn): string {
  if (turn.alignmentSeen) return turn.heardText;
  return turn.lastSentMarkIndex >= 0 && turn.ackedMarkIndex >= turn.lastSentMarkIndex ? turn.sentText : '';
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

async function* single(text: string): AsyncGenerator<string> {
  await Promise.resolve();
  yield text;
}
