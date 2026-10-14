import type { RawData, WebSocket } from 'ws';
import type { AudioFormat } from '../../core/audio.js';
import type { Logger } from '../../core/logger.js';
import {
  AUDIO_EPOCH_HEADER_BYTES,
  MAX_CLIENT_AUDIO_FRAME_BYTES,
  type ServerMessage,
  clientMessageSchema,
} from '../../contracts/dev-client-protocol.js';
import type { AudioTransport, TransportCapabilities, TransportEvent } from '../../ports/audio-transport.js';

/** AudioTransport over a WebSocket to the local browser test client. */
export class BrowserWsTransport implements AudioTransport {
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  readonly capabilities: TransportCapabilities = { pause: true, playbackStartEvents: true };
  private readonly ws: WebSocket;
  private readonly log: Logger;
  private handler: ((event: TransportEvent) => void) | undefined;
  private readonly pingTimer: NodeJS.Timeout;
  private readonly pingsInFlight = new Map<number, number>();
  private pingId = 0;
  private closed = false;
  private invalidMessages = 0;

  constructor(ws: WebSocket, options: { inputFormat: AudioFormat; outputFormat: AudioFormat; log: Logger; pingIntervalMs?: number }) {
    this.ws = ws;
    this.inputFormat = options.inputFormat;
    this.outputFormat = options.outputFormat;
    this.log = options.log;
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', (code, reason) => this.onClose(`ws_${code}${reason.length > 0 ? `:${reason.toString()}` : ''}`));
    ws.on('error', (err) => this.log.warn('transport.ws_error', { message: err.message }));
    this.pingTimer = setInterval(() => this.ping(), options.pingIntervalMs ?? 2000);
    this.pingTimer.unref();
  }

  setHandler(handler: (event: TransportEvent) => void): void {
    this.handler = handler;
  }

  sendAudio(epoch: number, data: Uint8Array): void {
    if (!this.isOpen()) return;
    const frame = Buffer.allocUnsafe(AUDIO_EPOCH_HEADER_BYTES + data.byteLength);
    frame.writeUInt32LE(epoch, 0);
    frame.set(data, AUDIO_EPOCH_HEADER_BYTES);
    this.ws.send(frame, { binary: true });
  }

  sendMark(_epoch: number, name: string): void {
    this.send({ type: 'mark', name });
  }

  clear(epoch: number): void {
    this.send({ type: 'clear', epoch });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  resume(): void {
    this.send({ type: 'resume' });
  }

  /** Display-only channel for the test UI (state, transcripts, timings). */
  send(message: ServerMessage): void {
    if (!this.isOpen()) return;
    this.ws.send(JSON.stringify(message));
  }

  close(reason: string): void {
    clearInterval(this.pingTimer);
    if (this.closed) return;
    this.closed = true;
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close(1000, reason.slice(0, 120));
    }
  }

  private isOpen(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      const bytes = toUint8Array(data);
      if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_CLIENT_AUDIO_FRAME_BYTES) {
        this.reject('bad_audio_frame', { bytes: bytes.byteLength });
        return;
      }
      this.handler?.({ type: 'audio', data: bytes });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(toUint8ArrayText(data));
    } catch {
      this.reject('bad_json');
      return;
    }
    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.reject('bad_message');
      return;
    }
    const message = result.data;
    switch (message.type) {
      case 'hello':
        this.log.info('client.hello', {
          user_agent: message.userAgent,
          playback_route: message.playbackRoute,
          audio_constraints: message.audioConstraints,
          context_sample_rate: message.contextSampleRate,
        });
        break;
      case 'mark':
        this.handler?.({ type: 'mark', name: message.name });
        break;
      case 'playback_started':
        this.handler?.({ type: 'playback_started', epoch: message.epoch });
        break;
      case 'playback_cleared':
        this.handler?.({ type: 'playback_cleared', epoch: message.epoch });
        break;
      case 'pong': {
        const sentAt = this.pingsInFlight.get(message.id);
        if (sentAt === undefined) break;
        this.pingsInFlight.delete(message.id);
        this.handler?.({ type: 'rtt', ms: performance.now() - sentAt });
        break;
      }
    }
  }

  private ping(): void {
    if (!this.isOpen()) return;
    const id = ++this.pingId;
    this.pingsInFlight.set(id, performance.now());
    if (this.pingsInFlight.size > 10) this.pingsInFlight.delete(Math.min(...this.pingsInFlight.keys()));
    this.send({ type: 'ping', id });
  }

  private onClose(reason: string): void {
    clearInterval(this.pingTimer);
    const wasClosed = this.closed;
    this.closed = true;
    if (!wasClosed) this.handler?.({ type: 'closed', reason });
  }

  private reject(code: string, fields?: Record<string, unknown>): void {
    this.invalidMessages += 1;
    if (this.invalidMessages <= 5) this.log.warn('transport.invalid_client_message', { code, ...fields });
  }
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toUint8ArrayText(data: RawData): string {
  return Buffer.from(toUint8Array(data)).toString('utf8');
}
