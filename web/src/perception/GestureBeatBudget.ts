// Port of FacePerception/GestureBeatBudget.swift.

interface Pair { person: number; gesture: number; times: number[]; quietUntil: number }
const makePair = (person = -1, gesture = -1): Pair => ({ person, gesture, times: [-Infinity, -Infinity, -Infinity], quietUntil: -Infinity });
const maxTime = (p: Pair): number => Math.max(...p.times);

/// The beat-level anti-spam rules of the gesture layer (design §6.5), kept at the reflex table:
/// - Global beat budget: at most one gesture beat per `minSpacing` (8 s) and `maxPerWindow` (5) per `window` (10 min).
///   Over budget → event only (reason "budget").
/// - Habituation: the same person and gesture within `habituationWindow` (3 min): the 2nd reaction plays at 60 %, the
///   3rd at 30 %, then events only for that pair for `quietFor` (5 min).
export class GestureBeatBudget {
  minSpacing = 8;
  maxPerWindow = 5;
  window = 600;
  habituationWindow = 180;
  quietFor = 300;
  static readonly intensities: readonly number[] = [1, 0.6, 0.3];

  private beats: number[] = new Array<number>(8).fill(-Infinity);
  private next = 0;
  private pairs: Pair[] = Array.from({ length: 24 }, () => makePair());

  copy(): GestureBeatBudget {
    const c = Object.assign(new GestureBeatBudget(), this);
    c.beats = [...this.beats];
    c.pairs = this.pairs.map((p) => ({ ...p, times: [...p.times] }));
    return c;
  }

  // port-note: like the Swift, reset() leaves `next` where it was.
  reset(): void {
    this.beats.fill(-Infinity);
    for (let i = 0; i < this.pairs.length; i++) this.pairs[i] = makePair();
  }

  /// Why the budget refuses a beat now, or null.
  refusal(now: number): string | null {
    let inWindow = 0, latest = -Infinity;
    for (const t of this.beats) if (now - t < this.window) { inWindow += 1; latest = Math.max(latest, t); }
    if (now - latest < this.minSpacing) return `budget (1 per ${Math.trunc(this.minSpacing)} s)`;
    if (inWindow >= this.maxPerWindow) return `budget (${this.maxPerWindow} per ${Math.trunc(this.window / 60)} min)`;
    return null;
  }

  /// The intensity this person's next reaction to this gesture plays at, or null when habituated (events only).
  intensity(person: number | null, gesture: number, now: number): number | null {
    if (person === null) return 1;
    const p = this.pairs.find((q) => q.person === person && q.gesture === gesture);
    if (p === undefined) return 1;
    if (now < p.quietUntil) return null;
    let n = 0;
    for (const t of p.times) if (now - t <= this.habituationWindow) n += 1;
    return n < GestureBeatBudget.intensities.length ? GestureBeatBudget.intensities[n] : null;
  }

  /// Books a beat that played (the budget and, with a person, the habituation pair).
  record(person: number | null, gesture: number, now: number): void {
    this.beats[this.next] = now;
    this.next = (this.next + 1) % this.beats.length;
    if (person === null) return;
    let i = this.pairs.findIndex((q) => q.person === person && q.gesture === gesture);
    if (i < 0) {
      let oldest = 0;
      for (let j = 0; j < this.pairs.length; j++) if (maxTime(this.pairs[j]) < maxTime(this.pairs[oldest])) oldest = j;
      this.pairs[oldest] = makePair(person, gesture);
      i = oldest;
    }
    const p = this.pairs[i];
    // Oldest slot out, this one in.
    let o = 0;
    for (let j = 1; j < p.times.length; j++) if (p.times[j] < p.times[o]) o = j;
    p.times[o] = now;
    let n = 0;
    for (const t of p.times) if (now - t <= this.habituationWindow) n += 1;
    if (n >= GestureBeatBudget.intensities.length) p.quietUntil = now + this.quietFor;
  }

  /// Beats booked within the window (status).
  beatsInWindow(now: number): number { return this.beats.filter((t) => now - t < this.window).length; }
}
