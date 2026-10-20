// Port of FaceEngine/BackgroundBurst.swift and BackgroundBurst+Step.swift (the Swift extension folded in).
import { v3, type V3 } from '../core/vec';
import { Oklab } from '../model';
import type { AgentState } from './AgentState';
import { OneShotKind } from './Commands';
import { Ease } from './Easing';
import type { FaceState } from './FaceState';
import { BackgroundBurstStyle, tintEquals, type BackgroundBurstTint } from './BackgroundBurstStyle';
import type { MoodBackgroundConfig } from './MoodBackground';
import { MoodPalette } from './MoodPalette';
import type { ClosedRangeF } from './SettingsSupport';

/// `MoodBackground.chromaCap` / `presenceTarget` (here to avoid an import cycle with MoodBackground).
const CHROMA_CAP = 0.16;
function presenceTarget(s: FaceState): number {
  if (s.backgroundSuppressed) return 0;
  if (s.isBedtime && !s.backgroundConfig.colourAtBedtime) return 0;
  return s.agentState === 'asleep' || s.agentState === 'halfAwake' ? 0 : 1;
}

const ZERO3 = (): V3 => v3(0);

/// One burst slot. A class standing in for a Swift struct: `copy()` where the Swift copies.
export class BurstSlot {
  active = false;
  kind: OneShotKind = 'laugh';
  tint: BackgroundBurstTint = { kind: 'none' };
  /// Absolute burst colour (Oklab); unused for a lift.
  colour: V3 = ZERO3();
  lift = false;
  /// The hue arc's direction (±1, fixed at the onset; 0 for a lift).
  hueDir = 0;
  start = 0;
  from = 0;
  peak = 0;
  attack = 0;
  hold = 0;
  release = 1;
  level = 0;

  static make(o: Partial<BurstSlot>): BurstSlot { return Object.assign(new BurstSlot(), o); }
  copy(): BurstSlot { const c = Object.assign(new BurstSlot(), this); c.colour = { ...this.colour }; return c; }

  levelAt(t: number): number {
    const u = t - this.start;
    if (u < 0) return this.from;
    if (u < this.attack) return this.from + (this.peak - this.from) * Ease.smootherstep(u / this.attack);
    const r = u - this.attack - this.hold;
    if (r < 0) return this.peak;
    if (r < this.release) return this.peak * (1 - Ease.smootherstep(r / this.release));
    return 0;
  }

  endedAt(t: number): boolean { return t - this.start >= this.attack + this.hold + this.release; }
}

interface BurstRequest { kind: OneShotKind; due: number; strength: number }

const mix = (a: V3, b: V3, t: number): V3 => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/// One-shot colour bursts on the mood background (mood background design §4, "Colour bursts"): a separate accent layer
/// above the mood colour, blended along an Oklch hue arc, decaying back to exactly the current mood colour.
///
/// - **Envelope:** an eased swell (smootherstep, `attack`) to the peak, a short hold, an eased release to exactly 0.
/// - **Timing:** the swell peaks on the one-shot's first accent, at most `maxDelay` after it starts.
/// - **Gating:** mood mode with bursts on, the background visible and Yanni not sleepy.
/// - **Photosensitivity:** onsets at least `minOnsetGap` apart; peaks cut so relative luminance moves at most
///   `maxLuminanceStep` (Reduce Motion half); layered bursts pulled back to the same bound.
/// - **Reduce Motion:** slower swell and release, a longer hold, peaks × 0.6 and half the luminance step.
///
/// Owned by `MoodBackground`; a class standing in for a Swift struct (`copy()`).
export class BackgroundBurst {
  static readonly attack = 0.14;
  static readonly defaultHold = 0.12;
  static readonly release = 1.0;
  static readonly reduceMotionAttack = 0.35;
  static readonly reduceMotionExtraHold = 0.1;
  static readonly reduceMotionRelease = 1.6;
  static readonly reduceMotionAmplitude = 0.6;
  /// Shortest time between two burst onsets (seconds).
  static readonly minOnsetGap = 0.35;
  /// A waiting request older than this past its due time is dropped.
  static readonly staleAfter = 0.5;
  /// Longest delay from a one-shot's start to its burst's peak.
  static readonly maxDelay = 0.6;
  /// Largest relative-luminance change a burst may make (Reduce Motion: half).
  static readonly maxLuminanceStep = 0.06;
  /// Colour-distance budget (ΔE_ok) of a full-strength burst.
  static readonly maxDistance = 0.3;
  /// ΔE_ok under which the mood colour counts as "already that colour" (the burst uses its alternate).
  static readonly alternateDistance = 0.08;
  static readonly maxLightnessRise = 0.05;
  static readonly maxLightnessDip = 0.04;
  /// Hue turn (radians, toward orange) for a yellow burst darkened to the mood's lightness.
  static readonly yellowToOrange = 0.45;
  static readonly liftLightness = 0.06;
  static readonly liftChroma = 1.3;
  static readonly minPresence = 0.3;
  static readonly minStrength = 0.05;
  /// States in which no burst starts.
  static readonly sleepyStates: readonly AgentState[] = ['drowsy', 'asleep', 'halfAwake', 'waking'];

  /// The burst per one-shot kind, indexed by `OneShotKind.ordinal` (authored; editable).
  styles: BackgroundBurstStyle[] = [...BackgroundBurstStyle.standardTable];

  style(kind: OneShotKind): BackgroundBurstStyle {
    const i = OneShotKind.ordinal(kind);
    return i < this.styles.length ? this.styles[i] : BackgroundBurstStyle.none;
  }

  older = new BurstSlot();
  newer = new BurstSlot();
  pending: BurstRequest | null = null;
  lastOnset = -Infinity;

  copy(): BackgroundBurst {
    const b = new BackgroundBurst();
    b.styles = [...this.styles]; b.older = this.older.copy(); b.newer = this.newer.copy();
    b.pending = this.pending && { ...this.pending }; b.lastOnset = this.lastOnset;
    return b;
  }

  /// The most recent burst still showing (null when none).
  get activeKind(): OneShotKind | null { return this.newer.active ? this.newer.kind : (this.older.active ? this.older.kind : null); }
  /// The strongest level showing, 0…1.
  get level(): number {
    const a = this.newer.active ? this.newer.level : 0, b = this.older.active ? this.older.level : 0;
    return b >= a ? b : a;
  }
  get isActive(): boolean { return this.newer.active || this.older.active; }
  get lastOnsetTime(): number { return this.lastOnset; }

  // MARK: Colours and bounds

  /// Whether a new burst may start now.
  static allowed(s: FaceState, presence: number, strength: number): boolean {
    const c = s.backgroundConfig;
    return c.mode === 'mood' && c.colourBursts && c.burstStrength > 0
      && presenceTarget(s) > 0 && presence >= BackgroundBurst.minPresence && strength >= BackgroundBurst.minStrength
      && !BackgroundBurst.sleepyStates.includes(s.agentState);
  }

  /// Relative luminance of an Oklab colour (linear sRGB, clamped).
  static luminance(lab: V3): number {
    const c = Oklab.toLinearClamped(lab, ZERO3());
    return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
  }

  /// The hue difference b − a (radians, wrapped to −π…π), pushed onto `direction`'s side when it points the other way
  /// by more than 90°.
  static hueDelta(a: V3, b: V3, direction: number): number {
    let d = Math.atan2(b.z, b.y) - Math.atan2(a.z, a.y);
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    const half = Math.PI / 2;
    if (direction > 0 && d < -half) d += 2 * Math.PI;
    if (direction < 0 && d > half) d -= 2 * Math.PI;
    return d;
  }

  /// A burst mix from `a` toward `b`: lightness and chroma linear, hue along an arc (Oklch). Near-grey ends blend
  /// straight in Oklab. t ≤ 0 is exactly `a`.
  static mixArc(a: V3, b: V3, t: number, direction: number): V3 {
    if (!(t > 0)) return a;
    if (t >= 1) return b;
    const straight = mix(a, b, t);
    const ca = Math.sqrt(a.y * a.y + a.z * a.z), cb = Math.sqrt(b.y * b.y + b.z * b.z);
    const w = Ease.smoothstep((Math.min(ca, cb) - 0.01) / 0.02);
    if (!(w > 0)) return straight;
    // The hue leads (ease-out).
    const h = Math.atan2(a.z, a.y) + BackgroundBurst.hueDelta(a, b, direction) * (t * (2 - t));
    const c = ca + (cb - ca) * t;
    const arc = v3(straight.x, c * Math.cos(h), c * Math.sin(h));
    return w >= 1 ? arc : mix(straight, arc, w);
  }

  /// The lift tint over `mood`: lighter and a little richer, banded.
  static lifted(mood: V3, band: ClosedRangeF): V3 {
    const L = BackgroundBurst.liftChroma;
    return MoodPalette.banded(v3(mood.x + BackgroundBurst.liftLightness, mood.y * L, mood.z * L), band, CHROMA_CAP);
  }

  /// The burst colour for a tint over `mood` (null for a lift or none), banded into the band.
  static colour(tint: BackgroundBurstTint, mood: V3, band: ClosedRangeF): V3 | null {
    if (tint.kind !== 'colour') return null;
    const lab = (hex: number): V3 => MoodPalette.banded(Oklab.fromLinear(Oklab.linear(hex)), band, CHROMA_CAP);
    const p = lab(tint.primary);
    const dd = Math.sqrt((p.x - mood.x) ** 2 + (p.y - mood.y) ** 2 + (p.z - mood.z) ** 2);
    const c = dd < BackgroundBurst.alternateDistance ? lab(tint.alternate) : p;
    // Hue-forward: the burst keeps close to the mood's lightness.
    const l = mood.x + Math.min(Math.max(c.x - mood.x, -BackgroundBurst.maxLightnessDip), BackgroundBurst.maxLightnessRise);
    // A yellow-family burst held well below its own lightness turns toward orange.
    let a = c.y, b = c.z;
    const cut = c.x - l;
    if (cut > 0) {
      const h = Math.atan2(b, a), deg = h * 180 / Math.PI;
      if (deg > 50 && deg < 120) {
        const edge = Math.min(Math.min(deg - 50, 120 - deg) / 15, 1);
        const nh = h - BackgroundBurst.yellowToOrange * Math.min(cut / 0.06, 1) * edge;
        const ch = Math.sqrt(a * a + b * b);
        a = ch * Math.cos(nh); b = ch * Math.sin(nh);
      }
    }
    return MoodPalette.banded(v3(l, a, b), band, CHROMA_CAP);
  }

  /// The largest peak ≤ `peak` whose mix from `mood` toward `target` changes relative luminance by ≤ `step` and moves
  /// the colour by ≤ `distance` (ΔE_ok). Bisection; runs once per burst onset.
  static boundedPeak(peak: number, mood: V3, target: V3, step: number, distance = Infinity, direction = 0): number {
    const y0 = BackgroundBurst.luminance(mood);
    const ok = (p: number): boolean => {
      const c = BackgroundBurst.mixArc(mood, target, p, direction);
      const d = Math.sqrt((c.x - mood.x) ** 2 + (c.y - mood.y) ** 2 + (c.z - mood.z) ** 2);
      return Math.abs(BackgroundBurst.luminance(c) - y0) <= step && d <= distance;
    };
    const top = Math.max(peak, 0);
    if (ok(top)) return top;
    let lo = 0, hi = top;
    for (let i = 0; i < 14; i++) {
      const m = (lo + hi) / 2;
      if (ok(m)) lo = m; else hi = m;
    }
    return lo;
  }

  // MARK: Stepping

  /// Steps the bursts and returns the displayed colour: `mood` with the bursts blended on top. Consumes
  /// `s.backgroundBurstRequests`.
  step(s: FaceState, mood: V3, band: ClosedRangeF, presence: number, strength: number): V3 {
    const now = s.time;
    const cfg = s.backgroundConfig;
    const ok = BackgroundBurst.allowed(s, presence, strength);
    const attack = cfg.reduceMotion ? BackgroundBurst.reduceMotionAttack : BackgroundBurst.attack;

    // 1. Requests: one-shots that started this frame (peaking on their first accent) and manual ones.
    if (ok) {
      for (const st of s.startedOneShots) {
        const sty = this.style(st.kind);
        if (sty.isNone) continue;
        const accent = (st.accentTimes[0] ?? 0) / Math.max(st.rate, 0.01);
        const delay = Math.min(Math.max(accent - attack, 0), BackgroundBurst.maxDelay);
        this.enqueue({ kind: st.kind, due: st.engineTime + delay, strength: sty.strength });
      }
      // A manual request made between frames is due at this frame's start, so 60 and 120 fps agree.
      const frameStart = now - Math.max(s.dt, 0);
      for (const k of s.backgroundBurstRequests) {
        if (!this.style(k).isNone) this.enqueue({ kind: k, due: frameStart, strength: this.style(k).strength });
      }
    } else {
      this.pending = null;
    }
    if (s.backgroundBurstRequests.length > 0) s.backgroundBurstRequests.length = 0;

    // 2. Fire the waiting request once it is due and the onset gap has passed.
    const r = this.pending;
    if (r !== null) {
      const start = Math.max(r.due, this.lastOnset + BackgroundBurst.minOnsetGap);
      if (now - start > BackgroundBurst.staleAfter) {
        this.pending = null;
      } else if (now >= start) {
        this.pending = null;
        this.fire(r.kind, start, mood, band, cfg);
      }
    }

    // 3. Advance and blend (older first, newer on top), then the luminance guard.
    this.older = BackgroundBurst.advance(this.older, now);
    this.newer = BackgroundBurst.advance(this.newer, now);
    return BackgroundBurst.compose(this.older, this.newer, mood, band, BackgroundBurst.luminanceStep(cfg));
  }

  static luminanceStep(cfg: MoodBackgroundConfig): number { return BackgroundBurst.maxLuminanceStep * (cfg.reduceMotion ? 0.5 : 1); }

  private static advance(slot: BurstSlot, now: number): BurstSlot {
    if (!slot.active) return slot;
    if (slot.endedAt(now)) return new BurstSlot();
    slot.level = Math.min(Math.max(slot.levelAt(now), 0), 1);
    return slot;
  }

  /// The displayed colour from the slots' current levels, pulled back toward the mood colour until its luminance is
  /// within `step`.
  static compose(older: BurstSlot, newer: BurstSlot, mood: V3, band: ClosedRangeF, step: number): V3 {
    let out = mood;
    if (older.active && older.level > 0) {
      out = BackgroundBurst.mixArc(out, BackgroundBurst.target(older, mood, band), older.level, older.hueDir);
    }
    if (newer.active && newer.level > 0) {
      out = BackgroundBurst.mixArc(out, BackgroundBurst.target(newer, mood, band), newer.level, newer.hueDir);
    }
    const y0 = BackgroundBurst.luminance(mood);
    let k = 1;
    for (let i = 0; i < 4; i++) {
      const dy = Math.abs(BackgroundBurst.luminance(mix(mood, out, k)) - y0);
      if (!(dy > step)) break;
      k *= step / dy * 0.98;
    }
    return k < 1 ? mix(mood, out, k) : { ...out };
  }

  private enqueue(r: BurstRequest): void {
    if (this.pending !== null && this.pending.strength >= r.strength) return;
    this.pending = r;
  }

  private static target(slot: BurstSlot, mood: V3, band: ClosedRangeF): V3 {
    return slot.lift ? BackgroundBurst.lifted(mood, band) : slot.colour;
  }

  private fire(kind: OneShotKind, start: number, mood: V3, band: ClosedRangeF, cfg: MoodBackgroundConfig): void {
    const sty = this.style(kind);
    const rm = cfg.reduceMotion;
    const lift = sty.tint.kind === 'lift';
    const colour = lift ? BackgroundBurst.lifted(mood, band) : BackgroundBurst.colour(sty.tint, mood, band);
    if (colour === null) return;
    const amp = Math.min(Math.max(sty.strength, 0), 1) * Math.min(Math.max(cfg.burstStrength, 0), 1)
      * (rm ? BackgroundBurst.reduceMotionAmplitude : 1);
    const dir = lift ? 0 : (BackgroundBurst.hueDelta(mood, colour, 0) < 0 ? -1 : 1);
    // The peak is the authored strength, cut by the luminance step and by a colour-distance budget.
    const peak = BackgroundBurst.boundedPeak(amp, mood, colour, BackgroundBurst.luminanceStep(cfg),
      amp * BackgroundBurst.maxDistance, dir);
    if (!(peak > 0.005)) return;
    this.lastOnset = start;
    const attack = rm ? BackgroundBurst.reduceMotionAttack : BackgroundBurst.attack;
    const hold = Math.max(sty.hold, 0) + (rm ? BackgroundBurst.reduceMotionExtraHold : 0);
    const release = rm ? BackgroundBurst.reduceMotionRelease : BackgroundBurst.release;

    if (this.older.active && !this.newer.active) {
      // The newer burst ended first (a shorter hold): the older one is now the newest.
      this.newer = this.older;
      this.older = new BurstSlot();
    }
    if (this.newer.active && tintEquals(this.newer.tint, sty.tint)) {
      // Same tint: retarget from the current level (never restart from 0).
      const from = this.newer.levelAt(start);
      this.newer = BurstSlot.make({
        active: true, kind, tint: sty.tint, colour: this.newer.colour, lift, hueDir: this.newer.hueDir, start, from,
        peak: Math.max(peak, from), attack, hold, release, level: from,
      });
      return;
    }
    if (this.older.active && this.newer.active) {
      // A third burst: fold the two playing ones into the colour they show at this instant, then release it.
      const o = this.older.copy(), n = this.newer.copy();
      o.level = Math.min(Math.max(o.levelAt(start), 0), 1);
      n.level = Math.min(Math.max(n.levelAt(start), 0), 1);
      const c = BackgroundBurst.compose(o, n, mood, band, BackgroundBurst.luminanceStep(cfg));
      const d2 = BackgroundBurst.hueDelta(mood, c, 0) < 0 ? -1 : 1;
      this.newer = BurstSlot.make({
        active: true, kind: this.newer.kind, tint: this.newer.tint, colour: c, lift: false, hueDir: d2, start,
        from: 1, peak: 1, attack: 0, hold: 0, release: this.newer.release, level: 1,
      });
    }
    this.older = this.newer;
    this.newer = BurstSlot.make({
      active: true, kind, tint: sty.tint, colour, lift, hueDir: dir, start, from: 0, peak, attack, hold, release, level: 0,
    });
  }
}
