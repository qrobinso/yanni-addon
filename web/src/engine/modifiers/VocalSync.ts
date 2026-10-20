// Port of FaceEngine/Modifiers/VocalSync.swift.
import { ParamLayout, Units, VocalContour } from '../../model';
import type { VocalCue } from '../Commands';
import { Ease } from '../Easing';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { OneShotChannels, OneShotLibrary, isPupilShape } from '../OneShots';
import { SpringParams } from '../Spring';

/// Tracks the presentation host clock across frames: the engine's effective time scale (engine dt per host second) and
/// the display's frame period. A frame whose dt hit the engine's clamp (a hiccup) keeps the previous time-scale
/// estimate, so a long frame never reads as slow motion. Allocation-free.
export class HostClockEstimator {
  /// Same value as `FaceEngine.maxDt`.
  static readonly maxDt = 0.05;
  /// Engine seconds per host second (FaceEngine.timeScale), 0.01…1. 1 until measured.
  private _timeScale = 1;
  /// Last unclamped host frame period (seconds).
  private _framePeriod = 1.0 / 60.0;
  private lastHost: number | null = null;

  get timeScale(): number { return this._timeScale; }
  get framePeriod(): number { return this._framePeriod; }

  update(hostTime: number | null, dt: number): void {
    if (hostTime === null || !Number.isFinite(hostTime)) { this.lastHost = null; return; }
    const h = hostTime;
    if (this.lastHost !== null) {
      const hd = h - this.lastHost;
      if (hd > 1e-5 && dt > 0 && dt < HostClockEstimator.maxDt * 0.999) {
        this._timeScale = Math.min(Math.max(dt / hd, 0.01), 1);
        if (hd < HostClockEstimator.maxDt) this._framePeriod = hd;
      }
    }
    this.lastHost = h;
  }
}

/// Live values of VocalSync's channels (tests and debug UI).
export interface VocalSyncReadout {
  /// Vocal energy (≈0…1): face scale +2 %·energy, brightness +4 %·energy.
  energy: number;
  /// Discrete hop, canvas units (negative = up).
  hop: number;
  /// Onset squash depth (face scaleY × (1 − squash)).
  squash: number;
  /// Pitch follow, semitones relative to the phrase's first note.
  pitch: number;
  /// Lower-lid squint coverage.
  squint: number;
  /// Widen amount 0…1.
  widen: number;
  /// Sleepy lid-close contribution.
  sleepyClose: number;
  /// Horizontal tremble, canvas units.
  wobble: number;
}

type SlotPhase = 'free' | 'pending' | 'active';

const emptyCue = (): VocalCue => ({
  hostTime: 0, duration: 0, contour: VocalContour.flat(0), intensity: 0, articulation: 0, valence: 0, kind: 'plain', accent: false,
});

class Slot {
  phase: SlotPhase = 'free';
  cue: VocalCue = emptyCue();
  duration = 0;
  intensity = 0;
  attack = 0.02;
  /// Note-local time at the end of this frame (engine seconds; negative before the face onset).
  tau = 0;
  hop = 0;
  squash = 0;
  phraseRef = 0;
  squintGate = 0;
  widenGate = 0;
  startleGate = 0;
  sleepyGate = 0;
  wobble = false;
  fading = false;
  /// Cancel fade time left at the end of this frame.
  fadeRemaining = 0;
  get end(): number { return Math.max(this.duration + VocalSync.releaseTime, VocalSync.hopWidth); }
}

const CENTER_X = ParamLayout.index('centerX'), CENTER_Y = ParamLayout.index('centerY');

/// Motion phase (after OneShotApply): the face reacts to the voice's notes (design §10, review H5/C3/M8).
///
/// **Timing.** `.vocalCue` commands go into a fixed queue of 16 (when full the newest cue is dropped). A cue becomes
/// active on the first frame whose `presentationHostTime ≥ cue.hostTime − visualLead`. Its note-local time is then
/// `(frameHost − faceOnset) · timeScale` and advances by engine `dt`; it is re-synced to host time whenever they drift
/// more than 20 ms apart. Springs are integrated in substeps on a fixed 1/240 s grid with linearly ramped targets,
/// solved exactly, so 60 and 120 fps produce the same motion. Without host time a virtual host clock
/// `engineTime + offset` is used.
///
/// **Channels:** vocal energy → face scale +2 %, brightness +4 %; discrete hops with an onset squash (×0.3 when the
/// paired one-shot owns translate); pitch follow (eye scaleY, face centre); squint for positive-valence notes; widen
/// for startle / curious; startle shrinks the pupils; sleepy notes pull lidClose; wobble tremble.
/// `.cancelVocalCues(fromHostTime:)` drops queued cues at/after that time and fades active ones over 80 ms.
export class VocalSync implements Modifier {
  readonly name = 'VocalSync';
  readonly phase = Phase.motion;
  isEnabled = true;

  static readonly capacity = 16;
  /// The face leads the audible onset by this much (seconds).
  static readonly visualLead = 0.010;
  /// Spring substep grid (seconds); 60 and 120 fps frames both land on it.
  static readonly substep = 1.0 / 240.0;
  /// Re-sync a cue's note time to host time when they disagree by more than this (seconds).
  static readonly resyncThreshold = 0.02;

  static readonly releaseTime = 0.08;
  static readonly attackSlow = 0.030;
  static readonly attackFast = 0.008;

  static readonly energySpring = new SpringParams(2 * Math.PI * 6, 0.5);
  static readonly energyFaceScale = 0.02;
  static readonly energyBrightness = 0.04;

  static readonly hopBase = 0.5;
  static readonly hopPerIntensity = 1.0;
  static readonly hopMinInterOnset = 0.18;
  static readonly hopMinInterval = 0.2;
  static readonly pairedTranslateSoftening = 0.3;
  static readonly hopSpring = new SpringParams(2 * Math.PI * 4.5, 0.4);
  static readonly hopWidth = 0.14;
  static readonly hopGain = 1.08;
  static readonly squashDepth = 0.03;
  static readonly squashWidth = 0.09;
  static readonly squashSpring = new SpringParams(45, 0.7);

  static readonly pitchSpring = new SpringParams(25, 0.85);
  static readonly pitchEyeScalePer12 = 0.015;
  static readonly pitchFaceYPer12 = -0.6;
  static readonly pitchRange: readonly [number, number] = [-12, 18];
  /// A cue starts a new phrase when nothing is sounding and this long has passed since the last note ended.
  static readonly phraseGap = 0.25;

  static readonly squintMax = 0.15;
  static readonly squintLow = 4;
  static readonly squintHigh = 10;
  static readonly squintSpring = new SpringParams(18, 1);
  static readonly widenScale = 0.04;
  static readonly widenUpperLid = -0.1;
  static readonly widenSpring = new SpringParams(28, 0.55);
  static readonly startlePupilMul = 0.85;
  static readonly startleSpring = new SpringParams(24, 0.9);
  static readonly sleepyMaxClose = 0.35;
  static readonly sleepySlope = -15;
  static readonly sleepyFullDrop = 8;
  static readonly sleepySpring = new SpringParams(12, 1);
  static readonly wobbleAmplitude = 0.3;

  static readonly cancelFade = 0.08;

  private slots: Slot[] = Array.from({ length: VocalSync.capacity }, () => new Slot());
  private clock = new HostClockEstimator();
  private virtualOffset: number | null = null;
  private lastOnsetHost = -Infinity;
  private lastHopHost = -Infinity;
  private lastCueEndHost = -Infinity;
  private phraseRef = 0;

  /// Spring lanes: energy, hop, squash, pitch, squint, widen, sleepy (lane 7 = wobble, unsprung).
  private value = new Float64Array(8);
  private velocity = new Float64Array(8);
  private prevTarget = new Float64Array(8);
  private target = new Float64Array(8);
  private startle = 0;
  private startleVelocity = 0;
  private startlePrev = 0;

  /// Total cues activated so far.
  activations = 0;
  /// Total discrete hops started.
  hopCount = 0;
  /// Total cues dropped because the queue was full.
  dropped = 0;

  get pendingCueCount(): number { return this.slots.reduce((n, sl) => n + (sl.phase === 'pending' ? 1 : 0), 0); }
  get activeCueCount(): number { return this.slots.reduce((n, sl) => n + (sl.phase === 'active' ? 1 : 0), 0); }

  get readout(): VocalSyncReadout {
    const v = this.value;
    return { energy: v[0], hop: v[1], squash: v[2], pitch: v[3], squint: v[4], widen: v[5], sleepyClose: v[6], wobble: v[7] };
  }

  update(s: FaceState): void {
    const dt = Math.max(s.dt, 0);
    this.clock.update(s.presentationHostTime, s.dt);

    // 1. Commands (in order).
    for (const c of s.commands) {
      if (c.kind === 'vocalCue') this.enqueue(c.cue);
      else if (c.kind === 'cancelVocalCues') this.cancel(c.fromHostTime);
    }

    // 2. Host clock for this frame.
    let ratio: number;
    let hostNow: number | null;
    const ph = s.presentationHostTime;
    if (ph !== null && Number.isFinite(ph)) {
      this.virtualOffset = null;
      hostNow = ph;
      ratio = this.clock.timeScale;
    } else {
      if (this.virtualOffset === null) {
        const first = this.earliestPending();
        if (first !== null) this.virtualOffset = first - s.time;
      }
      hostNow = this.virtualOffset === null ? null : s.time + this.virtualOffset;
      ratio = 1;
    }

    // 3. Advance active cues (engine dt; re-sync to host after hiccups).
    for (const sl of this.slots) {
      if (sl.phase !== 'active') continue;
      sl.tau += dt;
      if (hostNow !== null) {
        const hostTau = (hostNow - (sl.cue.hostTime - VocalSync.visualLead)) * ratio;
        if (Math.abs(sl.tau - hostTau) > VocalSync.resyncThreshold) sl.tau = hostTau;
      }
      if (sl.fading) sl.fadeRemaining -= dt;
    }

    // 4. Activate due cues, in onset order.
    if (hostNow !== null) {
      for (let i = this.nextDue(hostNow); i !== null; i = this.nextDue(hostNow)) this.activate(i, hostNow, ratio);
    }

    // 5. Springs: fixed substep grid, linearly ramped targets, exact solution.
    const sp = s.modulation.speed;
    const speedK = Math.min(Math.max(Number.isFinite(sp) ? sp : 1, 0.75), 1.3);
    if (dt > 0) {
      const n = Math.max(1, Math.ceil(dt / VocalSync.substep - 1e-3));
      const h = dt / n;
      for (let j = 1; j <= n; j++) {
        const back = dt - j * h;
        const target = this.targets(back);
        this.step(target, h, speedK);
        this.prevTarget.set(target);
        const st = this.startleTarget(back);
        const r = VocalSync.rampStep(this.startle, this.startleVelocity, this.startlePrev, st, VocalSync.startleSpring, h);
        this.startle = r.x; this.startleVelocity = r.v;
        this.startlePrev = st;
      }
    } else {
      this.prevTarget.set(this.targets(0));
      this.startlePrev = this.startleTarget(0);
    }
    if (!(Number.isFinite(this.startle) && Number.isFinite(this.startleVelocity))) {
      this.startle = 0; this.startleVelocity = 0; this.startlePrev = 0;
    }
    const v = this.value;
    v[7] = this.prevTarget[7];
    let ok = true;
    for (let i = 0; i < 8; i++) if (!(Number.isFinite(v[i]) && Number.isFinite(this.velocity[i]))) ok = false;
    if (!ok) { v.fill(0); this.velocity.fill(0); this.prevTarget.fill(0); }

    // 6. Apply (capped).
    const energy = Math.min(Math.max(v[0], -0.3), 1.3);
    const fm = 1 + VocalSync.energyFaceScale * energy;
    s.faceScaleMul.x *= fm; s.faceScaleMul.y *= fm;
    s.brightness *= 1 + VocalSync.energyBrightness * energy;

    const [plo, phi] = VocalSync.pitchRange;
    const pitch = Math.min(Math.max(v[3], plo), phi);
    const hop = Math.min(Math.max(v[1], -2.0), 1.0);
    s.delta.raw[CENTER_Y] += Units.poseY(hop + VocalSync.pitchFaceYPer12 * pitch / 12);
    s.delta.raw[CENTER_X] += Units.poseX(Math.min(Math.max(v[7], -VocalSync.wobbleAmplitude), VocalSync.wobbleAmplitude));

    const squash = Math.min(Math.max(v[2], -0.01), 0.04);
    s.faceScaleMul.y *= 1 - squash;

    const eyeY = 1 + VocalSync.pitchEyeScalePer12 * pitch / 12;
    const widen = Math.min(Math.max(v[5], -0.25), 1.25);
    const wide = 1 + VocalSync.widenScale * widen;
    const em = s.eyeScaleMul;
    em.x *= wide; em.y *= wide * eyeY; em.z *= wide; em.w *= wide * eyeY;

    const squint = Math.min(Math.max(v[4], 0), VocalSync.squintMax);
    const lc = s.lidCoverage, wl = VocalSync.widenUpperLid * widen;
    lc.x += wl; lc.y += squint; lc.z += wl; lc.w += squint;

    const sleepy = Math.min(Math.max(v[6], 0), VocalSync.sleepyMaxClose);
    s.lidClose = sleepy >= s.lidClose ? sleepy : s.lidClose;

    // Startle shrinks the pupils a little.
    const pm = 1 - (1 - VocalSync.startlePupilMul) * Math.min(Math.max(this.startle, 0), 1.1);
    s.pupilSizeMul.x *= pm; s.pupilSizeMul.y *= pm;

    // 7. Retire finished cues.
    for (const sl of this.slots) {
      if (sl.phase === 'active' && (sl.tau > sl.end || (sl.fading && sl.fadeRemaining <= 0))) sl.phase = 'free';
    }
    if (s.presentationHostTime === null && !this.slots.some((sl) => sl.phase !== 'free')) this.virtualOffset = null;
  }

  // MARK: - Queue

  private enqueue(cue: VocalCue): void {
    if (!(Number.isFinite(cue.hostTime) && Number.isFinite(cue.duration) && Number.isFinite(cue.intensity)
      && Number.isFinite(cue.articulation) && Number.isFinite(cue.valence))) return;
    const i = this.slots.findIndex((sl) => sl.phase === 'free');
    if (i < 0) { this.dropped += 1; return; }
    const slot = new Slot();
    slot.phase = 'pending';
    slot.cue = cue;
    this.slots[i] = slot;
  }

  private cancel(from: number): void {
    for (const sl of this.slots) {
      if (sl.phase === 'pending' && sl.cue.hostTime >= from) {
        sl.phase = 'free';
      } else if (sl.phase === 'active' && !sl.fading && sl.cue.hostTime + sl.duration > from) {
        sl.fading = true;
        // Full weight at the start of this frame interval (when the command was sent): fps-independent.
        sl.fadeRemaining = VocalSync.cancelFade;
      }
    }
  }

  private earliestPending(): number | null {
    let best: number | null = null;
    for (const sl of this.slots) if (sl.phase === 'pending') best = Math.min(best ?? sl.cue.hostTime, sl.cue.hostTime);
    return best;
  }

  private nextDue(hostNow: number): number | null {
    let best: number | null = null;
    const sl = this.slots;
    for (let i = 0; i < sl.length; i++) {
      if (sl[i].phase === 'pending' && hostNow >= sl[i].cue.hostTime - VocalSync.visualLead) {
        if (best === null || sl[i].cue.hostTime < sl[best].cue.hostTime) best = i;
      }
    }
    return best;
  }

  private activate(i: number, hostNow: number, ratio: number): void {
    const sl = this.slots[i];
    const c = sl.cue;
    sl.phase = 'active';
    sl.duration = Math.min(Math.max(c.duration, 0.01), 5);
    sl.intensity = Math.min(Math.max(c.intensity, 0), 1);
    const art = Math.min(Math.max(c.articulation, 0), 1);
    sl.attack = VocalSync.attackSlow + (VocalSync.attackFast - VocalSync.attackSlow) * art;
    sl.tau = (hostNow - (c.hostTime - VocalSync.visualLead)) * ratio;

    // Phrase reference: first note after silence.
    const sounding = this.slots.some((o, j) =>
      j !== i && o.phase === 'active' && !o.fading && o.tau < o.duration + VocalSync.releaseTime);
    if (!sounding && c.hostTime - this.lastCueEndHost >= VocalSync.phraseGap) this.phraseRef = c.contour.start;
    sl.phraseRef = this.phraseRef;

    // Discrete hop: accent or a long inter-onset, max 5 Hz (decided on exact onset times: fps-independent).
    const ioi = c.hostTime - this.lastOnsetHost;
    if ((c.accent || ioi >= VocalSync.hopMinInterOnset - 1e-6) && c.hostTime - this.lastHopHost >= VocalSync.hopMinInterval - 1e-6) {
      const paired = c.pairedOneShot;
      const soft = paired != null && (OneShotLibrary.spec(paired).channels & OneShotChannels.translate) !== 0
        ? VocalSync.pairedTranslateSoftening : 1;
      sl.hop = (VocalSync.hopBase + VocalSync.hopPerIntensity * sl.intensity) * soft;
      sl.squash = VocalSync.squashDepth * soft;
      this.lastHopHost = c.hostTime;
      this.hopCount += 1;
    }
    this.lastOnsetHost = c.hostTime;
    this.lastCueEndHost = Math.max(this.lastCueEndHost, c.hostTime + sl.duration);

    // Gates.
    sl.squintGate = c.valence > 0 ? Ease.smoothstep(c.valence / 0.2) : 0;
    // bigSurprise and the pupil transformations bring their own pupils: no widen, no startle shrink.
    const ownPupils = c.pairedOneShot === 'bigSurprise' || (c.pairedOneShot != null && isPupilShape(c.pairedOneShot));
    sl.widenGate = (c.kind === 'startle' || c.kind === 'curious') && !ownPupils ? 1 : 0;
    sl.startleGate = c.kind === 'startle' && !ownPupils ? 1 : 0;
    if (c.kind === 'sleepy') {
      const slope = (c.contour.pitch(sl.duration, sl.duration) - c.contour.start) / sl.duration;
      const soft = 1 - Ease.smoothstep((art - 0.3) / 0.2);
      sl.sleepyGate = slope < VocalSync.sleepySlope ? soft : 0;
    }
    sl.wobble = c.kind === 'wobble';
    this.activations += 1;
  }

  // MARK: - Targets

  /// Channel targets at `back` engine seconds before the end of this frame (written into a scratch array).
  private targets(back: number): Float64Array {
    let energy = 0, hop = 0, squash = 0, pitchNum = 0, pitchDen = 0, squint = 0, widen = 0, sleepy = 0, wobble = 0;
    const [plo, phi] = VocalSync.pitchRange;
    for (const sl of this.slots) {
      if (sl.phase !== 'active') continue;
      const t = sl.tau - back;
      if (t < 0 || t > sl.end) continue;
      const fade = sl.fading ? Ease.smoothstep((sl.fadeRemaining + back) / VocalSync.cancelFade) : 1;
      if (fade <= 0) continue;
      const d = sl.duration;
      const presence = Ease.smoothstep(t / sl.attack) * (1 - Ease.smoothstep((t - d) / VocalSync.releaseTime)) * fade;
      energy += sl.intensity * presence * (1 - 0.25 * Ease.smoothstep(t / d));
      if (sl.hop > 0) {
        hop -= sl.hop * VocalSync.hopGain * Ease.bump(t / VocalSync.hopWidth) * fade;
        squash += sl.squash * Ease.bump(t / VocalSync.squashWidth) * fade;
      }
      if (!(presence > 0)) continue;
      const p = sl.cue.contour.pitch(Math.min(t, d), d);
      if (!Number.isFinite(p)) continue;
      const rel = Math.min(Math.max(p - sl.phraseRef, plo), phi);
      pitchNum += presence * rel;
      pitchDen += presence;
      if (sl.squintGate > 0) {
        const high = Ease.smoothstep((p - VocalSync.squintLow) / (VocalSync.squintHigh - VocalSync.squintLow));
        squint = Math.max(squint, VocalSync.squintMax * high * sl.squintGate * presence);
      }
      widen = Math.max(widen, sl.widenGate * presence);
      if (sl.sleepyGate > 0) {
        const drop = Math.max(sl.cue.contour.start - p, 0);
        sleepy = Math.max(sleepy, Math.min(VocalSync.sleepyMaxClose * drop / VocalSync.sleepyFullDrop, VocalSync.sleepyMaxClose)
          * sl.sleepyGate * presence);
      }
      if (sl.wobble) {
        const w = 2 * Math.PI * Math.max(sl.cue.contour.wobbleRate, 0) * t;
        wobble += VocalSync.wobbleAmplitude * (0.6 * Math.sin(w) + 0.4 * Math.sin(w * 1.52)) * presence;
      }
    }
    const o = this.target;
    o[0] = Math.min(energy, 1); o[1] = hop; o[2] = squash; o[3] = pitchNum / Math.max(pitchDen, 1);
    o[4] = squint; o[5] = widen; o[6] = sleepy;
    o[7] = Math.min(Math.max(wobble, -VocalSync.wobbleAmplitude), VocalSync.wobbleAmplitude);
    return o;
  }

  /// Startle pupil-shrink target at `back` engine seconds before the end of this frame.
  private startleTarget(back: number): number {
    let v = 0;
    for (const sl of this.slots) {
      if (!(sl.phase === 'active' && sl.startleGate > 0)) continue;
      const t = sl.tau - back;
      if (t < 0 || t > sl.end) continue;
      const fade = sl.fading ? Ease.smoothstep((sl.fadeRemaining + back) / VocalSync.cancelFade) : 1;
      const presence = Ease.smoothstep(t / sl.attack) * (1 - Ease.smoothstep((t - sl.duration) / VocalSync.releaseTime)) * fade;
      v = Math.max(v, sl.startleGate * presence);
    }
    return v;
  }

  // MARK: - Springs

  private step(target: Float64Array, dt: number, speedK: number): void {
    const V = VocalSync;
    const e = new SpringParams(V.energySpring.omega * speedK, V.energySpring.zeta);
    const hp = new SpringParams(V.hopSpring.omega * speedK, V.hopSpring.zeta);
    const sq = new SpringParams(V.squashSpring.omega * speedK, V.squashSpring.zeta);
    const springs = [e, hp, sq, V.pitchSpring, V.squintSpring, V.widenSpring, V.sleepySpring];
    for (let i = 0; i < 7; i++) {
      const r = V.rampStep(this.value[i], this.velocity[i], this.prevTarget[i], target[i], springs[i], dt);
      this.value[i] = r.x; this.velocity[i] = r.v;
    }
  }

  /// Exact step of a damped spring whose target moves linearly from `r0` to `r1` over `dt`. With r(t) = r0 + k·t,
  /// e = x − r + 2ζk/ω obeys the homogeneous equation, so the closed-form coefficients apply to (e, v − k).
  static rampStep(x: number, v: number, r0: number, r1: number, p: SpringParams, dt: number): { x: number; v: number } {
    if (!(dt > 0)) return { x, v };
    const k = (r1 - r0) / dt;
    const c = 2 * Math.max(p.zeta, 0) * k / Math.max(p.omega, 1e-4);
    const { a, b, c: cc, d } = p.coefficients(dt);
    const e0 = x - r0 + c, ve0 = v - k;
    const e1 = e0 * a + ve0 * b;
    const ve1 = e0 * cc + ve0 * d;
    return { x: e1 + r1 - c, v: ve1 + k };
  }
}
