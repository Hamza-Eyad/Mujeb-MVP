import { WebSocket } from 'ws';

/**
 * Stands in for the browser test page (web/dev-client) on the dev server's WebSocket, in real time:
 * - sends 20 ms PCM16 mic frames continuously (silence, or a caller utterance when one is queued);
 * - "plays" received audio on a real-time timeline: reports `playback_started`, and acknowledges each
 *   mark only once the audio before it has played — so the server's notion of what the caller heard
 *   (TTS alignment up to the last acknowledged mark) is as in the browser;
 * - honours `clear` (drops what has not played, reports `playback_cleared`) and answers pings.
 * Everything else (microphone, speakers, the page's audio worklets) is what manual testing covers.
 */

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // PCM16 mono

export interface ClientEvent {
  type: string;
  [key: string]: unknown;
}

export class WsBrowserClient {
  readonly events: ClientEvent[] = [];
  private readonly ws: WebSocket;
  private readonly outgoing: Uint8Array[] = [];
  private micTimer: NodeJS.Timeout | undefined;
  private nextFrameAt = 0;
  /** Per epoch: when its queued audio finishes playing, and the timers that acknowledge its marks. */
  private readonly playback = new Map<number, { endsAt: number; started: boolean; timers: NodeJS.Timeout[] }>();
  private readonly cleared = new Set<number>();
  private utteranceDone: (() => void) | undefined;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
  }

  static async connect(baseUrl: string): Promise<WsBrowserClient> {
    const url = new URL('/ws', baseUrl);
    url.protocol = 'ws:';
    const ws = new WebSocket(url, { headers: { origin: baseUrl } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new WsBrowserClient(ws);
    ws.send(JSON.stringify({ type: 'hello', userAgent: 'mujeeb-live-e2e', playbackRoute: 'direct' }));
    client.startMic();
    return client;
  }

  /** Queues a caller utterance (PCM16 16 kHz mono) on the mic; resolves when its last frame was sent. */
  say(pcm: Uint8Array): Promise<void> {
    for (let o = 0; o < pcm.byteLength; o += FRAME_BYTES) {
      const frame = new Uint8Array(FRAME_BYTES);
      frame.set(pcm.subarray(o, Math.min(o + FRAME_BYTES, pcm.byteLength)));
      this.outgoing.push(frame);
    }
    return new Promise((resolve) => (this.utteranceDone = resolve));
  }

  /** Whether received audio is still playing (or queued to play). */
  get playing(): boolean {
    const now = performance.now();
    return [...this.playback.entries()].some(([epoch, p]) => !this.cleared.has(epoch) && p.endsAt > now);
  }

  close(): void {
    clearInterval(this.micTimer);
    for (const p of this.playback.values()) p.timers.forEach(clearTimeout);
    this.ws.close();
  }

  private startMic(): void {
    this.nextFrameAt = performance.now();
    this.micTimer = setInterval(() => {
      // Catch up on any frames due (timers are coarse): keeps the stream at real time on average.
      while (performance.now() >= this.nextFrameAt) {
        const frame = this.outgoing.shift();
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame ?? new Uint8Array(FRAME_BYTES), { binary: true });
        if (frame && this.outgoing.length === 0) {
          this.utteranceDone?.();
          this.utteranceDone = undefined;
        }
        this.nextFrameAt += FRAME_MS;
      }
    }, 5);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const epoch = data.readUInt32LE(0);
      if (this.cleared.has(epoch)) return;
      const ms = (data.byteLength - 4) / ((SAMPLE_RATE * 2) / 1000);
      const now = performance.now();
      const p = this.playback.get(epoch) ?? { endsAt: now, started: false, timers: [] };
      this.playback.set(epoch, p);
      if (!p.started) {
        p.started = true;
        this.send({ type: 'playback_started', epoch });
      }
      p.endsAt = Math.max(p.endsAt, now) + ms;
      return;
    }
    const message = JSON.parse(data.toString('utf8')) as ClientEvent;
    switch (message.type) {
      case 'mark': {
        const name = String(message['name']);
        const epoch = Number(name.split(':')[0]);
        const p = this.playback.get(epoch);
        const delay = p ? Math.max(0, p.endsAt - performance.now()) : 0;
        const timer = setTimeout(() => {
          if (!this.cleared.has(epoch)) this.send({ type: 'mark', name });
        }, delay);
        p?.timers.push(timer);
        break;
      }
      case 'clear': {
        const epoch = Number(message['epoch']);
        this.cleared.add(epoch);
        this.playback.get(epoch)?.timers.forEach(clearTimeout);
        this.send({ type: 'playback_cleared', epoch });
        break;
      }
      case 'ping':
        this.send({ type: 'pong', id: message['id'] });
        break;
      case 'event':
        this.events.push(message['event'] as ClientEvent);
        break;
      default:
        this.events.push(message);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
}
