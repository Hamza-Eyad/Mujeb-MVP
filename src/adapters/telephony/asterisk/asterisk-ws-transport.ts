import type { RawData, WebSocket } from 'ws';
import type { CallContext } from '../../../contracts/call-context.js';
import { type AudioFormat, bytesForDuration, concatBytes, describeFormat } from '../../../core/audio.js';
import type { Logger } from '../../../core/logger.js';
import type { AudioTransport, TransportCapabilities, TransportEvent } from '../../../ports/audio-transport.js';
import { type AsteriskCommand, type MediaStart, channelVariables, parseAsteriskEvent } from './protocol.js';

/**
 * AudioTransport over one Asterisk chan_websocket connection (one connection = one call).
 *
 * The dialplan dials `WebSocket/<connection>/c(<format>)f(json)n` and sets, with inheritance (`__`), the call
 * variables named in DIALPLAN_VARIABLES. `n`: Asterisk does not answer until answer() is sent.
 *
 * Playback model (same contract as the browser transport):
 * - Audio and marks share ONE ordered stream. A mark goes out only after every byte queued before it, so
 *   MEDIA_MARK_PROCESSED can never confirm audio that was not sent (also under MEDIA_XOFF backpressure).
 * - Audio is sent in whole frames of `optimal_frame_size` (Asterisk drops a partial frame). A partial tail is
 *   padded with silence once the TTS has been quiet for `tailFlushMs`. A mark inside a frame waits for the end
 *   of that frame: "heard" is reported up to 20ms late, never early.
 * - Asterisk times the audio out in real time and processes a mark when playback reaches it.
 * - clear(): FLUSH_MEDIA then GET_STATUS. Commands run in order, so the STATUS reply confirms the flush; only
 *   then, and only with an empty queue, is `playback_cleared` reported.
 * - STATUS carries no correlation ID. Asterisk sends it only in reply to GET_STATUS, in command order (checked
 *   in chan_websocket.c, 22.11.0), so each reply belongs to the oldest GET_STATUS still unanswered. A queue
 *   probe's reply therefore never confirms a flush.
 * - playback_started: a mark queued before an epoch's first audio, processed when playback reaches it.
 */

/** Dialplan contract: the inherited channel variables this adapter reads. */
export const DIALPLAN_VARIABLES = {
  callId: 'MUJEEB_CALL_ID',
  dialed: 'MUJEEB_DID',
  caller: 'MUJEEB_CALLER',
} as const;

export interface AsteriskWsTransportOptions {
  format: AudioFormat;
  log: Logger;
  /** Pad and send a partial last frame after this much quiet from the TTS. */
  tailFlushMs?: number;
  /** Frames per WebSocket message (Asterisk's limit is 65,500 bytes; small messages keep marks precise). */
  framesPerMessage?: number;
  /** Ask Asterisk for its playback queue length this often and log it (load tests). 0 or absent: never. */
  statusProbeMs?: number;
}

/** What an unanswered GET_STATUS was sent for. */
type StatusRequest = { kind: 'clear'; epoch: number } | { kind: 'probe' };

const START_MARK_PREFIX = 'start:';
const MAX_INBOUND_FRAME_BYTES = 65_500;

export class AsteriskWsTransport implements AudioTransport {
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  readonly capabilities: TransportCapabilities = { pause: true, playbackStartEvents: true };
  private readonly ws: WebSocket;
  private readonly log: Logger;
  private readonly tailFlushMs: number;
  private readonly framesPerMessage: number;
  private readonly statusProbeMs: number;
  private readonly started: Promise<CallContext>;
  private resolveStarted!: (call: CallContext) => void;
  private rejectStarted!: (err: Error) => void;
  private handler: ((event: TransportEvent) => void) | undefined;
  private closed = false;
  private mediaStarted = false;
  private invalidMessages = 0;

  private frameBytes: number;
  /** Epoch of the stream being sent; null when idle or after a clear. */
  private epoch: number | null = null;
  /** Epochs up to this one were cleared: late audio and marks for them are dropped. */
  private clearedThrough = Number.NEGATIVE_INFINITY;
  private pending: Uint8Array = new Uint8Array(0);
  /** Stream offset after the last queued byte, and after the last byte sent (whole frames, padding included). */
  private queuedBytes = 0;
  private sentBytes = 0;
  private marks: Array<{ name: string; at: number }> = [];
  private xoff = false;
  private tailTimer: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  /** One entry per GET_STATUS sent and not yet answered, oldest first. */
  private readonly statusRequests: StatusRequest[] = [];

  constructor(ws: WebSocket, options: AsteriskWsTransportOptions) {
    this.ws = ws;
    this.inputFormat = options.format;
    this.outputFormat = options.format;
    this.log = options.log;
    this.tailFlushMs = options.tailFlushMs ?? 60;
    this.framesPerMessage = options.framesPerMessage ?? 10;
    this.statusProbeMs = options.statusProbeMs ?? 0;
    this.frameBytes = bytesForDuration(20, options.format);
    this.started = new Promise<CallContext>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.started.catch(() => undefined); // observed by callStarted(); never an unhandled rejection
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', (code) => this.onClose(`ws_${code}`));
    ws.on('error', (err) => this.log.warn('transport.ws_error', { message: err.message }));
  }

  /** Resolves on MEDIA_START with the call's metadata; rejects if the socket closes first or the call is unusable. */
  callStarted(): Promise<CallContext> {
    return this.started;
  }

  /** Answers the call (the dialplan dials with `n`). */
  answer(): void {
    this.command({ command: 'ANSWER' });
  }

  setHandler(handler: (event: TransportEvent) => void): void {
    this.handler = handler;
  }

  sendAudio(epoch: number, data: Uint8Array): void {
    if (this.closed || epoch <= this.clearedThrough || data.byteLength === 0) return;
    if (this.epoch !== epoch) this.beginEpoch(epoch);
    this.pending = this.pending.byteLength === 0 ? data : concatBytes([this.pending, data]);
    this.queuedBytes += data.byteLength;
    this.pump();
    this.scheduleTail();
  }

  sendMark(epoch: number, name: string): void {
    if (this.closed || epoch <= this.clearedThrough) return;
    if (this.epoch !== epoch) this.beginEpoch(epoch);
    this.marks.push({ name, at: this.queuedBytes });
    this.pump();
    this.scheduleTail();
  }

  clear(epoch: number): void {
    if (this.closed) return;
    this.clearedThrough = Math.max(this.clearedThrough, epoch);
    if (this.epoch !== null && this.epoch <= epoch) this.resetStream();
    this.command({ command: 'FLUSH_MEDIA' });
    this.requestStatus({ kind: 'clear', epoch });
  }

  pause(): void {
    this.command({ command: 'PAUSE_MEDIA' });
  }

  resume(): void {
    this.command({ command: 'CONTINUE_MEDIA' });
  }

  /** Hangs up the call and closes the connection. */
  close(reason: string): void {
    this.clearTail();
    this.stopProbe();
    if (this.closed) return;
    this.command({ command: 'HANGUP' });
    this.closed = true;
    this.rejectStarted(new Error(`closed before the call started: ${reason}`));
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(1000, reason.slice(0, 120));
  }

  private beginEpoch(epoch: number): void {
    if (this.pending.byteLength > 0) {
      // The previous utterance's tail (should not happen: the session ends one epoch before starting the next).
      this.padTail();
      this.pump();
    }
    this.epoch = epoch;
    this.marks.push({ name: `${START_MARK_PREFIX}${epoch}`, at: this.queuedBytes });
  }

  /** Sends whole frames and due marks, in stream order, until blocked by backpressure or a partial frame. */
  private pump(): void {
    while (!this.closed && !this.xoff && this.ws.readyState === this.ws.OPEN) {
      const next = this.marks[0];
      if (next !== undefined && next.at <= this.sentBytes) {
        this.marks.shift();
        this.command({ command: 'MARK_MEDIA', correlation_id: next.name });
        continue;
      }
      let frames = Math.min(Math.floor(this.pending.byteLength / this.frameBytes), this.framesPerMessage);
      if (frames === 0) return;
      if (next !== undefined) frames = Math.min(frames, Math.max(1, Math.ceil((next.at - this.sentBytes) / this.frameBytes)));
      const bytes = frames * this.frameBytes;
      this.ws.send(this.pending.subarray(0, bytes), { binary: true });
      this.pending = this.pending.subarray(bytes);
      this.sentBytes += bytes;
    }
  }

  private scheduleTail(): void {
    this.clearTail();
    const waiting = this.pending.byteLength > 0 || this.marks.some((m) => m.at > this.sentBytes);
    if (!waiting) return;
    this.tailTimer = setTimeout(() => {
      this.tailTimer = undefined;
      this.padTail();
      this.pump();
    }, this.tailFlushMs);
    this.tailTimer.unref();
  }

  private padTail(): void {
    const partial = this.pending.byteLength % this.frameBytes;
    if (partial === 0) return;
    const padding = this.frameBytes - partial;
    this.pending = concatBytes([this.pending, new Uint8Array(padding)]);
    this.queuedBytes += padding;
  }

  private clearTail(): void {
    if (this.tailTimer !== undefined) clearTimeout(this.tailTimer);
    this.tailTimer = undefined;
  }

  private resetStream(): void {
    this.clearTail();
    this.epoch = null;
    this.pending = new Uint8Array(0);
    this.marks = [];
    this.queuedBytes = 0;
    this.sentBytes = 0;
  }

  /** True when the command was sent. */
  private command(cmd: AsteriskCommand): boolean {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return false;
    this.ws.send(JSON.stringify(cmd));
    return true;
  }

  private requestStatus(request: StatusRequest): void {
    if (this.command({ command: 'GET_STATUS' })) this.statusRequests.push(request);
  }

  private startProbe(): void {
    if (this.statusProbeMs <= 0 || this.probeTimer !== undefined) return;
    this.probeTimer = setInterval(() => {
      // One probe at a time: if Asterisk stops answering, requests must not pile up.
      if (!this.statusRequests.some((r) => r.kind === 'probe')) this.requestStatus({ kind: 'probe' });
    }, this.statusProbeMs);
    this.probeTimer.unref();
  }

  private stopProbe(): void {
    if (this.probeTimer !== undefined) clearInterval(this.probeTimer);
    this.probeTimer = undefined;
  }

  private onStatus(queueLength: number, xonLevel: number | undefined): void {
    if (this.xoff && xonLevel !== undefined && queueLength < xonLevel) {
      this.xoff = false;
      this.pump();
    }
    const request = this.statusRequests.shift();
    if (request === undefined) {
      this.log.warn('transport.status_unexpected', { queue_length: queueLength });
      return;
    }
    if (request.kind === 'probe') {
      this.log.info('transport.queue_status', { queue_length: queueLength, xoff: this.xoff });
      return;
    }
    if (queueLength > 0) {
      // FLUSH_MEDIA empties the queue, so audio is left only if some arrived between it and GET_STATUS. Not a
      // confirmed stop: the session's clear-ack timeout ends the turn instead.
      this.log.error('transport.flush_unconfirmed', { queue_length: queueLength, epoch: request.epoch });
      return;
    }
    this.handler?.({ type: 'playback_cleared', epoch: request.epoch });
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return; // hung up by us: nothing more is delivered to the session
    if (isBinary) {
      const bytes = toUint8Array(data);
      if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_INBOUND_FRAME_BYTES) {
        this.reject('bad_audio_frame', { bytes: bytes.byteLength });
        return;
      }
      if (this.mediaStarted) this.handler?.({ type: 'audio', data: bytes });
      return;
    }
    const event = parseAsteriskEvent(Buffer.from(toUint8Array(data)).toString('utf8'));
    if (event === undefined) {
      this.reject('bad_event');
      return;
    }
    switch (event.event) {
      case 'MEDIA_START':
        this.onMediaStart(event);
        break;
      case 'MEDIA_MARK_PROCESSED': {
        const name = event.correlation_id;
        if (name.startsWith(START_MARK_PREFIX)) {
          const epoch = Number(name.slice(START_MARK_PREFIX.length));
          if (Number.isFinite(epoch)) this.handler?.({ type: 'playback_started', epoch });
        } else {
          this.handler?.({ type: 'mark', name });
        }
        break;
      }
      case 'MEDIA_XOFF':
        this.xoff = true;
        this.log.debug('transport.xoff');
        break;
      case 'MEDIA_XON':
        this.xoff = false;
        this.log.debug('transport.xon');
        this.pump();
        break;
      case 'STATUS':
        this.onStatus(event.queue_length, event.xon_level);
        break;
      case 'DTMF_END':
        // Not part of the AudioTransport port yet. The digit itself is not logged (it may be an ID).
        this.log.debug('transport.dtmf_ignored');
        break;
      case 'OTHER':
        this.log.debug('transport.event_ignored', { event: event.name });
        break;
    }
  }

  private onMediaStart(start: MediaStart): void {
    if (this.mediaStarted) return;
    const expected = asteriskFormatName(this.inputFormat);
    if (start.format !== expected || start.optimal_frame_size % 2 !== 0) {
      this.log.error('transport.format_mismatch', { expected, received: start.format, frame_bytes: start.optimal_frame_size });
      this.rejectStarted(new Error(`Asterisk sent ${start.format}; the dialplan must dial with c(${expected})`));
      return;
    }
    const variables = channelVariables(start);
    const dialed = variables[DIALPLAN_VARIABLES.dialed];
    if (dialed === undefined || dialed.trim() === '') {
      this.rejectStarted(new Error(`MEDIA_START has no ${DIALPLAN_VARIABLES.dialed} channel variable (check the dialplan)`));
      return;
    }
    this.mediaStarted = true;
    this.frameBytes = start.optimal_frame_size;
    this.startProbe();
    const caller = variables[DIALPLAN_VARIABLES.caller]?.trim();
    this.log.info('transport.media_start', { channel_id: start.channel_id, format: describeFormat(this.inputFormat), frame_bytes: this.frameBytes });
    this.resolveStarted({
      callId: variables[DIALPLAN_VARIABLES.callId]?.trim() || start.channel_id,
      dialed: dialed.trim(),
      ...(caller ? { caller } : {}),
    });
  }

  private onClose(reason: string): void {
    this.clearTail();
    this.stopProbe();
    this.statusRequests.length = 0; // no reply can arrive any more
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectStarted(new Error(`connection closed before the call started (${reason})`));
    if (!wasClosed) this.handler?.({ type: 'closed', reason });
  }

  private reject(code: string, fields?: Record<string, unknown>): void {
    this.invalidMessages += 1;
    if (this.invalidMessages <= 5) this.log.warn('transport.invalid_message', { code, ...fields });
  }
}

/** Asterisk's format name for an AudioFormat (what the dialplan's `c(...)` must request). */
export function asteriskFormatName(format: AudioFormat): string {
  if (format.encoding === 'mulaw') return 'ulaw';
  return format.sampleRate === 8000 ? 'slin' : `slin${format.sampleRate / 1000}`;
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
