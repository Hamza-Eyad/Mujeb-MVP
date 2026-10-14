import { type AgentToolEvent, type AgentToolbox, AgentTurn } from '../agent/agent-turn.js';
import { Conversation } from '../agent/conversation.js';
import { abortReason, raceAbort, sleep } from '../core/async.js';
import { bytesForDuration, concatBytes, durationMs, pcm16Samples } from '../core/audio.js';
import { CancelledError, ProviderError, errorSummary } from '../core/errors.js';
import { newTurnId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { TenantContext } from '../core/tenant.js';
import type { TurnOutcome, TurnSummary, TurnSummarySink } from '../observability/turn-metrics.js';
import { type TurnMark, TurnTimeline } from '../observability/turn-timeline.js';
import type { AudioTransport, TransportEvent } from '../ports/audio-transport.js';
import type { LanguageModel } from '../ports/language-model.js';
import type { SpeechToText, SttEvent, SttStream } from '../ports/speech-to-text.js';
import type { TextToSpeech, TtsSession } from '../ports/text-to-speech.js';
import { normalizeArabic } from './arabic-text.js';
import { type BargeInDecision, type BargeInPolicy, evaluateBargeIn, isEchoOf } from './barge-in-policy.js';
import { EnergyVad, type EnergyVadOptions } from './energy-vad.js';
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
  sttReconnect: { maxAttempts: number; baseDelayMs: number };
  chunker: ChunkerOptions;
  bargeIn: BargeInPolicy;
  vad: EnergyVadOptions;
  logTranscripts: boolean;
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
    /** Said before the first tool of a turn when the model has said nothing yet (e.g. "لحظة أشيك لك."). */
    toolWaitPhrase?: string;
  };
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

interface ActiveTurn {
  readonly id: string;
  readonly kind: 'user' | 'greeting';
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
  private ttsSession: Promise<TtsSession> | undefined;

  private epochCounter = 0;
  private activeEpoch: number | null = null;
  private current: ActiveTurn | null = null;
  private pendingTimeline: TurnTimeline | null = null;
  private carryOverUserText = '';
  /** Caller-turn number of the carried-over text: a continued utterance is still the same turn for confirmations. */
  private carryOverUserTurn: number | undefined;
  private userTurnCounter = 0;
  /** The latest tool-using turn; its writes may still be finishing after the turn ended. */
  private lastAgentRun: AgentRun | null = null;
  private lastAssistantText = '';
  private lastPlaybackEndAt = Number.NEGATIVE_INFINITY;
  private lastRttMs: number | undefined;
  private sttBuffer: Uint8Array[] = [];
  private sttBufferedBytes = 0;

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
  };

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps;
    this.cfg = deps.config;
    this.now = deps.now ?? (() => performance.now());
    this.log = deps.log.child({ session_id: deps.sessionId, tenant_id: deps.tenant.tenantId });
    this.conversation = new Conversation({ instructions: deps.agent.instructions, maxTurns: deps.agent.historyMaxTurns });
    this.vad = new EnergyVad(this.cfg.vad);
    this.sttChunkBytes = bytesForDuration(this.cfg.sttChunkMs, deps.transport.inputFormat);
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

  async start(): Promise<void> {
    this.deps.transport.setHandler((event) => this.onTransportEvent(event));
    this.log.info('session.start', {
      input_format: this.deps.transport.inputFormat,
      output_format: this.deps.transport.outputFormat,
      duplex_mode: this.cfg.duplexMode,
      providers: { stt: this.deps.stt.name, llm: this.deps.llm.name, tts: this.deps.tts.name },
    });
    await this.openStt();
    this.setState('listening');
    void this.prewarmTts();
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
      const vadEvent = this.vad.process(pcm16Samples(data), format.sampleRate);
      if (vadEvent?.type === 'speech_start') {
        const at = this.now() - vadEvent.startedMsAgo;
        if (this.state === 'speaking') this.current?.timeline.mark('barge_in_speech_start', { at });
        this.ensurePending().mark('user_speech_start', { at });
      } else if (vadEvent?.type === 'speech_end') {
        const at = this.now() - vadEvent.endedMsAgo;
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

  private async openStt(): Promise<void> {
    const generation = ++this.sttGeneration;
    const stream = await this.deps.stt.open({
      format: this.deps.transport.inputFormat,
      signal: this.lifetime.signal,
      log: this.log.child({ component: 'stt', provider: this.deps.stt.name }),
      onEvent: (event) => {
        if (generation === this.sttGeneration && this.state !== 'closed') this.onSttEvent(event);
      },
    });
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
      case 'partial':
        this.onPartial(event.text.trim());
        break;
      case 'committed':
        this.onCommitted(event.text.trim());
        break;
      case 'warning':
        this.log.warn('stt.warning', errorSummary(event.error));
        this.emit({ type: 'warning', code: `stt_${event.error.kind}`, message: event.error.message });
        break;
      case 'closed':
        this.sttStream = undefined;
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
    this.emit({ type: 'user_partial', text });
    this.ensurePending().mark('stt_first_partial');
  }

  private onCommitted(text: string): void {
    const turn = this.current;
    if (turn && this.state === 'speaking') {
      if (text === '') return;
      if (this.handleSpeakingTranscript(turn, text, true)) this.startUserTurn(text);
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
      this.startUserTurn(text);
      return;
    }
    if (text === '') {
      if (this.carryOverUserText !== '') this.startUserTurn('');
      return;
    }
    if (this.withinEchoTail() && isEchoOf(text, this.lastAssistantText, this.cfg.bargeIn)) {
      this.counters.echoSuppressed += 1;
      this.discardPending();
      this.log.info('barge_in.echo_tail_suppressed', this.textFields({ text }));
      this.emitCounters();
      return;
    }
    this.startUserTurn(text);
  }

  // ───────────────────────────── barge-in ─────────────────────────────

  /** Returns true when the transcript interrupted the current turn. */
  private handleSpeakingTranscript(turn: ActiveTurn, text: string, final: boolean): boolean {
    const agent = { fullText: turn.sentText, spokenSoFar: turn.alignmentSeen ? turn.alignedText : turn.sentText };
    const decision = evaluateBargeIn(text, agent, this.cfg.bargeIn, { final });
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
    this.interrupt(turn, final ? 'barge_in_final' : 'barge_in');
    return true;
  }

  private softPause(turn: ActiveTurn, text: string): void {
    if (turn.paused) return;
    turn.paused = true;
    turn.pausedAt = this.now();
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
      finalized: false,
    };
    timeline.turnId = turn.id;
    this.current = turn;
    this.activeEpoch = turn.epoch;
    this.counters.turns += 1;
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
      ...(this.deps.agent.toolWaitPhrase !== undefined ? { waitPhrase: this.deps.agent.toolWaitPhrase } : {}),
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
    this.clearTimer(turn.falseInterruptTimer);
    const interrupted = outcome === 'interrupted';
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
      ...(error ? { error } : {}),
      ...(this.cfg.logTranscripts ? { user_text: turn.userText, assistant_text: turn.sentText } : {}),
    };
    this.deps.metrics.write(summary);
    this.log.info('turn.summary', { ...summary });
    this.emit({ type: 'turn_summary', summary });
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
