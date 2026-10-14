import { durationMs, pcm16 } from '../../src/core/audio.js';
import type { AudioTransport, TransportCapabilities, TransportEvent } from '../../src/ports/audio-transport.js';

type QueueItem = { kind: 'audio'; epoch: number; ms: number } | { kind: 'mark'; epoch: number; name: string };

export type TransportOp =
  | { op: 'audio'; epoch: number; bytes: number }
  | { op: 'mark'; epoch: number; name: string }
  | { op: 'clear'; epoch: number }
  | { op: 'pause' }
  | { op: 'resume' };

/**
 * In-memory transport that behaves like a far-end player: buffers audio, plays it at
 * `playbackSpeed` × real time, reports playback start, acknowledges marks when reached,
 * supports pause/resume and clear.
 */
export class FakeTransport implements AudioTransport {
  readonly inputFormat = pcm16(16000);
  readonly outputFormat = pcm16(16000);
  readonly capabilities: TransportCapabilities;
  readonly ops: TransportOp[] = [];
  closedReason: string | undefined;
  private handler: ((event: TransportEvent) => void) | undefined;
  private queue: QueueItem[] = [];
  private paused = false;
  private busy = false;
  private readonly started = new Set<number>();
  private readonly playbackSpeed: number;

  constructor(options: { playbackSpeed?: number; capabilities?: Partial<TransportCapabilities> } = {}) {
    this.playbackSpeed = options.playbackSpeed ?? 0.05;
    this.capabilities = { pause: true, playbackStartEvents: true, ...options.capabilities };
  }

  setHandler(handler: (event: TransportEvent) => void): void {
    this.handler = handler;
  }

  sendAudio(epoch: number, data: Uint8Array): void {
    this.ops.push({ op: 'audio', epoch, bytes: data.byteLength });
    this.queue.push({ kind: 'audio', epoch, ms: durationMs(data.byteLength, this.outputFormat) });
    this.pump();
  }

  sendMark(epoch: number, name: string): void {
    this.ops.push({ op: 'mark', epoch, name });
    this.queue.push({ kind: 'mark', epoch, name });
    this.pump();
  }

  clear(epoch: number): void {
    this.ops.push({ op: 'clear', epoch });
    this.queue = this.queue.filter((item) => item.epoch > epoch);
    setTimeout(() => this.emit({ type: 'playback_cleared', epoch }), 2);
  }

  pause(): void {
    this.ops.push({ op: 'pause' });
    this.paused = true;
  }

  resume(): void {
    this.ops.push({ op: 'resume' });
    this.paused = false;
    this.pump();
  }

  close(reason: string): void {
    this.closedReason ??= reason;
  }

  // ── test helpers ──

  emit(event: TransportEvent): void {
    this.handler?.(event);
  }

  feed(frames: readonly Uint8Array[]): void {
    for (const data of frames) this.emit({ type: 'audio', data });
  }

  audioOps(epoch?: number): number {
    return this.ops.filter((o) => o.op === 'audio' && (epoch === undefined || o.epoch === epoch)).length;
  }

  /** Audio sent for `epoch` after it was cleared — must always be 0. */
  audioAfterClear(epoch: number): number {
    const clearAt = this.ops.findIndex((o) => o.op === 'clear' && o.epoch === epoch);
    if (clearAt === -1) return 0;
    return this.ops.slice(clearAt + 1).filter((o) => o.op === 'audio' && o.epoch === epoch).length;
  }

  count(op: TransportOp['op']): number {
    return this.ops.filter((o) => o.op === op).length;
  }

  private pump(): void {
    while (!this.busy && !this.paused) {
      const item = this.queue.shift();
      if (!item) return;
      if (item.kind === 'mark') {
        this.emit({ type: 'mark', name: item.name });
        continue;
      }
      if (!this.started.has(item.epoch)) {
        this.started.add(item.epoch);
        this.emit({ type: 'playback_started', epoch: item.epoch });
      }
      this.busy = true;
      setTimeout(() => {
        this.busy = false;
        this.pump();
      }, item.ms * this.playbackSpeed);
    }
  }
}
