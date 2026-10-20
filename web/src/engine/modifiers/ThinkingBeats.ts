// Port of FaceEngine/Modifiers/ThinkingBeats.swift.
import type { V2 } from '../../core/vec';
import type { Mood } from '../AgentState';
import { OneShotOutput, type FaceState } from '../FaceState';
import { gazeClamp, gazeLength } from '../GazeSupport';
import { Phase, type Modifier } from '../Modifier';
import { OneShotKindSet, OneShotRequest, isPupilShape, makeOneShotCancel } from '../OneShots';
import { shapeDuration } from '../PupilShapeCurves';
import { BeatPose, ThinkingBeatCurves } from './ThinkingBeatCurves';

/// A small, human, funny thing Yanni does while thinking (thinking beats design §3).
export type ThinkingBeat =
  | 'ponder' | 'slowBlink' | 'scan' | 'browRaise' | 'chew' | 'lightbulb' | 'drum' | 'eyeRoll' | 'crossEyed'
  | 'question' | 'peek';

const BEATS: readonly ThinkingBeat[] = [
  'ponder', 'slowBlink', 'scan', 'browRaise', 'chew', 'lightbulb', 'drum', 'eyeRoll', 'crossEyed', 'question', 'peek',
];

export const ThinkingBeat = {
  allCases: BEATS,
  /// Base duration in seconds (the question mark's is its pupil transformation's).
  duration(b: ThinkingBeat): number {
    switch (b) {
      case 'ponder': return 1.3;
      case 'slowBlink': return 0.95;
      case 'scan': return 1.9;
      case 'browRaise': return 1.6;
      case 'chew': return 2.2;
      case 'lightbulb': return 1.7;
      case 'drum': return 1.7;
      case 'eyeRoll': return 1.7;
      case 'crossEyed': return 1.15;
      case 'question': return shapeDuration('questionEyes', ThinkingBeats.questionHold);
      case 'peek': return 1.6;
    }
  },
  /// The escalation band it belongs to: 0 (0–1 s), 1 (1–3 s), 2 (3–6 s), 3 (6 s and on).
  belongs(b: ThinkingBeat, band: number): boolean {
    switch (b) {
      case 'ponder': case 'slowBlink': return band === 0;
      case 'browRaise': case 'chew': case 'lightbulb': return band === 1;
      case 'scan': return band === 1 || band === 3;
      case 'drum': case 'eyeRoll': case 'crossEyed': case 'question': return band === 2;
      case 'peek': return band === 2 || band === 3;
    }
  },
  /// Reduce Motion keeps only these (no fast saccades, convergence or bounces).
  isGentle: (b: ThinkingBeat): boolean => b === 'ponder' || b === 'slowBlink',
  /// Sleepy or sad moods and a bedtime night wake keep only these.
  isCalm: (b: ThinkingBeat): boolean => ThinkingBeat.isGentle(b) || b === 'chew' || b === 'browRaise' || b === 'peek',
  /// Weighted by liveliness (playful, high-arousal moods pick them more).
  isFunny: (b: ThinkingBeat): boolean =>
    b === 'lightbulb' || b === 'drum' || b === 'eyeRoll' || b === 'crossEyed' || b === 'question',
} as const;

export interface ThinkingBeatParams {
  side: number;
  /// Pose, lids, brows (Reduce Motion halves it).
  amp: number;
  /// Gaze travel (never scaled by Reduce Motion).
  gazeAmp: number;
  tempo: number;
  smile: number;
}
const makeParams = (): ThinkingBeatParams => ({ side: 1, amp: 1, gazeAmp: 1, tempo: 1, smile: 0 });

// f32: Swift keeps beat time, durations and the drawn delays as Float; they tie with the 1/60 s frame grid.
const f32 = Math.fround;

const questionSet = OneShotKindSet.of(['questionEyes']);

/// Attention phase, between Attention and GazeTracking: the thinking beats (thinking beats design). While thinking, a
/// scheduler plays one beat at a time over the thinking look, escalating with the time spent thinking, never the same
/// beat twice in a row, spaced by lognormal gaps; randomness only when a beat is scheduled or starts. A beat adds to
/// the frame's one-shot output and offsets the gaze target (steps as saccades, paths as pursuit; never while a
/// one-shot owns the gaze). Leaving thinking fades the beat over `releaseDuration`; thinking → speaking adds "aha!".
export class ThinkingBeats implements Modifier {
  readonly name = 'ThinkingBeats';
  readonly phase = Phase.attention;
  isEnabled = true;

  // MARK: Tunables

  /// First beat: uniform in this window after thinking starts.
  static readonly firstDelay = [0.15, 0.4] as const;
  /// Escalation band edges (seconds of thinking).
  static readonly bandEdges = { x: 1, y: 3, z: 6 } as const;
  /// Gap after a beat per band (lognormal median, seconds; sigma `gapSigma`, clamped to 0.5…2.5 × the median).
  static readonly gapMedians: readonly number[] = [0.35, 0.55, 0.8, 2.4];
  static readonly gapSigma = 0.4;
  /// Gap multiplier and amplitude multiplier for calm (sleepy, sad, bedtime).
  static readonly calmGapScale = 1.6;
  static readonly calmAmplitude = 0.8;
  /// Retry delay when another one-shot is playing.
  static readonly busyRetry = 0.4;
  /// Fade when a beat is cut (state change, manual replace).
  static readonly releaseDuration = 0.12;
  /// The question mark's hold and intensity.
  static readonly questionHold = 0.9;
  static readonly questionIntensity = 0.85;
  /// The "aha!" perk's intensity (× the mood amplitude).
  static readonly ahaIntensity = 1.05;
  /// The "still working" scan is this much slower.
  static readonly slowScanTempo = 0.75;
  /// Governor rate per resource level 0…4 (gaps ÷ rate).
  static governorRate(level: number): number { return level >= 3 ? 0.35 : (level === 2 ? 0.6 : 1); }

  /// The resource governor's rate (0.2…1): gaps are divided by it.
  private _rate = 1;
  get rate(): number { return this._rate; }
  set rate(v: number) { this._rate = Number.isFinite(v) ? Math.min(Math.max(v, 0.2), 1) : 1; }

  // MARK: Read-outs (tests, Tune)

  current: ThinkingBeat | null = null;
  /// Seconds of thinking when the current (or last) beat started.
  currentStartedAfter = 0;
  lastBeat: ThinkingBeat | null = null;
  /// This frame's contribution (zero when no beat plays) and gaze offset.
  lastOutput = new OneShotOutput();
  lastGazeOffset: V2 = { x: 0, y: 0 };

  // MARK: State

  private wasThinking = false;
  private enteredAt = 0;
  private nextAt = Infinity;
  private beatT = 0;
  private p: ThinkingBeatParams = makeParams();
  private releasedAt: number | null = null;
  private questionUsed = false;
  private questionUntil = -Infinity;
  private lastDiscrete: V2 = { x: 0, y: 0 };
  private pending: ThinkingBeat | null = null;

  /// Plays `beat` on the next frame while thinking (Tune buttons), cutting the one playing.
  play(beat: ThinkingBeat): void { this.pending = beat; }

  update(s: FaceState): void {
    const thinking = s.agentState === 'thinking';
    if (thinking !== this.wasThinking) {
      if (thinking) this.enter(s); else this.leave(s);
      this.wasThinking = thinking;
    }
    if (thinking) this.schedule(s);
    this.apply(s);
  }

  // MARK: Scheduling

  private enter(s: FaceState): void {
    this.enteredAt = s.time;
    this.lastBeat = null;
    this.questionUsed = false;
    this.current = null;
    this.releasedAt = null;
    this.nextAt = s.time + f32(s.rng.uniform(ThinkingBeats.firstDelay[0], ThinkingBeats.firstDelay[1]));
  }

  private leave(s: FaceState): void {
    this.nextAt = Infinity;
    this.pending = null;
    if (this.current !== null && this.releasedAt === null) this.releasedAt = s.time;
    if (s.time < this.questionUntil) {
      s.oneShotCancels.push(makeOneShotCancel(questionSet));
      this.questionUntil = -Infinity;
    }
    if (s.previousAgentState === 'thinking' && s.agentState === 'speaking' && this.isEnabled) {
      s.oneShotPlayRequests.push(OneShotRequest.make('perkUp', { intensity: ThinkingBeats.ahaIntensity * this.moodAmplitude(s) }));
    }
  }

  private schedule(s: FaceState): void {
    // Someone else's pupil transformation (the appraisal's reaction cue) is this turn's shape: no question mark.
    if (s.time >= this.questionUntil && s.activeOneShots.some(isPupilShape)) this.questionUsed = true;
    const elapsed = s.time - this.enteredAt;
    const b0 = this.pending;
    if (b0 !== null) {
      // A manual beat waits for the playing one to fade out (no pop).
      if (this.current !== null) {
        if (this.releasedAt === null) this.releasedAt = s.time;
        return;
      }
      this.pending = null;
      this.start(b0, elapsed, s);
      return;
    }
    if (this.current !== null || !(s.time >= this.nextAt)) return;
    if (s.activeOneShots.length > 0) {
      this.nextAt = s.time + ThinkingBeats.busyRetry;
      return;
    }
    const b = this.pick(ThinkingBeats.band(elapsed), s);
    if (b === null) {
      this.nextAt = s.time + 1;
      return;
    }
    this.start(b, elapsed, s);
  }

  /// Escalation band for seconds of thinking.
  static band(elapsed: number): number {
    const e = f32(elapsed), E = ThinkingBeats.bandEdges;
    return e < E.x ? 0 : (e < E.y ? 1 : (e < E.z ? 2 : 3));
  }

  private allowed(b: ThinkingBeat, s: FaceState): boolean {
    if (s.reduceMotion && !ThinkingBeat.isGentle(b)) return false;
    if (ThinkingBeats.isCalm(s) && !ThinkingBeat.isCalm(b)) return false;
    if (b === 'question' && (this.questionUsed || !s.pupilSettings.enabled || s.isBedtime)) return false;
    return true;
  }

  /// Weighted pick from the band (no allocation), never the last beat; falls back to the gentle pair.
  private pick(band: number, s: FaceState): ThinkingBeat | null {
    const live = ThinkingBeats.liveliness(s.mood);
    let total = 0;
    for (let pass = 0; pass < 2; pass++) {
      const ok = (b: ThinkingBeat): boolean => b !== this.lastBeat && this.allowed(b, s)
        && (pass === 0 ? ThinkingBeat.belongs(b, band) : ThinkingBeat.isGentle(b));
      for (const b of BEATS) if (ok(b)) total += ThinkingBeat.isFunny(b) ? live : 1;
      if (!(total > 0)) continue;
      let x = s.rng.unit() * total;
      let last: ThinkingBeat | null = null;
      for (const b of BEATS) {
        if (!ok(b)) continue;
        x -= ThinkingBeat.isFunny(b) ? live : 1;
        last = b;
        if (x < 0) return b;
      }
      return last;
    }
    return null;
  }

  private start(b: ThinkingBeat, elapsed: number, s: FaceState): void {
    this.current = b;
    this.lastBeat = b;
    this.currentStartedAfter = elapsed;
    this.beatT = 0;
    this.releasedAt = null;
    const calm = ThinkingBeats.isCalm(s);
    const p = makeParams();
    p.side = s.gazeTarget.point.x >= 0 ? 1 : -1;
    p.gazeAmp = this.moodAmplitude(s);
    p.amp = p.gazeAmp * s.motionScale;
    const band = ThinkingBeats.band(elapsed);
    p.tempo = (b === 'scan' && band === 3) ? ThinkingBeats.slowScanTempo : (calm ? 0.85 : 1);
    p.smile = band === 3 ? 1 : 0;
    this.p = p;
    if (b === 'question') {
      this.questionUsed = true;
      this.questionUntil = s.time + f32(ThinkingBeat.duration(b));
      s.oneShotPlayRequests.push(OneShotRequest.make('questionEyes', {
        hold: ThinkingBeats.questionHold, leadEye: p.side, intensity: ThinkingBeats.questionIntensity,
        reduceMotion: s.reduceMotion, softVoice: true,
      }));
    }
  }

  private finish(s: FaceState): void {
    this.current = null;
    this.releasedAt = null;
    if (!this.wasThinking) return;
    const band = ThinkingBeats.band(s.time - this.enteredAt);
    const median = ThinkingBeats.gapMedians[band] * (ThinkingBeats.isCalm(s) ? ThinkingBeats.calmGapScale : 1)
      / Math.max(ThinkingBeats.liveliness(s.mood) * this._rate, 0.2);
    this.nextAt = s.time + f32(s.rng.lognormal(median, ThinkingBeats.gapSigma, [f32(median * 0.5), f32(median * 2.5)]));
  }

  // MARK: Mood

  /// 0.5…1.5: how lively the beats are.
  static liveliness(m: Mood): number {
    const l = 1 + 0.6 * m.arousal + 0.4 * m.pleasure;
    return Number.isFinite(l) ? Math.min(Math.max(l, 0.5), 1.5) : 1;
  }

  static isCalm(s: FaceState): boolean { return s.isBedtime || s.mood.arousal < -0.3 || s.mood.pleasure < -0.3; }

  private moodAmplitude(s: FaceState): number {
    return Math.min(Math.max(0.8 + 0.2 * ThinkingBeats.liveliness(s.mood), 0.85), 1.1) * (ThinkingBeats.isCalm(s) ? ThinkingBeats.calmAmplitude : 1);
  }

  // MARK: Output

  private apply(s: FaceState): void {
    this.lastOutput = new OneShotOutput();
    this.lastGazeOffset = { x: 0, y: 0 };
    const b = this.current;
    if (b === null) { this.lastDiscrete = { x: 0, y: 0 }; return; }
    let gain = 1;
    if (this.releasedAt !== null) {
      gain = f32(1 - f32(s.time - this.releasedAt) / f32(ThinkingBeats.releaseDuration));
      if (gain <= 0) { this.finish(s); this.lastDiscrete = { x: 0, y: 0 }; return; }
    } else {
      this.beatT = f32(this.beatT + f32(s.dt * f32(this.p.tempo)));
      if (this.beatT >= f32(ThinkingBeat.duration(b))) { this.finish(s); this.lastDiscrete = { x: 0, y: 0 }; return; }
    }
    const pose = new BeatPose();
    const id = s.primaryPersonID;
    const person = (id === null ? undefined : s.people.find((q) => q.id === id))?.position ?? { x: 0, y: 0.05 };
    ThinkingBeatCurves.sample(b, this.beatT, this.p, s.gazeTarget.point, person, pose);

    const o = pose.o;
    if (gain < 1) scaleOutput(o, gain);
    addOutput(s.oneShot, o);
    this.lastOutput = o;

    // The gaze: dropped at once on release (GazeTracking's springs carry it home), never over a one-shot's gaze.
    if (this.releasedAt !== null || s.oneShot.gaze !== null) { this.lastDiscrete = { x: 0, y: 0 }; return; }
    const g0 = s.gazeTarget;
    const t = { ...g0, point: gazeClamp({ x: g0.point.x + pose.gaze.x, y: g0.point.y + pose.gaze.y }), velocity: { ...g0.velocity } };
    if (pose.continuous) {
      t.mode = 'smooth';
    } else if (gazeLength({ x: pose.gaze.x - this.lastDiscrete.x, y: pose.gaze.y - this.lastDiscrete.y }) > 1e-4) {
      t.mode = 'saccade';
    }
    if (pose.contact) t.contact = true;
    this.lastDiscrete = pose.continuous ? { x: 0, y: 0 } : { ...pose.gaze };
    this.lastGazeOffset = { x: t.point.x - g0.point.x, y: t.point.y - g0.point.y };
    s.gazeTarget = t;
  }
}

/// Fades a beat's output toward identity by `gain` (in place).
export function scaleOutput(o: OneShotOutput, gain: number): void {
  const d = o.delta.raw;
  for (let i = 0; i < d.length; i++) d[i] *= gain;
  const l = o.lidCoverage;
  o.lidCoverage = { x: l.x * gain, y: l.y * gain, z: l.z * gain, w: l.w * gain };
  const b = o.browDelta.raw;
  for (let i = 0; i < b.length; i++) b[i] *= gain;
  o.blink *= gain;
  o.faceScaleMul = { x: 1 + (o.faceScaleMul.x - 1) * gain, y: 1 + (o.faceScaleMul.y - 1) * gain };
  const e = o.eyeScaleMul;
  o.eyeScaleMul = { x: 1 + (e.x - 1) * gain, y: 1 + (e.y - 1) * gain, z: 1 + (e.z - 1) * gain, w: 1 + (e.w - 1) * gain };
  o.pupilSizeMul = { x: 1 + (o.pupilSizeMul.x - 1) * gain, y: 1 + (o.pupilSizeMul.y - 1) * gain };
}

/// Folds a beat's output into the frame's one-shot output (delta, lids, brows, blink, scales, pupil size).
export function addOutput(dst: OneShotOutput, o: OneShotOutput): void {
  dst.delta.addInPlace(o.delta);
  const l = dst.lidCoverage, ol = o.lidCoverage;
  dst.lidCoverage = { x: l.x + ol.x, y: l.y + ol.y, z: l.z + ol.z, w: l.w + ol.w };
  const b = dst.browDelta.raw, ob = o.browDelta.raw;
  for (let i = 0; i < b.length; i++) b[i] += ob[i];
  dst.blink = o.blink >= dst.blink ? o.blink : dst.blink; // Swift max(dst.blink, o.blink)
  dst.faceScaleMul = { x: dst.faceScaleMul.x * o.faceScaleMul.x, y: dst.faceScaleMul.y * o.faceScaleMul.y };
  const e = dst.eyeScaleMul, oe = o.eyeScaleMul;
  dst.eyeScaleMul = { x: e.x * oe.x, y: e.y * oe.y, z: e.z * oe.z, w: e.w * oe.w };
  dst.pupilSizeMul = { x: dst.pupilSizeMul.x * o.pupilSizeMul.x, y: dst.pupilSizeMul.y * o.pupilSizeMul.y };
}
