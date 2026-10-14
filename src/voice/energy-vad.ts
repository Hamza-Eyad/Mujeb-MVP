/**
 * Lightweight energy (RMS) voice activity detector with an adaptive noise floor.
 * Used for *measurement* (user speech start/end → e2e latency, barge-in reaction time),
 * not for turn decisions — the STT provider's VAD/commit drives turns.
 */

export interface EnergyVadOptions {
  /** Absolute minimum level (dBFS) for a frame to count as speech. */
  thresholdDb: number;
  /** Speech must also exceed the tracked noise floor by this margin. */
  noiseMarginDb: number;
  minSpeechMs: number;
  hangoverMs: number;
}

export const DEFAULT_ENERGY_VAD_OPTIONS: EnergyVadOptions = {
  thresholdDb: -48,
  noiseMarginDb: 10,
  minSpeechMs: 100,
  hangoverMs: 300,
};

export type VadEvent =
  | { type: 'speech_start'; startedMsAgo: number }
  | { type: 'speech_end'; endedMsAgo: number };

export class EnergyVad {
  private readonly options: EnergyVadOptions;
  private noiseFloorDb = -70;
  private voicedMs = 0;
  private silentMs = 0;
  private speaking = false;

  constructor(options: EnergyVadOptions = DEFAULT_ENERGY_VAD_OPTIONS) {
    this.options = options;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  process(samples: Int16Array, sampleRate: number): VadEvent | null {
    if (samples.length === 0) return null;
    const frameMs = (samples.length / sampleRate) * 1000;
    const level = rmsDb(samples);
    const threshold = Math.max(this.options.thresholdDb, this.noiseFloorDb + this.options.noiseMarginDb);
    const voiced = level > threshold;

    if (!voiced && !this.speaking) this.trackNoise(level);

    if (!this.speaking) {
      if (!voiced) {
        this.voicedMs = 0;
        return null;
      }
      this.voicedMs += frameMs;
      if (this.voicedMs < this.options.minSpeechMs) return null;
      this.speaking = true;
      this.silentMs = 0;
      return { type: 'speech_start', startedMsAgo: this.voicedMs };
    }

    if (voiced) {
      this.silentMs = 0;
      return null;
    }
    this.silentMs += frameMs;
    if (this.silentMs < this.options.hangoverMs) return null;
    const endedMsAgo = this.silentMs;
    this.speaking = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    return { type: 'speech_end', endedMsAgo };
  }

  private trackNoise(level: number): void {
    const bounded = Math.min(-30, Math.max(-90, level));
    // Follow quiet levels quickly, louder ambient levels slowly.
    this.noiseFloorDb = bounded < this.noiseFloorDb ? bounded : this.noiseFloorDb + (bounded - this.noiseFloorDb) * 0.02;
  }
}

export function rmsDb(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, samples.length)) / 32768;
  return 20 * Math.log10(rms + 1e-9);
}
