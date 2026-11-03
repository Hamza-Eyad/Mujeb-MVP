/** Percentiles of frame levels, dBFS. Numbers only: no audio is kept. */
export interface LevelStats {
  frames: number;
  p10_db: number;
  p50_db: number;
  p90_db: number;
  max_db: number;
}

const FLOOR_DB = -100;

/** Frame levels counted in 1 dB bins (clamped to -100..0 dBFS), so percentiles cost no memory per frame. */
export class LevelHistogram {
  private readonly bins = new Uint32Array(-FLOOR_DB + 1);
  private count = 0;
  private maxDb = FLOOR_DB;

  get frames(): number {
    return this.count;
  }

  add(db: number): void {
    const clamped = Math.min(0, Math.max(FLOOR_DB, db));
    const bin = Math.floor(clamped) - FLOOR_DB;
    this.bins[bin] = (this.bins[bin] ?? 0) + 1;
    this.count += 1;
    if (clamped > this.maxDb) this.maxDb = clamped;
  }

  /** Nearest-rank percentiles, each the lower edge of its 1 dB bin. Undefined before any frame. */
  stats(): LevelStats | undefined {
    if (this.count === 0) return undefined;
    return {
      frames: this.count,
      p10_db: this.percentile(0.1),
      p50_db: this.percentile(0.5),
      p90_db: this.percentile(0.9),
      max_db: Math.round(this.maxDb * 10) / 10,
    };
  }

  private percentile(p: number): number {
    const rank = Math.max(1, Math.ceil(p * this.count));
    let seen = 0;
    for (let bin = 0; bin < this.bins.length; bin += 1) {
      seen += this.bins[bin] ?? 0;
      if (seen >= rank) return bin + FLOOR_DB;
    }
    return 0;
  }
}
