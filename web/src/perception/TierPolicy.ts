// Port of FacePerception/TierPolicy.swift.
import { PerceptionTier } from './PerceptionTypes';

/// What runs on an analysed frame, per tier.
export interface StagePlan {
  analysisFPS: number;
  /// Face landmarks (eye direction) for at most this many faces within this distance (0 = off).
  landmarkFaces: number;
  landmarkMaxDistance: number;
  /// Hand pose (on even frames) and body pose (on odd frames).
  handPose: boolean;
  maxHands: number;
  handMaxDistance: number;
  bodyPose: boolean;
  /// Motion map every Nth analysed frame (0 = off).
  motionEvery: number;
  maxPeople: number;
  /// Low mode: human rectangles only.
  rectanglesOnly: boolean;
  /// Gestures for the primary person only (hand pose with a region of interest around their upper body).
  gesturesPrimaryOnly: boolean;
  /// Zoomed wrist hand passes per analysed frame (design §4.2; a candidate stage). Reduced: the primary person only.
  wristROIs: number;
}

const plan = (analysisFPS: number, landmarkFaces: number, landmarkMaxDistance: number, handPose: boolean,
  maxHands: number, handMaxDistance: number, bodyPose: boolean, motionEvery: number, maxPeople: number,
  rectanglesOnly: boolean, gesturesPrimaryOnly: boolean): StagePlan => ({
  analysisFPS, landmarkFaces, landmarkMaxDistance, handPose, maxHands, handMaxDistance, bodyPose, motionEvery, maxPeople,
  rectanglesOnly, gesturesPrimaryOnly, wristROIs: 0,
});

export const StagePlan = {
  plan(tier: PerceptionTier): StagePlan {
    const p = StagePlan.basePlan(tier);
    p.wristROIs = tier === PerceptionTier.full ? 2 : (tier === PerceptionTier.critical ? 0 : 1);
    return p;
  },

  basePlan(tier: PerceptionTier): StagePlan {
    switch (tier) {
      case 3: return plan(30, 3, 2.5, true, 4, 3, true, 1, 6, false, false);
      case 2: return plan(15, 2, 2.5, true, 2, 3, true, 1, 4, false, false);
      case 1: return plan(10, 1, 2.5, true, 1, 2, false, 2, 2, false, true);
      case 0: return plan(5, 1, 2.5, false, 0, 0, false, 0, 2, false, true);
    }
  },

  /// Room empty (awake, nobody seen for `VacancyScheduler.after`): human and face rectangles plus the motion map at
  /// 5 fps; no landmarks, hands or body pose. A fresh copy per read.
  get vacant(): StagePlan { return plan(5, 0, 0, false, 0, 0, false, 1, 2, false, true); },

  /// Low mode (asleep): human rectangles at 4 fps, 10 fps for `LowModeScheduler.boostSeconds` after a candidate.
  low: (boosted: boolean): StagePlan => plan(boosted ? 10 : 4, 0, 0, false, 0, 0, false, 0, 2, true, true),

  /// One line for the HUD and the soak log. Swift: the `summary` extension in HarnessTiming.swift.
  summary(p: StagePlan): string {
    if (p.rectanglesOnly) return `${p.analysisFPS.toFixed(0)} fps · rects only`;
    const s = [`${p.analysisFPS.toFixed(0)} fps`, `landmarks ×${p.landmarkFaces}`];
    s.push(p.handPose ? `hands ×${p.maxHands}` : 'no hands');
    s.push(p.bodyPose ? 'body' : 'no body');
    s.push(p.motionEvery > 0 ? `motion /${p.motionEvery}` : 'no motion');
    if (p.gesturesPrimaryOnly) s.push('primary only');
    return s.join(' · ');
  },

  equals: (a: StagePlan, b: StagePlan): boolean =>
    (Object.keys(a) as (keyof StagePlan)[]).every((k) => a[k] === b[k]),
};

/// The starting tier from the hardware class (no fixture benchmark); the run-time adapter then measures live.
export const HardwareClass = {
  /// `hw.machine` → starting tier. Macs and M-series / A17 Pro iPads start at full, A14–A16 at standard, older at
  /// reduced.
  startingTier(machine: string): PerceptionTier {
    if (!machine.startsWith('iPad')) return PerceptionTier.full;   // Mac (arm64 / x86_64 identifiers), simulator host
    const parts = machine.slice(4).split(',').filter((s) => s.length > 0);
    const int = (s: string | undefined): number | null => s !== undefined && /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
    const major = int(parts[0]);
    if (major === null) return PerceptionTier.standard;
    const minor = parts.length > 1 ? int(parts[1]) ?? 0 : 0;
    if (major >= 16) return PerceptionTier.full;                           // M4/M5 Pro, A17 Pro mini, M3 Air and later
    switch (major) {
      case 14: return minor <= 2 ? PerceptionTier.standard : PerceptionTier.full;   // M2 Pro/Air; A15 mini (14,1–2)
      case 15: return minor >= 7 ? PerceptionTier.standard : PerceptionTier.full;   // A16 iPad (15,7–8); M3 Air
      case 13:                                                                     // A14 Air, M1 Pro/Air, A14 iPad
        if ((minor >= 4 && minor <= 11) || (minor >= 16 && minor <= 17)) return PerceptionTier.full;
        return PerceptionTier.standard;
      case 12: return PerceptionTier.standard;                                     // A13 iPad 9
      default: return PerceptionTier.reduced;
    }
  },
} as const;

/// Thermal / pressure level: the worst of the thermal state, the camera's system pressure and Low Power Mode.
export type PressureLevel = 0 | 1 | 2 | 3 | 4;
export const PressureLevel = {
  nominal: 0 as PressureLevel, fair: 1 as PressureLevel, serious: 2 as PressureLevel, critical: 3 as PressureLevel,
  shutdown: 4 as PressureLevel,
  label: (p: PressureLevel): string => (['nominal', 'fair', 'serious', 'critical', 'shutdown'] as const)[p],
} as const;

export interface TierPolicyMeasurement {
  /// 90th-percentile pipeline time per analysed frame (ms) over the interval.
  p90Ms: number;
  /// Fraction of frames that arrived while the previous one was still in flight (dropped late).
  lateFraction: number;
  /// Fraction of display frames over budget while perception runs.
  displayDropRate: number;
  pressure: PressureLevel;
  /// The room-empty plan ran during the interval: its cheap frames never count as headroom.
  vacant: boolean;
}

export type TierPolicyDecision =
  | { kind: 'keep' }
  | { kind: 'change'; to: PerceptionTier; reason: string }
  /** Pause perception for `probeSeconds` and report the display drop rate (renderer-bound check). */
  | { kind: 'requestProbe' }
  | { kind: 'stopCamera'; reason: string };

/// Run-time tier adaptation, evaluated every `interval` seconds. Pure; the app feeds it measurements.
export class TierPolicy {
  /// Swift `TierPolicy.Measurement(p90Ms:lateFraction:displayDropRate:pressure:vacant:)`.
  static measurement(p90Ms: number, o: Partial<Omit<TierPolicyMeasurement, 'p90Ms'>> = {}): TierPolicyMeasurement {
    return { p90Ms, lateFraction: 0, displayDropRate: 0, pressure: PressureLevel.nominal, vacant: false, ...o };
  }

  static readonly interval = 5;
  static readonly probeSeconds = 2;
  static readonly budgetFraction = 0.6;
  static readonly headroomFraction = 0.4;
  static readonly headroomSeconds = 60;
  static readonly lateLimit = 0.10;
  static readonly displayDropLimit = 0.02;

  /// The hardware tier: never exceeded.
  readonly ceiling: PerceptionTier;
  adapted: PerceptionTier;
  current: PerceptionTier;
  override: PerceptionTier | null;
  headroomFor = 0;
  probeResult: number | null = null;
  probeAt = -Infinity;
  rendererBound = false;

  constructor(ceiling: PerceptionTier, override: PerceptionTier | null = null) {
    this.ceiling = ceiling;
    this.adapted = ceiling;
    this.override = override;
    this.current = override !== null ? Math.min(override, ceiling) as PerceptionTier : ceiling;
  }

  /// The tier cap for a pressure level.
  static cap(p: PressureLevel, ceiling: PerceptionTier): PerceptionTier {
    switch (p) {
      case 0: return ceiling;
      case 1: return Math.max(ceiling - 1, PerceptionTier.critical) as PerceptionTier;
      case 2: return Math.min(ceiling, PerceptionTier.reduced) as PerceptionTier;
      case 3: case 4: return PerceptionTier.critical;
    }
  }

  /// Records the display drop rate measured while perception was paused.
  noteProbe(displayDropRate: number, time: number): void {
    this.probeResult = displayDropRate;
    this.probeAt = time;
  }

  evaluate(m: TierPolicyMeasurement, now: number): TierPolicyDecision {
    const T = TierPolicy;
    if (m.pressure === PressureLevel.shutdown) return { kind: 'stopCamera', reason: 'capture shutdown pressure' };
    const interval = 1 / StagePlan.plan(this.current).analysisFPS * 1000;
    let reason: string | null = null;
    if (m.p90Ms > T.budgetFraction * interval) reason = `p90 ${m.p90Ms.toFixed(0)} ms over budget`;
    else if (m.lateFraction > T.lateLimit) reason = `${(m.lateFraction * 100).toFixed(0)}% frames late`;
    else if (m.displayDropRate > T.displayDropLimit) {
      // The eyes win, but only if perception is what costs them frames.
      const probe = this.probeResult;
      if (probe !== null && now - this.probeAt < 60) {
        if (m.displayDropRate > probe + T.displayDropLimit / 2) {
          reason = `display drops ${(m.displayDropRate * 100).toFixed(1)}% (paused ${(probe * 100).toFixed(1)}%)`;
          this.rendererBound = false;
        } else {
          this.rendererBound = true;
        }
      } else {
        return { kind: 'requestProbe' };
      }
    }
    if (reason !== null && this.adapted > PerceptionTier.critical) {
      this.adapted = (this.adapted - 1) as PerceptionTier;
      this.headroomFor = 0;
      return this.apply(m, reason);
    }
    const headroom = !m.vacant && m.p90Ms <= T.headroomFraction * interval && m.lateFraction === 0 &&
      m.displayDropRate <= T.displayDropLimit;
    this.headroomFor = headroom ? this.headroomFor + T.interval : 0;
    if (this.headroomFor >= T.headroomSeconds && this.adapted < this.ceiling) {
      this.adapted = (this.adapted + 1) as PerceptionTier;
      this.headroomFor = 0;
      return this.apply(m, '60 s of headroom');
    }
    return this.apply(m, `thermal ${PressureLevel.label(m.pressure)}`);
  }

  private apply(m: TierPolicyMeasurement, reason: string): TierPolicyDecision {
    let t = Math.min(this.adapted, TierPolicy.cap(m.pressure, this.ceiling)) as PerceptionTier;
    if (this.override !== null) t = Math.min(this.override, this.ceiling) as PerceptionTier;
    if (t === this.current) return { kind: 'keep' };
    this.current = t;
    return { kind: 'change', to: t, reason };
  }
}

/// Low-mode frame pacing: 4 fps, 10 fps for 3 s after a candidate detection.
export class LowModeScheduler {
  static readonly boostSeconds = 3;
  boostUntil = -Infinity;
  noteCandidate(t: number): void { this.boostUntil = t + LowModeScheduler.boostSeconds; }
  isBoosted(t: number): boolean { return t < this.boostUntil; }
  plan(t: number): StagePlan { return StagePlan.low(this.isBoosted(t)); }
}

/// Room-empty duty cycle while awake: after `after` seconds with no human rectangle, face, tracked person or motion
/// event, perception drops to `StagePlan.vacant` (and capture to `captureFPS`); the first detection ends it. Under
/// pressure the room counts as empty sooner.
export class VacancyScheduler {
  static readonly defaultAfter = 10;
  static readonly pressuredAfter = 5;
  /// Camera capture rate while vacant (the gate then takes `StagePlan.vacant.analysisFPS` of these).
  static readonly captureFPS = 15;
  after = VacancyScheduler.defaultAfter;
  lastPresence: number | null = null;

  copy(): VacancyScheduler { const v = new VacancyScheduler(); v.after = this.after; v.lastPresence = this.lastPresence; return v; }
  equals(o: VacancyScheduler): boolean { return this.after === o.after && this.lastPresence === o.lastPresence; }

  /// The room-empty delay for a pressure level (the static and the instance `after` share the Swift name).
  static after(p: PressureLevel): number { return p >= PressureLevel.fair ? VacancyScheduler.pressuredAfter : VacancyScheduler.defaultAfter; }

  /// Feeds one analysed frame (the first frame starts the clock, as if someone had just left).
  note(present: boolean, t: number): void {
    if (present || this.lastPresence === null) this.lastPresence = t;
  }

  isVacant(t: number): boolean { return this.lastPresence !== null ? t - this.lastPresence >= this.after : false; }
  reset(): void { this.lastPresence = null; }
}

/// Drops frames to the plan's analysis rate before any work, and while one is in flight.
export class FrameGate {
  lastAccepted = -Infinity;
  accepted = 0;
  dropped = 0;
  droppedBusy = 0;

  /// Whether to analyse a frame captured at `time` given the analysis rate and whether one is in flight.
  shouldAnalyse(time: number, fps: number, inFlight: boolean): boolean {
    if (inFlight) { this.droppedBusy += 1; this.dropped += 1; return false; }
    const minInterval = 1 / Math.max(fps, 0.5) - 0.004;   // a little slack for capture jitter
    if (!(time - this.lastAccepted >= minInterval)) { this.dropped += 1; return false; }
    this.lastAccepted = time;
    this.accepted += 1;
    return true;
  }

  resetCounters(): void { this.accepted = 0; this.dropped = 0; this.droppedBusy = 0; }
}
