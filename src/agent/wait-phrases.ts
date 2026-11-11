/**
 * The clinic's wait phrases ("لحظة أشيك لك.", "ثواني بس.", …), said before a tool runs when the model has said
 * nothing yet. One picker per session, so a call hears variety: every phrase once, in a random order, before any
 * phrase repeats, and never the same phrase twice in a row (a new round of the bag included).
 */
export interface WaitPhraseSource {
  /** Every phrase the caller may hear (the model sometimes repeats one; see AgentTurn). */
  readonly all: readonly string[];
  /** The phrase to say now. Call it only when the phrase is actually said: it counts as used. */
  next(): string;
}

export class WaitPhrasePicker implements WaitPhraseSource {
  readonly all: readonly string[];
  private bag: string[] = [];
  private last: string | undefined;
  private readonly random: () => number;
  private readonly onPick: (() => void) | undefined;

  /** `phrases` must not be empty; duplicates count once. */
  constructor(phrases: readonly string[], options: { random?: () => number; onPick?: () => void } = {}) {
    this.all = [...new Set(phrases.map((p) => p.trim()).filter((p) => p !== ''))];
    if (this.all.length === 0) throw new Error('WaitPhrasePicker needs at least one phrase');
    this.random = options.random ?? Math.random;
    this.onPick = options.onPick;
  }

  next(): string {
    if (this.bag.length === 0) this.bag = this.refill();
    const phrase = this.bag.pop() ?? this.all[0] ?? '';
    this.last = phrase;
    this.onPick?.();
    return phrase;
  }

  /** A shuffled bag (Fisher–Yates). Phrases leave from its end, so the end must not be the phrase said last. */
  private refill(): string[] {
    const bag = [...this.all];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j] as string, bag[i] as string];
    }
    const end = bag.length - 1;
    if (end > 0 && bag[end] === this.last) [bag[0], bag[end]] = [bag[end] as string, bag[0] as string];
    return bag;
  }
}
