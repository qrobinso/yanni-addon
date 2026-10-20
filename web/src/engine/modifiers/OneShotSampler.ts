// Port of FaceEngine/Modifiers/OneShotSampler.swift.
import { v2, type V2 } from '../../core/vec';
import { Units } from '../../model';
import type { AgentState } from '../AgentState';
import { OneShotKind, type GazeOverride } from '../Commands';
import { Ease } from '../Easing';
import { EdgeAnticContext } from '../EdgeAnticCurves';
import { OneShotOutput, type FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import {
  OneShotChannels, OneShotLibrary, OneShotParams, OneShotRequest, gentleAnswer, isAnswer, isEdgeAntic, isIdleGame,
  isPupilShape, isScreenEdgeAntic,
} from '../OneShots';
import { PupilShapeFrame, switchBack, switchBackDuration } from '../PupilShapeCurves';
import { SpringParams } from '../Spring';
import { Attention } from './Attention';
import { HostClockEstimator } from './VocalSync';

class Slot {
  active = false;
  kind: OneShotKind = 'laugh';
  params = new OneShotParams();
  playhead = 0;
  /// True on the start frame: the playhead is not advanced (it already holds any host-time pre-advance).
  fresh = false;
  duration = 0;
  fading = false;
  fadeRemaining = 0;
  /// False once superseded by a same-kind retrigger or released by a state change.
  reportsCompletion = true;
  serial = 0;
  priority = 0;
  channels: OneShotChannels = 0;
  prevBlink = 0;
  /// Last frame's weighted contribution (frozen into a residual on eviction or release).
  last = new OneShotOutput();
  /// Playback speed used last frame (for the release velocity).
  speed = 1;
  springRelease = false;
  /// Pupil transformation bookkeeping.
  isShape = false;
  age = 0;
  switching = false;
  switchT = 0;
  frozen = new PupilShapeFrame();
  lastShape = new PupilShapeFrame();
  actingWeight = 1;
  stalled = false;
}

const LANES = 13;

/// Behaviour-phase half of the one-shot system (design Part D, C1 + H5).
///
/// Consumes `s.oneShotRequests`, `s.oneShotCancels` and `.playOneShot` commands, enforces per-kind cooldowns, resolves
/// channel conflicts, crossfades same-kind retriggers, releases state-scoped one-shots on agent-state change, advances
/// playheads by `dt · speed` (speed clamped per kind) and samples every active slot into `s.oneShot`. Runs before
/// Attention so its gaze override is seen the same frame.
///
/// Ending early goes through the spec's release style: `fade` (120 ms), `spring` (translate lanes ride one shared
/// underdamped spring home with the curve's own velocity; the rest fades over `softReleaseDuration`) or `switchBack`
/// (the pupil transformations' scripted coin flip). See the Swift doc comment for the full contract (answers, screen
/// edges, voice sync, pupil transformations).
export class OneShotSampler implements Modifier {
  readonly name = 'OneShotSampler';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  static readonly capacity = 6;
  /// Fade-out time for conflicts, retriggers, state release and eviction (seconds).
  static readonly fadeDuration = 0.12;
  static readonly speedRange: readonly [number, number] = [0.5, 1.6];
  /// The spring that carries a spring-released one-shot's translate lanes home.
  static readonly releaseSpring = new SpringParams(8.5, 0.72);
  /// A spring release's scales, lids, closure and pupils fade over this long (smoothstep).
  static readonly softReleaseDuration = 0.2;
  /// The spring residual ends once every lane is within these (canvas units / degrees; per second).
  static readonly springRestPosition = 0.05;
  static readonly springRestVelocity = 0.5;
  /// Blink-channel threshold for detecting the start of a one-shot blink.
  static readonly blinkStartThreshold = 0.02;
  /// A transformation still active this long past its instance duration is switched back (seconds).
  static readonly shapeWatchdogGrace = 0.5;
  /// A switch back that somehow outlives this is ended outright (seconds).
  static readonly switchBackLimit = 0.5;
  /// Contested acting fades out / back in over this long (seconds).
  static readonly actingFade = 0.12;
  /// Host-timed requests waiting for their frame.
  static readonly pendingCapacity = 8;
  /// States in which answer requests (nods and shakes) are dropped: the sleepy ones.
  static readonly answerBlockedStates: readonly AgentState[] = ['drowsy', 'asleep', 'halfAwake', 'waking'];

  private slots: Slot[] = Array.from({ length: OneShotSampler.capacity }, () => new Slot());
  private lastTrigger: number[] = new Array<number>(OneShotKind.count).fill(-Infinity);
  private lastState: AgentState | null = null;
  private serial = 0;
  private residual = new OneShotOutput();
  private residualRemaining = 0;
  private softResidual = new OneShotOutput();
  private softRemaining = 0;
  /// Spring residual lanes: 0–1 face stage, 2–5 eye stages, 6–7 face centre, 8 angle, 9–12 eye centres.
  private springX = new Float64Array(16);
  private springV = new Float64Array(16);
  private springActive = false;
  private pending: { kind: OneShotKind; hostTime: number }[] = [];
  private clock = new HostClockEstimator();
  /// A transformation waiting for the current one to finish switching back.
  private deferredShape: OneShotRequest | null = null;

  /// Read-outs (tests, preview): watchdog switch-backs so far, the waiting transformation.
  private _shapeWatchdogCount = 0;
  get shapeWatchdogCount(): number { return this._shapeWatchdogCount; }
  get deferredPupilShape(): OneShotKind | null { return this.deferredShape?.kind ?? null; }
  /// The transformation currently showing (including its switch back) and whether it is switching back.
  get activePupilShape(): { kind: OneShotKind; switchingBack: boolean } | null {
    for (const sl of this.slots) if (sl.active && sl.isShape) return { kind: sl.kind, switchingBack: sl.switching };
    return null;
  }

  /// Host-timed one-shot requests still waiting (tests / debug UI).
  get pendingHostTimedCount(): number { return this.pending.length; }
  /// Number of occupied slots (including fading ones). For tests and debug UI.
  get activeSlotCount(): number { return this.slots.reduce((n, s) => n + (s.active ? 1 : 0), 0); }
  /// True while a spring release is still carrying something home (tests / debug UI).
  get isSpringReleasing(): boolean { return this.springActive; }

  /// Playback speed for `kind` at mood speed `raw`.
  static speed(kind: OneShotKind, raw: number): number {
    const r = OneShotLibrary.spec(kind).speedRange ?? OneShotSampler.speedRange;
    const v = Number.isFinite(raw) ? raw : 1;
    return Math.min(Math.max(v, r[0]), r[1]);
  }

  update(s: FaceState): void {
    const dt = Math.max(s.dt, 0);
    const slots = this.slots;
    s.completedOneShots.length = 0;
    s.startedOneShots.length = 0;
    this.clock.update(s.presentationHostTime, s.dt);
    const rawSpeed = s.modulation.speed;

    // 1. State-scoped release (before new requests, so a state's entry one-shot survives).
    if (this.lastState !== null && this.lastState !== s.agentState) {
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].active && !slots[i].fading && OneShotLibrary.spec(slots[i].kind).releases(s.agentState)) {
          slots[i].reportsCompletion = false;
          this.release(i, s);
        }
      }
    }
    this.lastState = s.agentState;

    // 1b. Cancels and seeks.
    for (const c of s.oneShotCancels) {
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i];
        if (!(sl.active && !sl.fading && (c.kinds.contains(sl.kind) || !OneShotChannels.isDisjoint(sl.channels, c.channels)))) continue;
        if (c.mode === 'release') {
          sl.reportsCompletion = false;
          this.release(i, s);
        } else {
          const target = sl.params.edge.returnAt * sl.params.timeMul;
          if (sl.params.edge.baseDuration > 0 && sl.playhead < target) sl.playhead = target;
        }
      }
    }
    s.oneShotCancels.length = 0;

    // 2. New triggers.
    for (let r = 0; r < s.oneShotRequests.length; r++) {
      this.trigger(OneShotRequest.make(s.oneShotRequests[r]), s, rawSpeed, dt);
    }
    s.oneShotRequests.length = 0;
    for (let r = 0; r < s.oneShotPlayRequests.length; r++) this.trigger(s.oneShotPlayRequests[r], s, rawSpeed, dt);
    s.oneShotPlayRequests.length = 0;
    for (const command of s.commands) {
      switch (command.kind) {
        case 'playOneShot':
          this.trigger(OneShotRequest.make(command.oneShot), s, rawSpeed, dt);
          break;
        case 'play':
          this.trigger(command.request, s, rawSpeed, dt);
          break;
        case 'playOneShotAt':
          if (s.presentationHostTime === null || !Number.isFinite(command.hostTime)) {
            this.trigger(OneShotRequest.make(command.oneShot), s, rawSpeed, dt);
          } else if (this.pending.length < OneShotSampler.pendingCapacity) {
            this.pending.push({ kind: command.oneShot, hostTime: command.hostTime });
          } // else: queue full, the request is dropped (nothing reported as started)
          break;
        default:
          break;
      }
    }
    s.edgeSideHint = 0;

    // 2b. Host-timed requests whose frame has come.
    if (s.presentationHostTime !== null) {
      const now = s.presentationHostTime;
      let i = 0;
      while (i < this.pending.length) {
        const p = this.pending[i];
        if (now >= p.hostTime - this.clock.framePeriod * 0.5) {
          // Engine seconds the one-shot should already have run (negative: starts within half a frame).
          const pre = (now - p.hostTime) * this.clock.timeScale;
          this.trigger(OneShotRequest.make(p.kind), s, rawSpeed, Math.min(Math.max(pre, -0.05), 0.05));
          this.pending.splice(i, 1);
        } else {
          i++;
        }
      }
    }

    // 2c. A deferred transformation starts once the previous one has switched back.
    if (this.deferredShape !== null && !slots.some((x) => x.active && x.isShape)) {
      const d = this.deferredShape;
      this.deferredShape = null;
      this.trigger(d, s, rawSpeed, dt);
    }

    // 3. Advance, sample, combine.
    const out = new OneShotOutput();
    let gazePriority = -Infinity;
    let gazeSerial = 0;
    const acting: { gaze: GazeOverride | null } = { gaze: null };
    let shapePriority = -Infinity;
    let shapeSerial = 0;
    let gameShape: PupilShapeFrame | null = null;
    s.activeOneShots.length = 0;

    for (let i = 0; i < slots.length; i++) {
      if (!slots[i].active) continue;
      const speed = OneShotSampler.speed(slots[i].kind, rawSpeed);
      slots[i].speed = speed;
      if (slots[i].isShape) {
        const f = this.advanceShape(i, s, dt, speed, out, acting);
        if (f !== null) {
          const pr = slots[i].priority;
          if (pr > shapePriority || (pr === shapePriority && slots[i].serial > shapeSerial)) {
            out.pupilShape = { ...f.shape };
            out.pupilMorph = { ...f.morph };
            out.pupilShapeScale = { ...f.scale };
            shapePriority = pr;
            shapeSerial = slots[i].serial;
          }
          if (!s.activeOneShots.includes(slots[i].kind)) s.activeOneShots.push(slots[i].kind);
        }
        continue;
      }
      const sl = slots[i];
      if (sl.fresh) sl.fresh = false;
      else sl.playhead += dt * speed;
      if (sl.fading) sl.fadeRemaining -= dt;
      const finished = sl.playhead >= sl.duration;
      if (finished || (sl.fading && sl.fadeRemaining <= 0)) {
        this.end(i, s);
        continue;
      }
      const kind = sl.kind;
      const sample = OneShotLibrary.sample(kind, sl.playhead, sl.params);
      // Reduce Motion (the engine-wide factor); the answers and transformations scale their own movement.
      if (s.reduceMotion && !isAnswer(kind)) OneShotLibrary.scaleMotion(sample, s.motionScale);
      const w = sl.fading ? Ease.smoothstep(sl.fadeRemaining / OneShotSampler.fadeDuration) : 1;
      const weighted = new OneShotOutput();
      OneShotLibrary.accumulate(sample, w, weighted);
      sl.last = weighted;
      OneShotLibrary.accumulate(weighted, 1, out);

      if (weighted.blink > OneShotSampler.blinkStartThreshold && sl.prevBlink <= OneShotSampler.blinkStartThreshold) {
        s.lastBlinkTime = s.time;
      }
      sl.prevBlink = weighted.blink;
      if (sample.ownsClosure) out.ownsClosure = true;
      if (isIdleGame(kind) && !sl.fading) {
        gameShape = new PupilShapeFrame(sample.pupilShape, sample.pupilMorph, sample.pupilShapeScale);
      }

      if (!sl.fading && sample.gaze !== null) {
        const pr = sl.priority;
        if (pr > gazePriority || (pr === gazePriority && sl.serial > gazeSerial)) {
          out.gaze = sample.gaze;
          gazePriority = pr;
          gazeSerial = sl.serial;
        }
      }
      if (!s.activeOneShots.includes(kind)) s.activeOneShots.push(kind);
    }

    // An idle game's pupils (a hidden ball, stars) show unless a transformation owns the silhouette.
    if (shapePriority === -Infinity && gameShape !== null) {
      out.pupilShape = { ...gameShape.shape }; out.pupilMorph = { ...gameShape.morph }; out.pupilShapeScale = { ...gameShape.scale };
    }

    // Acting gaze (transformations) only when no one-shot owns gaze.
    if (out.gaze === null && acting.gaze !== null) out.gaze = acting.gaze;

    if (this.residualRemaining > 0) {
      this.residualRemaining -= dt;
      if (this.residualRemaining > 0) {
        OneShotLibrary.accumulate(this.residual, Ease.smoothstep(this.residualRemaining / OneShotSampler.fadeDuration), out);
      } else {
        this.residual = new OneShotOutput();
      }
    }
    if (this.softRemaining > 0) {
      this.softRemaining -= dt;
      if (this.softRemaining > 0) {
        OneShotLibrary.accumulate(this.softResidual, Ease.smoothstep(this.softRemaining / OneShotSampler.softReleaseDuration), out);
      } else {
        this.softResidual = new OneShotOutput();
      }
    }
    if (this.springActive) {
      const { a, b, c, d } = OneShotSampler.releaseSpring.coefficients(dt);
      const X = this.springX, V = this.springV;
      let finite = true;
      for (let k = 0; k < 16; k++) {
        const x = X[k], v = V[k];
        X[k] = x * a + v * b;
        V[k] = x * c + v * d;
        if (k < LANES && !(Number.isFinite(X[k]) && Number.isFinite(V[k]))) finite = false;
      }
      if (!finite) { X.fill(0); V.fill(0); }
      OneShotSampler.addLanes(X, out);
      let maxX = 0, maxV = 0;
      for (let k = 0; k < LANES; k++) { maxX = Math.max(maxX, Math.abs(X[k])); maxV = Math.max(maxV, Math.abs(V[k])); }
      if (maxX < OneShotSampler.springRestPosition && maxV < OneShotSampler.springRestVelocity) {
        this.springActive = false;
        X.fill(0); V.fill(0);
      }
    }

    s.oneShot = out;
  }

  // MARK: - Spring lanes

  /// The translate lanes of a contribution (canvas units / degrees).
  static lanes(o: OneShotOutput, x: Float64Array = new Float64Array(16)): Float64Array {
    const d = o.delta;
    x[0] = o.stageOffset.x; x[1] = o.stageOffset.y;
    x[2] = o.eyeStageOffset.x; x[3] = o.eyeStageOffset.y; x[4] = o.eyeStageOffset.z; x[5] = o.eyeStageOffset.w;
    x[6] = Units.canvasX(d.face('centerX')); x[7] = Units.canvasY(d.face('centerY')); x[8] = d.face('angle');
    x[9] = Units.canvasX(d.eye('left', 'centerX')); x[10] = Units.canvasY(d.eye('left', 'centerY'));
    x[11] = Units.canvasX(d.eye('right', 'centerX')); x[12] = Units.canvasY(d.eye('right', 'centerY'));
    return x;
  }

  static addLanes(x: Float64Array, o: OneShotOutput): void {
    const d = o.delta;
    o.stageOffset = v2(o.stageOffset.x + x[0], o.stageOffset.y + x[1]);
    const e = o.eyeStageOffset;
    o.eyeStageOffset = { x: e.x + x[2], y: e.y + x[3], z: e.z + x[4], w: e.w + x[5] };
    d.setFace('centerX', d.face('centerX') + Units.poseX(x[6]));
    d.setFace('centerY', d.face('centerY') + Units.poseY(x[7]));
    d.setFace('angle', d.face('angle') + x[8]);
    d.setEye('left', 'centerX', d.eye('left', 'centerX') + Units.poseX(x[9]));
    d.setEye('left', 'centerY', d.eye('left', 'centerY') + Units.poseY(x[10]));
    d.setEye('right', 'centerX', d.eye('right', 'centerX') + Units.poseX(x[11]));
    d.setEye('right', 'centerY', d.eye('right', 'centerY') + Units.poseY(x[12]));
  }

  /// A contribution with its translate lanes removed.
  static withoutLanes(o: OneShotOutput): OneShotOutput {
    const r = o.copy();
    r.stageOffset = v2(0);
    r.eyeStageOffset = { x: 0, y: 0, z: 0, w: 0 };
    const d = r.delta;
    d.setFace('centerX', 0); d.setFace('centerY', 0); d.setFace('angle', 0);
    d.setEye('left', 'centerX', 0); d.setEye('left', 'centerY', 0);
    d.setEye('right', 'centerX', 0); d.setEye('right', 'centerY', 0);
    r.gaze = null;
    r.ownsClosure = false;
    return r;
  }

  // MARK: - Pupil transformations

  /// Advances transformation slot `i`: its acting is accumulated into `out` (weighted by the acting weight and, while
  /// switching back, a fade), its gaze offered as `acting.gaze`. Returns its silhouette, or null once it has ended.
  private advanceShape(i: number, s: FaceState, dt: number, speed: number, out: OneShotOutput,
    acting: { gaze: GazeOverride | null }): PupilShapeFrame | null {
    const sl = this.slots[i];
    const kind = sl.kind;
    if (sl.fresh) {
      sl.fresh = false;
    } else {
      if (!sl.stalled) sl.playhead += dt * speed;
      sl.age += dt;
    }
    if (sl.switching) {
      sl.switchT += dt;
      if (sl.switchT >= switchBackDuration || sl.switchT >= OneShotSampler.switchBackLimit) {
        this.end(i, s);
        return null;
      }
    } else if (sl.playhead >= sl.duration) {
      this.end(i, s);
      return null;
    } else if (sl.age > sl.duration / Math.max(speed, 1e-3) + OneShotSampler.shapeWatchdogGrace) {
      this._shapeWatchdogCount += 1;
      this.beginSwitchBack(i);
    }

    // Acting yields to any other one-shot that owns one of its channels.
    const actingChannels = OneShotLibrary.spec(kind).actingChannels;
    let contested = false;
    for (let j = 0; j < this.slots.length; j++) {
      const o = this.slots[j];
      if (j !== i && o.active && !o.fading && !o.isShape && !OneShotChannels.isDisjoint(o.channels, actingChannels)) {
        contested = true;
        break;
      }
    }
    const step = dt / OneShotSampler.actingFade;
    sl.actingWeight = contested ? Math.max(sl.actingWeight - step, 0) : Math.min(sl.actingWeight + step, 1);

    const sample = OneShotLibrary.sample(kind, Math.min(sl.playhead, sl.duration), sl.params);
    let w = Ease.smoothstep(sl.actingWeight);
    let shape = new PupilShapeFrame(sample.pupilShape, sample.pupilMorph, sample.pupilShapeScale);
    if (sl.switching) {
      w *= 1 - Ease.smoothstep(sl.switchT / switchBackDuration);
      shape = switchBack(sl.frozen, sl.switchT);
    }
    const weighted = new OneShotOutput();
    OneShotLibrary.accumulate(sample, w, weighted);
    sl.last = weighted;
    OneShotLibrary.accumulate(weighted, 1, out);
    if (!sl.switching && w > 0.5 && sample.gaze !== null) acting.gaze = sample.gaze;
    sl.lastShape = shape;
    return shape;
  }

  /// Starts slot `i`'s switch back from the silhouette it showed last frame.
  private beginSwitchBack(i: number): void {
    const sl = this.slots[i];
    if (!(sl.active && sl.isShape && !sl.switching)) return;
    sl.switching = true;
    sl.switchT = 0;
    sl.reportsCompletion = false;
    sl.frozen = sl.lastShape.copy();
  }

  /// Tests: freezes the playhead of the active `kind` (its watchdog must fire).
  stallForTesting(kind: OneShotKind): void {
    for (const sl of this.slots) if (sl.active && sl.kind === kind) sl.stalled = true;
  }

  /// Ends slot `i` early through its release style.
  private release(i: number, s: FaceState, fadeExtra = 0): void {
    if (this.slots[i].isShape) {
      this.beginSwitchBack(i);
      return;
    }
    if (this.slots[i].springRelease) this.springRelease(i, s);
    else this.beginFade(i, fadeExtra);
  }

  /// Hands slot `i`'s translate lanes (position and curve velocity) to the release spring and the rest of its last
  /// contribution to the soft residual, then frees the slot.
  private springRelease(i: number, s: FaceState): void {
    const slot = this.slots[i];
    if (!slot.fresh) {
      const x = OneShotSampler.lanes(slot.last);
      // Velocity from the curve itself (instance seconds → engine seconds via the slot's speed).
      const h = 1.0 / 240;
      const before = OneShotSampler.lanes(OneShotLibrary.sample(slot.kind, Math.max(slot.playhead - h, 0), slot.params));
      for (let k = 0; k < 16; k++) {
        this.springX[k] += x[k];
        this.springV[k] += (x[k] - before[k]) / h * slot.speed;
      }
      this.springActive = true;
      const merged = new OneShotOutput();
      if (this.softRemaining > 0) {
        OneShotLibrary.accumulate(this.softResidual, Ease.smoothstep(this.softRemaining / OneShotSampler.softReleaseDuration), merged);
      }
      OneShotLibrary.accumulate(OneShotSampler.withoutLanes(slot.last), 1, merged);
      this.softResidual = merged;
      this.softRemaining = OneShotSampler.softReleaseDuration;
    }
    this.end(i, s);
  }

  /// Starts fading slot `i`. A trigger passes `extra = dt − preAdvance` so the fade begins exactly when the newcomer
  /// starts (keeps host-timed conflicts identical at 60 and 120 fps).
  private beginFade(i: number, extra = 0): void {
    const sl = this.slots[i];
    if (sl.fading) return;
    sl.fading = true;
    sl.fadeRemaining = OneShotSampler.fadeDuration + Math.max(extra, 0);
  }

  private end(i: number, s: FaceState): void {
    const sl = this.slots[i];
    if (sl.reportsCompletion && !s.completedOneShots.includes(sl.kind)) s.completedOneShots.push(sl.kind);
    sl.active = false;
  }

  /// Starts `kind` if cooldown / priority / capacity / screen allow, publishing it in `s.startedOneShots`.
  /// `preAdvance` is engine seconds the one-shot should already have run at this frame (host-timed starts).
  private trigger(incoming: OneShotRequest, s: FaceState, rawSpeed: number, preAdvance: number): boolean {
    const request: OneShotRequest = { ...incoming };
    if (isAnswer(request.kind)) {
      // Answers are for an awake face: dropped while sleepy; bedtime softens an emphatic one to the gentle one.
      if (OneShotSampler.answerBlockedStates.includes(s.agentState)) return false;
      if (s.isBedtime) request.kind = gentleAnswer(request.kind);
      if (s.pupilSettings.reduceMotion) request.reduceMotion = true;
    }
    const kind = request.kind;
    const spec = OneShotLibrary.spec(kind);
    const k = OneShotKind.ordinal(kind);
    const slots = this.slots;
    // One transformation at a time: a new one switches the current one back and waits for it.
    if (isPupilShape(kind) && slots.some((x) => x.active && x.isShape)) {
      for (let i = 0; i < slots.length; i++) if (slots[i].active && slots[i].isShape) this.beginSwitchBack(i);
      this.deferredShape = request;
      return false;
    }
    // f32: engine time is bit-exact with Swift's (FaceEngine.tick), so compare against the Float cooldown widened to
    // Double as Swift does; a retrigger exactly one cooldown later (dance at 1.2 s) lands on this edge.
    if (!(s.time - this.lastTrigger[k] >= Math.fround(spec.cooldown))) return false;
    // The screen-edge antics need to know where the screen is.
    if (isScreenEdgeAntic(kind) && !(s.edgeGeometry?.isValid ?? false)) return false;
    const speed = OneShotSampler.speed(kind, rawSpeed);

    // Find a slot: free first; else the weakest fading slot; else lowest priority, oldest. Transformations are never
    // evicted.
    let target = slots.findIndex((x) => !x.active);
    if (target < 0) {
      let best = -1;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].fading && (best < 0 || slots[i].fadeRemaining < slots[best].fadeRemaining)) best = i;
      }
      if (best < 0) {
        for (let i = 0; i < slots.length; i++) {
          if (slots[i].isShape) continue;
          if (best < 0 || slots[i].priority < slots[best].priority
            || (slots[i].priority === slots[best].priority && slots[i].serial < slots[best].serial)) best = i;
        }
        // Never evict something more important than the newcomer: drop the request instead.
        if (best < 0 || slots[best].priority > spec.priority) return false;
      }
      this.evict(best, s);
      target = best;
    }

    this.lastTrigger[k] = s.time;

    // Channel conflicts end the old one; a same-kind retrigger crossfades (old releases, new starts at 0).
    const extra = Math.max(s.dt, 0) - preAdvance;
    for (let i = 0; i < slots.length; i++) {
      if (!(slots[i].active && !slots[i].fading)) continue;
      if (slots[i].kind === kind) {
        slots[i].reportsCompletion = false;
        this.release(i, s, extra);
      } else if (!OneShotChannels.isDisjoint(slots[i].channels, spec.channels)) {
        this.release(i, s, extra);
      }
    }

    let context = new EdgeAnticContext();
    if (isEdgeAntic(kind) || isIdleGame(kind)) {
      const pose = s.output.pose;
      const st = s.output.stageOffset;
      context = new EdgeAnticContext({
        geometry: s.edgeGeometry, settings: s.edgeSettings, sideHint: s.edgeSideHint,
        faceOffset: v2(Units.canvasX(pose.face('centerX')) + st.x, Units.canvasY(pose.face('centerY')) + st.y),
      });
      context.gameSettings = s.idleGameSettings;
      const id = s.primaryPersonID;
      const q = id === null ? undefined : s.people.find((x) => x.id === id);
      if (q !== undefined) {
        const c = Attention.cameraCorrection(s.cameraOffsetMetres, q.distance);
        context.person = v2(q.position.x + c.x, q.position.y + c.y);
      }
    }
    const params = OneShotLibrary.makeParams(request, s.rng, s.eyeGaze, context);
    this.serial += 1;
    const sl = new Slot();
    sl.active = true; sl.kind = kind; sl.params = params; sl.playhead = preAdvance * speed; sl.fresh = true;
    sl.duration = OneShotLibrary.duration(kind, params); sl.serial = this.serial; sl.priority = spec.priority;
    sl.channels = spec.channels; sl.speed = speed; sl.springRelease = spec.releaseStyle === 'spring';
    sl.isShape = isPupilShape(kind);
    slots[target] = sl;
    if (isScreenEdgeAntic(kind)) s.lastEdgeAnticTime = s.time;
    if (isIdleGame(kind)) s.lastIdleGameTime = s.time;

    // Accent at base time a is reached when playhead = a·timeMul, i.e. a·timeMul/speed engine seconds after start:
    // rate = speed / timeMul.
    const rate = speed / Math.max(params.timeMul, 0.01);
    const ts = Math.max(this.clock.timeScale, 1e-3);
    s.startedOneShots.push({
      kind,
      engineTime: s.time - preAdvance,
      hostTime: s.presentationHostTime === null ? null : s.presentationHostTime - preAdvance / ts,
      rate,
      accentTimes: OneShotLibrary.accentTimes(kind, params),
      softVoice: request.softVoice,
    });
    return true;
  }

  /// Tests: evicts the active slot of `kind` exactly as a full slot table would.
  evictForTesting(kind: OneShotKind, s: FaceState): void {
    const i = this.slots.findIndex((x) => x.active && x.kind === kind);
    if (i < 0) return;
    if (this.slots[i].isShape) this.beginSwitchBack(i); else this.evict(i, s);
  }

  /// Removes a slot without a visible jump: a spring slot is spring-released; any other has its last contribution
  /// frozen into the residual, which fades out.
  private evict(i: number, s: FaceState): void {
    if (this.slots[i].springRelease && !this.slots[i].fading) {
      this.springRelease(i, s);
      return;
    }
    const merged = new OneShotOutput();
    if (this.residualRemaining > 0) {
      OneShotLibrary.accumulate(this.residual, Ease.smoothstep(this.residualRemaining / OneShotSampler.fadeDuration), merged);
    }
    OneShotLibrary.accumulate(this.slots[i].last, 1, merged);
    this.residual = merged;
    this.residualRemaining = OneShotSampler.fadeDuration;
    this.end(i, s);
  }
}

export type { V2 };
