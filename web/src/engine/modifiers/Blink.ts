// Port of FaceEngine/Modifiers/Blink.swift.
import type { SplitMix64 } from '../../core/random';
import { Ease } from '../Easing';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';

interface Shape { close: number; hold: number; open: number; depth: number }

interface Plan {
  /// Progress (rate-normalised seconds) at which the blink fires.
  target: number;
  isDouble: boolean;
  gap: number;
  first: Shape;
  second: Shape;
}

class Active {
  constructor(readonly start: number, readonly c0: number, readonly tc: number, readonly th: number,
    readonly to: number, readonly depth: number) {}
  get end(): number { return this.start + this.tc + this.th + this.to; }
  get openingStarts(): number { return this.start + this.tc + this.th; }

  value(t: number): number {
    const e = t - this.start;
    if (e <= 0) return this.c0;
    if (e < this.tc) return this.c0 + (this.depth - this.c0) * Ease.inQuad(e / this.tc);
    if (e < this.tc + this.th) return this.depth;
    const p = (e - this.tc - this.th) / this.to;
    if (p >= 1) return 0;
    const q = 1 - p;
    return this.depth * q * q; // ease-out opening: fast start, gentle landing
  }
}

/// Irregular natural blinking on the `blink` closure channel (design C6, Part D C4/H4/H5/M13).
///
/// - Intervals are lognormal (median 3.5 s / blinkRate, clamped 0.8–10 s), measured in rate-normalised time
///   (progress += dt·blinkRate), so rate changes take effect smoothly and blinkRate 0 suppresses blinking.
/// - Everything random about the next blink is drawn once when it is scheduled. Scheduled blinks start at their exact
///   crossing time, so 60 and 120 fps give identical curves.
/// - Curve: close 70 ms ease-in, hold 30 ms, open 140 ms ease-out; stretched by `blinkDuration / speed`.
/// - Honours `saccadeBlinkRequest` (if no blink in the last 0.6 s) and the `.blink` command.
/// - Defers while a one-shot owns closure; a one-shot blink counts as a blink and pushes the schedule out.
export class Blink implements Modifier {
  readonly name = 'Blink';
  readonly phase = Phase.lids;
  isEnabled = true;

  static readonly medianInterval = 3.5;
  static readonly intervalSigma = 0.4;
  static readonly minInterval = 0.8;
  static readonly maxInterval = 10;
  static readonly doubleBlinkChance = 0.12;
  /// Second blink of a double starts this long after the first one begins to reopen.
  static readonly doubleGap: readonly [number, number] = [0.12, 0.2];
  static readonly closeDuration = 0.07;
  static readonly holdDuration = 0.03;
  static readonly openDuration = 0.14;
  static readonly maxHold = 0.3;
  /// Per-blink duration jitter.
  static readonly timingJitter: readonly [number, number] = [0.88, 1.15];
  /// Depth is 1 − depthJitter·u².
  static readonly depthJitter = 0.08;
  /// No saccade-triggered blink within this long after the previous blink.
  static readonly saccadeRefractory = 0.6;
  /// After a one-shot releases the closure channel, wait this long before a natural blink.
  static readonly releaseDelay = 0.25;

  blinkCount = 0;
  /// Number of second blinks of a double blink that actually played.
  doubleBlinkCount = 0;

  private plan: Plan | null = null;
  private progress = 0;
  private active: Active | null = null;
  private pendingSecond: { time: number; shape: Shape } | null = null;
  private pendingCommand = false;
  private prevOneShotBlink = 0;
  private lastOwnedTime = -Infinity;

  update(s: FaceState): void {
    const t = s.time;
    const dt = s.dt;
    const rate = Math.max(Number.isFinite(s.modulation.blinkRate) ? s.modulation.blinkRate : 1, 0);

    if (this.plan === null) this.plan = this.makePlan(s.rng, rate);

    for (const c of s.commands) if (c.kind === 'blink') this.pendingCommand = true;

    // One-shot blinks count as blinks: note the start and push the schedule out.
    const oneShotBlink = s.oneShot.blink;
    if (oneShotBlink > 0) {
      if (this.prevOneShotBlink <= 0) {
        s.lastBlinkTime = t;
        this.reschedule(s.rng, rate);
      }
      this.progress = 0;
      this.pendingSecond = null;
    }
    this.prevOneShotBlink = oneShotBlink;
    if (s.oneShot.ownsClosure) this.lastOwnedTime = t;

    this.progress += dt * rate;

    const blocked = s.oneShot.ownsClosure || oneShotBlink > 0 || t - this.lastOwnedTime < Blink.releaseDelay;
    const free = this.active ? t >= this.active.openingStarts : true;
    const canStart = !blocked && free;

    const second = this.pendingSecond;
    if (second !== null && t >= second.time) {
      this.pendingSecond = null;
      if (canStart && rate > 0) {
        this.start(Math.max(second.time, t - dt), second.shape, s);
        this.doubleBlinkCount += 1;
      }
    }

    const p = this.plan;
    if (this.pendingCommand && canStart && !this.isClosing(t)) {
      this.pendingCommand = false;
      this.start(t, this.drawShape(s.rng), s);
      this.reschedule(s.rng, rate);
    } else if (s.saccadeBlinkRequest && rate > 0 && canStart && !this.isClosing(t)
      && t - s.lastBlinkTime >= Blink.saccadeRefractory) {
      this.start(t, this.drawShape(s.rng), s);
      this.reschedule(s.rng, rate);
    } else if (p !== null && this.progress >= p.target && rate > 0) {
      if (canStart && !this.isClosing(t)) {
        // Exact crossing time, so the curve is sampled identically at any frame rate.
        const overshoot = this.progress - p.target;
        const exact = Math.min(Math.max(t - overshoot / rate, t - dt), t);
        const ts = Math.max(exact, this.active?.openingStarts ?? exact);
        this.start(ts, p.first, s);
        if (p.isDouble && this.active) this.pendingSecond = { time: this.active.openingStarts + p.gap, shape: p.second };
        this.progress = overshoot;
        this.plan = this.makePlan(s.rng, rate);
      } else {
        // Wait at the threshold; fire as soon as allowed.
        this.progress = p.target;
      }
    }

    let c = 0;
    const a = this.active;
    if (a) {
      c = a.value(t);
      if (t >= a.end) this.active = null;
    }
    const cl = Math.min(Math.max(c, 0), 1);
    s.blink = cl >= s.blink ? cl : s.blink; // Swift max(s.blink, …)
  }

  private isClosing(t: number): boolean {
    return this.active !== null && t < this.active.openingStarts;
  }

  private start(ts: number, shape: Shape, s: FaceState): void {
    const m = s.modulation;
    const speed = Math.min(Math.max(Number.isFinite(m.speed) ? m.speed : 1, 0.3), 3);
    const dur = Math.min(Math.max(Number.isFinite(m.blinkDuration) ? m.blinkDuration : 1, 0.4), 3);
    const k = dur / speed;
    const hold = Math.min(Blink.holdDuration * dur * dur * dur / speed, Blink.maxHold);
    const c0 = this.active ? Math.max(this.active.value(ts), 0) : 0;
    this.active = new Active(ts, c0, Blink.closeDuration * k * shape.close, hold * shape.hold,
      Blink.openDuration * k * shape.open, Math.max(shape.depth, c0));
    s.lastBlinkTime = ts;
    this.blinkCount += 1;
  }

  private reschedule(rng: SplitMix64, rate: number): void {
    this.progress = 0;
    this.plan = this.makePlan(rng, rate);
  }

  private drawShape(rng: SplitMix64): Shape {
    const u = rng.unit();
    const j = Blink.timingJitter;
    const close = rng.uniform(j[0], j[1]);
    const hold = rng.uniform(j[0], j[1]);
    const open = rng.uniform(j[0], j[1]);
    return { close, hold, open, depth: 1 - Blink.depthJitter * u * u };
  }

  private makePlan(rng: SplitMix64, rate: number): Plan {
    // Interval in rate-normalised seconds; clamp so the real interval at the current rate is 0.8–10 s.
    const r = Math.max(rate, 0.05);
    const target = rng.lognormal(Blink.medianInterval, Blink.intervalSigma, [Blink.minInterval * r, Blink.maxInterval * r]);
    const isDouble = rng.chance(Blink.doubleBlinkChance);
    const gap = rng.uniform(Blink.doubleGap[0], Blink.doubleGap[1]);
    const first = this.drawShape(rng);
    const second = this.drawShape(rng);
    return { target, isDouble, gap, first, second };
  }
}
