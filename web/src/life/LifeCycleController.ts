// Port of FaceLife/LifeCycleController.swift.
import type { V3 } from '../core/vec';
import { FaceCommand, Spring1, SpringParams, type AgentState, type FaceEngine, type FaceState, type OneShotKind } from '../engine';
import { sleepySinkSettle } from '../engine/EdgeAnticCurves';
import { restore, resumeState, type LifeResumeState } from './LifeResume';
import { LifeSettings, type LifeSettingsStore } from './LifeSettings';
import {
  LifeCalendar, LifeClock, LifePhase, type ActivityKind, type CameraMode, type LifeCountdown, type LifePhaseChange,
  type LifeReason,
} from './LifeTypes';

/// The parts of TouchReactions the controller reads and writes (Swift `as? TouchReactions`).
interface TouchView { readonly tapCount: number; readonly tapWakeCount: number; tapsToWake: number }

const ACTIVITY_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['engaged', 'listening', 'thinking', 'speaking', 'followUp', 'interrupted']);
const TAKEOVER_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['sheepish', 'confused', 'hasMessage']);

interface CatchPending { kind: OneShotKind; requestedAt: number; seenActive: boolean }
interface SinkPending { requestedAt: number; reason: LifeReason; start: { engineTime: number; rate: number } | null }

/// The single owner of sleep and wake policy. The face engine knows how each state looks; this decides when Yanni is
/// idle, drowsy, asleep, half-awake or waking, and when it is bedtime.
///
/// Drive it once per display frame, after `engine.frame` and the voice director (`afterFrame`). Every transition is
/// written through `engine.setAgentState`, so the face's entry one-shots and its own auto-transitions (waking →
/// noticing) still play. The phase is derived each frame from the observed agent state; changes made by anyone else
/// are noticed and the timers re-sync from them.
///
/// **Timers.** Minute-scale timers (to drowsy, to asleep, bedtime drift-back, takeover, boredom) accumulate each call's
/// clamped real delta × `timeWarp`; second-scale delays (presence debounce, half-awake timings, the 30 s bedtime
/// lead-in, catch-yourself) always run in real time.
///
/// **Daytime.** Activity = someone in view, someone engaging, a tap, a conversation state, `noteActivity`, or a state
/// change made by someone else. Idle → drowsy after `minutesToDrowsy` without activity, drowsy → asleep after a
/// further `minutesToAsleep`. Activity while drowsy: Yanni catches itself (`catchSelf`, then idle). Falling asleep
/// (timer or bedtime lead-in, not force) may play the sleepy sink (`engine.rollSleepySink()`): requested while still
/// drowsy, asleep committed at the sink's settle point; activity during the sink cancels it into a catch-yourself.
/// Asleep: someone in view ≥ 0.7 s half-wakes; half-awake → waking when they engage, face Yanni ≥ 6 s or stay ≥ 8 s;
/// back to asleep 4 s after they leave.
///
/// **Bedtime** (schedule or manual switch). Presence is not activity. Awake and unengaged at bedtime start: a (silent)
/// yawn and drowsy → asleep over 30 s. Asleep: `tapsToWake` taps within 4 s wake (fewer stir), people half-wake / wake
/// only with `wakeOnMotionAtBedtime`. A night wake keeps bedtime on and drifts back to sleep after
/// `bedtimeAwakeMinutes` without engagement, taps or conversation.
///
/// **Force.** `forceSleep` holds Yanni asleep under bedtime tap rules, ignoring people, until `forceWake`, a tap wake
/// or the hold's end. `forceWake` wakes now, clears the manual switch and suspends only the current scheduled window.
export class LifeCycleController {
  readonly engine: FaceEngine;
  readonly store: LifeSettingsStore | null;
  clock: LifeClock;

  private _settings: LifeSettings;
  /// Settings (validated on assignment, persisted to `store` when it changes). Reading returns a copy: assign a
  /// changed copy (`life.settings = life.settings.with({…})`) so the change is applied.
  get settings(): LifeSettings { return this._settings.copy(); }
  set settings(v: LifeSettings) {
    const old = this._settings;
    this._settings = v.validated();
    if (this._settings.equals(old)) return;
    this.store?.save(this._settings);
    if (!this._settings.hasSchedule) this.scheduleSuspended = false;
    this.evaluateSchedule(true);
    this.applyTapPermission(this.engine.state.agentState);
  }

  private _calendar: LifeCalendar;
  /// Calendar for the schedule (the current zone by default). Assigning re-evaluates the schedule.
  get calendar(): LifeCalendar { return this._calendar; }
  set calendar(c: LifeCalendar) { this._calendar = c; this.evaluateSchedule(true); }

  private _timeWarp = 1;
  /// Preview time warp (×1 … ×600) for minute-scale timers. Runtime only, never persisted.
  get timeWarp(): number { return this._timeWarp; }
  set timeWarp(v: number) { this._timeWarp = Number.isFinite(v) ? Math.min(Math.max(v, 1), LifeCycleController.maxTimeWarp) : 1; }

  /// Called on every phase change (whoever caused it) and on every agent-state change the controller writes itself
  /// (idle ↔ noticing, catch-yourself, takeover: `from == to` is possible), with the reason.
  onPhaseChange: ((c: LifePhaseChange) => void) | null = null;
  private _onBedtimeChange: ((on: boolean) => void) | null = null;
  /// Called whenever `isBedtime` changes (and once when assigned, with the current value).
  get onBedtimeChange(): ((on: boolean) => void) | null { return this._onBedtimeChange; }
  set onBedtimeChange(f: ((on: boolean) => void) | null) { this._onBedtimeChange = f; f?.(this._isBedtime); }
  /// Called when the controller changed its own settings (force wake clears the manual bedtime switch), once the
  /// command has finished. Never called for assignments to `settings` from outside.
  onSettingsChange: ((s: LifeSettings) => void) | null = null;

  // MARK: Tunables (real seconds)

  static readonly maxTimeWarp = 600;
  /// Longest real time one call may advance the timers (backgrounding, a stalled display link).
  static readonly maxStep = 0.25;
  /// Someone must be in view this long before Yanni (awake) turns to notice them…
  static readonly noticeDelay = 0.3;
  /// …and gone this long before it goes back to idle.
  static readonly leaveDelay = 3;
  /// Gaps in a detection shorter than this don't end someone's presence.
  static readonly dropoutTolerance = 0.5;
  /// Asleep: someone in view this long half-wakes Yanni (one-frame false detections never do).
  static readonly halfWakeDelay = 0.7;
  /// Half-awake: someone facing Yanni this long wakes it.
  static readonly facingWakeDelay = 6;
  /// The primary person counts as facing Yanni when their `PersonTarget.facing` is at least this.
  static readonly facingThreshold = 0.5;
  /// Half-awake (daytime): someone staying this long wakes it.
  static readonly lingerWakeDelay = 8;
  /// Half-awake: back to sleep this long after they leave (or after a stirring tap with nobody around).
  static readonly backToSleepDelay = 4;
  /// Bedtime start: drowsy this long, then asleep.
  static readonly bedtimeLeadIn = 30;
  /// Force sleep from awake: drowsy this long, then asleep.
  static readonly forceLeadIn = 4;
  /// A nod-off this far in (base seconds) is already snapping open: it serves as the catch-yourself.
  static readonly nodOffSnapOpen = 1.85;
  /// Give up waiting for a catch-yourself one-shot after this long (it was rejected or cut).
  static readonly catchTimeout = 2;
  /// A requested sleepy sink that hasn't started after this long was rejected: fall asleep without it.
  static readonly sinkStartTimeout = 0.3;
  /// Commit asleep at the latest this long after requesting the sleepy sink.
  static readonly sinkTimeout = 6;
  /// Boredom builds over this many (warped) seconds idle and alone.
  static readonly boredomBuild = 300;
  /// Mood offset at full boredom (pleasure, arousal, dominance).
  static readonly boredOffset: Readonly<V3> = { x: -0.1, y: -0.3, z: 0 };
  /// The curious bump when something happens after boredom (decays with `bumpTau`).
  static readonly curiousBump: Readonly<V3> = { x: 0.05, y: 0.15, z: 0 };
  static readonly bumpTau = 2.5;
  /// Mood offset spring (critically damped, ≈ 1.5 s to settle).
  static readonly moodSpring = new SpringParams(3.2, 1);
  /// How often the schedule is evaluated (Hz).
  static readonly scheduleInterval = 1;

  /// Agent states that count as activity (and are never overridden).
  static readonly activityStates = ACTIVITY_STATES;
  /// States the life cycle takes over from after `aloneTakeoverMinutes` with nobody in view.
  static readonly takeoverStates = TAKEOVER_STATES;

  // MARK: Read-outs

  /// The current phase (derived from the engine's agent state).
  get phase(): LifePhase { return LifePhase.of(this.engine.state.agentState); }
  private _isBedtime = false;
  /// Bedtime (schedule window not suspended, or the manual switch).
  get isBedtime(): boolean { return this._isBedtime; }
  private _isScheduledBedtime = false;
  /// The schedule window is active right now (regardless of suspension).
  get isScheduledBedtime(): boolean { return this._isScheduledBedtime; }
  /// Force wake suspended the current scheduled window.
  scheduleSuspended = false;
  /// A force-sleep hold is in effect.
  isForceSleepActive = false;
  /// Woken during bedtime (or active at bedtime): drifting back after `bedtimeAwakeMinutes`.
  isNightAwake = false;
  /// Low camera rate while asleep.
  get cameraMode(): CameraMode { return this.phase === 'asleep' ? 'low' : 'normal'; }
  private _boredom = 0;
  /// 0…1 idle boredom (also applied as a mood offset when `idleMoodDrift` is on). For the emotion layer.
  get boredom(): number { return this._boredom; }
  private _lastChange: LifePhaseChange | null = null;
  /// The last phase change.
  get lastChange(): LifePhaseChange | null { return this._lastChange; }
  private _nextBedtimeBoundary: Date | null = null;
  /// Next schedule boundary (start or end) after the last evaluation, if there is a schedule.
  get nextBedtimeBoundary(): Date | null { return this._nextBedtimeBoundary; }
  private _isPresent = false;
  /// Debounced presence (someone in view, with the notice / leave delays).
  get isPresent(): boolean { return this._isPresent; }

  // MARK: Private state (fields without `private` are Swift `internal`: LifeResume and the tests use them)

  private lastMono: number | null = null;
  private nowMono = 0;
  lastAgentState: AgentState;
  reportedPhase: LifePhase;
  quiet = 0;           // warped s without activity (awake)
  drowsyElapsed = 0;   // warped s in drowsy without activity
  private leadIn: number | null = null;   // real s left of a bedtime / force lead-in
  private halfAwakeAt = 0;
  private aloneTime = 0;                  // warped s alone in a takeover state
  private lastTapMono = -Infinity;
  private lastTapCount = 0;
  private lastTapWakeCount = 0;
  private notedActivity = false;
  private lastActivity = false;
  forceSleepUntil: number | null = null;
  private lastScheduleEval = -Infinity;
  // Schedule cache: the window state only changes at a boundary (or a DST transition), so the 1 Hz check compares
  // dates (Unix ms) and skips the calendar in between.
  private scheduleValidUntil = -Infinity;
  private lastScheduleWall = -Infinity;
  private lastScheduleWallMono = -Infinity;
  private lastScheduleRecompute = -Infinity;
  /// Calendar recomputations of the schedule (tests check the steady state stays off the calendar).
  scheduleRecomputeCount = 0;

  // Presence runs.
  private lastSeen = -Infinity;
  private presentRunStart: number | null = null;
  private lastFacing = -Infinity;
  private facingRunStart: number | null = null;

  // Catch-yourself.
  private catchPending: CatchPending | null = null;
  private nodOffStart: { engineTime: number; rate: number } | null = null;

  // Sleepy sink.
  private sinkPending: SinkPending | null = null;
  /// True while falling asleep through the sleepy sink (requested, not yet committed to asleep).
  get isSinkingToSleep(): boolean { return this.sinkPending !== null; }

  // Mood drift.
  private boredomProgress = 0;
  private bump = 0;
  private moodSprings = [new Spring1(0), new Spring1(0), new Spring1(0)];
  private sentOffset: V3 = { x: 0, y: 0, z: 0 };
  private readonly moodTarget = [0, 0, 0];

  // port-note: Swift also observes the system clock / time-zone / day-change notifications and calls `timeDidChange`;
  // the browser has none, so the app calls `timeDidChange` itself (the hourly recheck and jump detection still run).
  constructor(engine: FaceEngine, o: { settings?: LifeSettings; store?: LifeSettingsStore | null; clock?: LifeClock;
    calendar?: LifeCalendar } = {}) {
    this.engine = engine;
    this._settings = (o.settings ?? new LifeSettings()).validated();
    this.store = o.store ?? null;
    this.clock = o.clock ?? LifeClock.system;
    this._calendar = o.calendar ?? LifeCalendar.current();
    this.lastAgentState = engine.state.agentState;
    this.reportedPhase = LifePhase.of(engine.state.agentState);
    this.lastTapCount = this.touch?.tapCount ?? 0;
    this.lastTapWakeCount = this.touch?.tapWakeCount ?? 0;
    this.evaluateSchedule(true);
  }

  private get touch(): TouchView | undefined {
    return this.engine.director.modifier('TouchReactions') as unknown as TouchView | undefined;
  }

  // MARK: - Commands

  /// Activity the face can't see (speech, motion, server events, foreground return).
  noteActivity(_kind: ActivityKind = 'other'): void { this.notedActivity = true; }

  /// Hold Yanni asleep (bedtime tap rules, people ignored) until `forceWake`, a tap wake or `duration` seconds.
  forceSleep(duration: number | null = null): void {
    const now = this.clock.monotonic();
    this.isForceSleepActive = true;
    this.forceSleepUntil = duration !== null && Number.isFinite(duration) && duration > 0 ? now + duration : null;
    this.catchPending = null;
    switch (this.engine.state.agentState) {
      case 'asleep':
        break;
      case 'halfAwake': case 'waking':
        this.write('asleep', 'force');
        break;
      case 'drowsy':
        this.leadIn = Math.min(this.leadIn ?? LifeCycleController.forceLeadIn, LifeCycleController.forceLeadIn);
        break;
      default:
        this.write('drowsy', 'force');
        this.leadIn = LifeCycleController.forceLeadIn;
    }
    this.applyTapPermission(this.engine.state.agentState);
  }

  /// Wake now. Clears the manual bedtime switch and suspends the current scheduled window until its end (outside the
  /// window the schedule is untouched). Ends a force-sleep hold.
  forceWake(): void {
    const before = this._settings;
    this.isForceSleepActive = false;
    this.forceSleepUntil = null;
    if (this._settings.manualBedtime) this.settings = this._settings.with({ manualBedtime: false });
    if (this._isScheduledBedtime) this.scheduleSuspended = true;
    this.evaluateSchedule(true);
    this.isNightAwake = false;
    this.quiet = 0;
    this.catchPending = null;
    this.leadIn = null;
    switch (this.engine.state.agentState) {
      case 'asleep': case 'halfAwake': case 'drowsy':
        this.write('waking', 'force');
        break;
      default:
        break;
    }
    this.applyTapPermission(this.engine.state.agentState);
    if (!this._settings.equals(before)) this.onSettingsChange?.(this.settings);
  }

  /// Re-read the wall clock now (system clock / time-zone / day changes).
  timeDidChange(): void { this.evaluateSchedule(true); }

  /// What a relaunch needs to resume (see LifeResume).
  resumeState(): LifeResumeState { return resumeState(this); }
  /// Restores a saved phase before the first frame (see LifeResume).
  restore(r: LifeResumeState, elapsed: number): void { restore(this, r, elapsed); }

  // MARK: - Per frame

  /// Call once per display frame after the engine (and voice) frame.
  afterFrame(_hostTime = 0): void {
    const C = LifeCycleController;
    const mono = this.clock.monotonic();
    this.nowMono = mono;
    const rawDt = this.lastMono !== null ? mono - this.lastMono : 0;
    this.lastMono = mono;
    const dt = Number.isFinite(rawDt) ? Math.min(Math.max(rawDt, 0), C.maxStep) : 0;
    const warped = dt * this._timeWarp;

    // 1. Schedule (≈ 1 Hz) before anything is written: the voice hears about bedtime first.
    this.evaluateSchedule(false);
    if (this.isForceSleepActive && this.forceSleepUntil !== null && mono >= this.forceSleepUntil) {
      this.isForceSleepActive = false;
      this.forceSleepUntil = null;
    }

    // port-note: Swift copies `engine.state` here; the TS state is live, but nothing below reads `s` after a write
    // except through the values captured before it.
    let s: FaceState = this.engine.state;
    const tr = this.touch;

    // 2. Taps.
    const tapCount = tr?.tapCount ?? this.lastTapCount;
    const tapWakeCount = tr?.tapWakeCount ?? this.lastTapWakeCount;
    const tapped = tapCount !== this.lastTapCount;
    const tapWoke = tapWakeCount !== this.lastTapWakeCount;
    this.lastTapCount = tapCount;
    this.lastTapWakeCount = tapWakeCount;
    if (tapped) this.lastTapMono = mono;

    // 3. Changes made by someone else since our last look.
    let externalActivity = false;
    if (s.agentState !== this.lastAgentState) {
      const from = this.lastAgentState;
      const to = s.agentState;
      let reason: LifeReason;
      if (tapWoke || (tapped && from === 'asleep' && to === 'halfAwake')) {
        reason = 'tap';
        if (tapWoke && this.isForceSleepActive) { this.isForceSleepActive = false; this.forceSleepUntil = null; }
      } else if (C.isAutoTransition(from, to)) {
        reason = 'external';
      } else {
        // Someone else (panel, conversation loop) moved Yanni: into an awake state that counts as activity; into a
        // sleepy one it is simply honoured.
        reason = 'external';
        externalActivity = LifePhase.of(to) === 'awake';
      }
      this.entered(to, from);
      this.emitIfChanged(reason);
      this.lastAgentState = to;
    }

    // 4. Presence and engagement.
    const rawPresent = s.people.length > 0;
    if (rawPresent) {
      if (this.presentRunStart === null || mono - this.lastSeen > C.dropoutTolerance) this.presentRunStart = mono;
      this.lastSeen = mono;
    }
    const presentFor = rawPresent ? mono - (this.presentRunStart ?? mono) : 0;
    const absentFor = mono - this.lastSeen;
    if (!this._isPresent && rawPresent && presentFor >= C.noticeDelay) this._isPresent = true;
    if (this._isPresent && absentFor >= C.leaveDelay) this._isPresent = false;

    const pid = s.primaryPersonID;
    const facingNow = pid !== null && s.people.some((p) => p.id === pid && p.facing >= C.facingThreshold);
    if (facingNow) {
      if (this.facingRunStart === null || mono - this.lastFacing > C.dropoutTolerance) this.facingRunStart = mono;
      this.lastFacing = mono;
    }
    const facingFor = facingNow ? mono - (this.facingRunStart ?? mono) : 0;
    const eid = s.engagedPersonID;
    const engaged = eid !== null && s.people.some((p) => p.id === eid);

    for (const st of s.startedOneShots) if (st.kind === 'nodOff') this.nodOffStart = { engineTime: st.engineTime, rate: st.rate };
    if (this.sinkPending !== null) {
      const st = s.startedOneShots.find((x) => x.kind === 'sleepySink');
      if (st) this.sinkPending.start = { engineTime: st.engineTime, rate: st.rate };
    }

    // 5. Activity (per mode).
    const strict = this._isBedtime || this.isForceSleepActive;
    const conversation = C.activityStates.has(s.agentState);
    let activity = engaged || tapped || conversation || this.notedActivity || externalActivity;
    if (!strict && this._isPresent) activity = true;
    this.notedActivity = false;
    this.lastActivity = activity;
    if (strict && activity && this.phase === 'awake') this.isNightAwake = true;

    // 6. Phase rules.
    const cur = s.agentState;
    switch (cur) {
      case 'idle': case 'noticing':
        if (activity) this.quiet = 0; else this.quiet += warped;
        if (this.isForceSleepActive) {
          this.write('drowsy', 'force');
          this.leadIn = C.forceLeadIn;
        } else if (!activity && this.quiet >= this.drowsyThreshold(strict)) {
          const bedtimeEntry = strict && !this.isNightAwake;
          if (bedtimeEntry) this.engine.send(FaceCommand.playOneShot('yawn'));
          this.write('drowsy', bedtimeEntry ? 'bedtime' : 'timer');
        } else if (this._isPresent && cur === 'idle') {
          this.write('noticing', 'person');
        } else if (!this._isPresent && cur === 'noticing' && absentFor >= C.leaveDelay) {
          this.write('idle', 'person');
        }
        break;

      case 'drowsy': {
        const sp = this.sinkPending;
        const c = this.catchPending;
        if (sp !== null) {
          if (activity && !this.isForceSleepActive) {
            this.sinkPending = null;
            this.engine.cancelEdgeAntics(true);
            this.startCatch(s);
          } else {
            let commit = mono - sp.requestedAt > C.sinkTimeout;
            if (sp.start !== null) {
              const st = sp.start;
              // f32: Swift divides in Float; the commit frame sits right on this threshold.
              const settle = st.engineTime + Math.fround(Math.fround(sleepySinkSettle) / Math.max(st.rate, Math.fround(0.01)));
              if (s.time >= settle) commit = true;
              if (!s.activeOneShots.includes('sleepySink') && s.time > st.engineTime + 0.1) commit = true;
            } else if (mono - sp.requestedAt > C.sinkStartTimeout) {
              commit = true;
            }
            if (commit) {
              this.sinkPending = null;
              this.write('asleep', sp.reason);
            }
          }
        } else if (c !== null) {
          const active = s.activeOneShots.includes(c.kind);
          if (active) c.seenActive = true;
          const done = s.completedOneShots.includes(c.kind) || (c.seenActive && !active)
            || mono - c.requestedAt > C.catchTimeout;
          if (done) {
            this.catchPending = null;
            this.quiet = 0;
            this.write(this._isPresent || engaged ? 'noticing' : 'idle', 'activity');
          }
        } else if (activity && !this.isForceSleepActive) {
          this.startCatch(s);
        } else if (this.leadIn !== null) {
          const left = this.leadIn - dt;
          this.leadIn = left;
          if (left <= 0) this.fallAsleep(this.isForceSleepActive ? 'force' : (this.isNightAwake ? 'timer' : 'bedtime'));
        } else {
          this.drowsyElapsed += warped;
          if (this.drowsyElapsed >= this._settings.minutesToAsleep * 60) {
            this.fallAsleep('timer');
          } else if (strict) {
            // Bedtime started while already drowsy: finish over the lead-in.
            this.leadIn = C.bedtimeLeadIn;
          }
        }
        break;
      }

      case 'asleep':
        if (this.presenceMayWake(strict) && rawPresent && presentFor >= C.halfWakeDelay) this.write('halfAwake', 'person');
        break;

      case 'halfAwake': {
        const mayWake = this.presenceMayWake(strict);
        if (mayWake && engaged) {
          this.write('waking', 'person');
        } else if (mayWake && facingFor >= C.facingWakeDelay) {
          this.write('waking', 'person');
        } else if (mayWake && !strict && presentFor >= C.lingerWakeDelay) {
          this.write('waking', 'person');
        } else {
          const settled = mono - this.halfAwakeAt >= C.backToSleepDelay && mono - this.lastTapMono >= C.backToSleepDelay;
          const gone = !mayWake || absentFor >= C.backToSleepDelay;
          if (settled && gone) this.write('asleep', mayWake ? 'person' : 'timer');
        }
        break;
      }

      case 'waking':
        if (this.isForceSleepActive) this.write('asleep', 'force');
        break;

      case 'sheepish': case 'confused': case 'hasMessage':
        if (rawPresent) this.aloneTime = 0; else this.aloneTime += warped;
        if (this.isForceSleepActive) {
          this.write('drowsy', 'force');
          this.leadIn = C.forceLeadIn;
        } else if (this.aloneTime >= this._settings.aloneTakeoverMinutes * 60) {
          this.write('idle', 'takeover');
        }
        break;

      default:
        // Conversation states and notForMe are never overridden (force sleep excepted).
        if (this.isForceSleepActive) {
          this.write('drowsy', 'force');
          this.leadIn = C.forceLeadIn;
        }
    }

    // 7. Mood drift.
    s = this.engine.state;
    this.updateMood(s, activity, dt, warped);

    this.applyTapPermission(this.engine.state.agentState);
    this.lastAgentState = this.engine.state.agentState;
  }

  // MARK: - Countdown

  /// What the life cycle will do next on its own, and when (real seconds). Null when nothing is pending.
  get nextTransition(): LifeCountdown | null {
    const C = LifeCycleController;
    const warp = Math.max(this._timeWarp, 1);
    const strict = this._isBedtime || this.isForceSleepActive;
    switch (this.engine.state.agentState) {
      case 'idle': case 'noticing': {
        if (this.isForceSleepActive) return { label: 'drowsy (force sleep)', seconds: 0 };
        const threshold = this.drowsyThreshold(strict);
        if (this.lastActivity) return { label: 'drowsy (held off by activity)', seconds: null };
        return { label: strict && !this.isNightAwake ? 'drowsy (bedtime)' : 'drowsy', seconds: Math.max(threshold - this.quiet, 0) / warp };
      }
      case 'drowsy':
        if (this.catchPending !== null) return { label: 'catching itself', seconds: null };
        if (this.sinkPending !== null) return { label: 'asleep (sleepy sink)', seconds: null };
        if (this.leadIn !== null) return { label: 'asleep', seconds: Math.max(this.leadIn, 0) };
        return { label: 'asleep', seconds: Math.max(this._settings.minutesToAsleep * 60 - this.drowsyElapsed, 0) / warp };
      case 'halfAwake': {
        const since = Math.min(this.nowMono - this.halfAwakeAt, this.nowMono - this.lastTapMono);
        const gone = this.nowMono - this.lastSeen;
        const wait = Math.max(C.backToSleepDelay - since, this.presenceMayWake(strict) ? C.backToSleepDelay - gone : 0, 0);
        return { label: 'back to sleep', seconds: wait };
      }
      case 'sheepish': case 'confused': case 'hasMessage':
        return { label: 'life cycle takes over', seconds: Math.max(this._settings.aloneTakeoverMinutes * 60 - this.aloneTime, 0) / warp };
      default: {
        const b = this._nextBedtimeBoundary;
        if (b !== null) {
          return {
            label: this._isScheduledBedtime ? 'bedtime ends' : 'bedtime starts',
            seconds: Math.max((b.getTime() - this.clock.now().getTime()) / 1000, 0),
          };
        }
        return null;
      }
    }
  }

  // MARK: - Internals

  private static isAutoTransition(from: AgentState, to: AgentState): boolean {
    return (from === 'waking' && to === 'noticing') || (from === 'notForMe' && to === 'idle')
      || (from === 'interrupted' && to === 'listening');
  }

  private drowsyThreshold(strict: boolean): number {
    if (strict) return this.isNightAwake ? this._settings.bedtimeAwakeMinutes * 60 : 0;
    return this._settings.minutesToDrowsy * 60;
  }

  /// People may half-wake / wake Yanni: daytime always, bedtime only with wake-on-motion, never under force sleep.
  private presenceMayWake(_strict: boolean): boolean {
    if (this.isForceSleepActive) return false;
    return !this._isBedtime || this._settings.wakeOnMotionAtBedtime;
  }

  private startCatch(s: FaceState): void {
    const n = this.nodOffStart;
    if (n !== null && s.activeOneShots.includes('nodOff')) {
      const t = Math.fround(s.time - n.engineTime) * n.rate;
      if (t >= LifeCycleController.nodOffSnapOpen) {
        this.catchPending = { kind: 'nodOff', requestedAt: this.nowMono, seenActive: true };
        return;
      }
    }
    this.engine.send(FaceCommand.playOneShot('catchSelf'));
    this.catchPending = { kind: 'catchSelf', requestedAt: this.nowMono, seenActive: false };
  }

  /// Drowsy → asleep: through the sleepy sink when the engine rolls one (never for force sleep), else at once.
  private fallAsleep(reason: LifeReason): void {
    if (reason !== 'force' && this.engine.rollSleepySink()) {
      this.engine.send(FaceCommand.playOneShot('sleepySink'));
      this.sinkPending = { requestedAt: this.nowMono, reason, start: null };
      return;
    }
    this.write('asleep', reason);
  }

  /// Writes a state (tap permission first) and reports the phase change.
  private write(state: AgentState, reason: LifeReason): void {
    const from = this.engine.state.agentState;
    if (state === from) return;
    this.applyTapPermission(state);
    this.engine.setAgentState(state);
    this.entered(state, from);
    this.emitIfChanged(reason, true);
    this.lastAgentState = state;
  }

  /// Per-state bookkeeping on entering `to` (by us or anyone else).
  entered(to: AgentState, from: AgentState): void {
    const C = LifeCycleController;
    const fromPhase = LifePhase.of(from), toPhase = LifePhase.of(to);
    if (to === 'drowsy') {
      this.drowsyElapsed = 0;
      if (from !== 'drowsy') {
        this.leadIn = (this._isBedtime || this.isForceSleepActive) ? (this.isForceSleepActive ? C.forceLeadIn : C.bedtimeLeadIn) : null;
      }
    } else {
      this.catchPending = null;
      this.sinkPending = null;
      this.leadIn = null;
    }
    if (to === 'halfAwake') this.halfAwakeAt = this.nowMono;
    if (C.takeoverStates.has(to)) this.aloneTime = 0;
    const wasSleepy = fromPhase === 'asleep' || fromPhase === 'halfAwake' || fromPhase === 'drowsy';
    const nowAwake = toPhase === 'awake' || toPhase === 'waking';
    if (wasSleepy && nowAwake) {
      this.quiet = 0;
      if (this._isBedtime) this.isNightAwake = true;
    }
  }

  /// Reports a phase change, or (`always`) an agent-state change the controller wrote itself.
  emitIfChanged(reason: LifeReason, always = false): void {
    const p = this.phase;
    if (p === this.reportedPhase && !always) return;
    const change: LifePhaseChange = { from: this.reportedPhase, to: p, reason, agentState: this.engine.state.agentState };
    this.reportedPhase = p;
    this._lastChange = change;
    this.onPhaseChange?.(change);
  }

  /// Bedtime count while asleep / half-awake under bedtime or force sleep; one tap otherwise.
  applyTapPermission(state: AgentState): void {
    const tr = this.touch;
    if (!tr) return;
    const strict = this._isBedtime || this.isForceSleepActive;
    const n = strict && (state === 'asleep' || state === 'halfAwake') ? this._settings.tapsToWake : 1;
    if (tr.tapsToWake !== n) tr.tapsToWake = n;
  }

  // MARK: Schedule

  /// Longest a cached schedule is trusted without asking the calendar (safety net for missed time changes), real s.
  static readonly scheduleRecheckInterval = 3600;
  /// Wall clock vs monotonic disagreement (s) treated as a clock change.
  static readonly wallClockJumpTolerance = 1;

  /// Steady state (≈ 1 Hz) is a few comparisons with no calendar work: the calendar runs only when forced, a cached
  /// boundary (or DST transition) was reached, the wall clock jumped against the monotonic clock, or an hour passed.
  evaluateSchedule(force: boolean): void {
    const C = LifeCycleController;
    const mono = this.clock.monotonic();
    if (!(force || mono - this.lastScheduleEval >= 1 / C.scheduleInterval)) return;
    this.lastScheduleEval = mono;
    const nowDate = this.clock.now();
    const now = nowDate.getTime();
    const drift = (now - this.lastScheduleWall) / 1000 - (mono - this.lastScheduleWallMono);
    this.lastScheduleWall = now;
    this.lastScheduleWallMono = mono;
    if (!(force || now >= this.scheduleValidUntil || !(Math.abs(drift) <= C.wallClockJumpTolerance)
      || mono - this.lastScheduleRecompute >= C.scheduleRecheckInterval)) return;
    this.lastScheduleRecompute = mono;
    this.scheduleRecomputeCount += 1;
    const st = this._settings;
    let active = false;
    if (st.hasSchedule) {
      const c = this._calendar.hourMinute(nowDate);
      active = LifeSettings.isInWindow(c.hour * 60 + c.minute, st.bedtimeStart, st.bedtimeEnd);
    }
    if (!active) this.scheduleSuspended = false;
    this._isScheduledBedtime = active;
    this._nextBedtimeBoundary = st.hasSchedule ? this.nextBoundary(nowDate) : null;
    let validUntil = this._nextBedtimeBoundary?.getTime() ?? Infinity;
    if (st.hasSchedule) {
      const dst = this._calendar.nextDaylightSavingTimeTransition(nowDate);
      if (dst !== null) validUntil = Math.min(validUntil, dst.getTime());
    }
    this.scheduleValidUntil = validUntil;
    this.setBedtime((active && !this.scheduleSuspended) || st.manualBedtime);
  }

  private nextBoundary(after: Date): Date | null {
    const next = (minute: number): Date | null => this._calendar.nextDate(after, Math.floor(minute / 60), minute % 60);
    const a = next(this._settings.bedtimeStart), b = next(this._settings.bedtimeEnd);
    if (a !== null && b !== null) return a.getTime() <= b.getTime() ? a : b;
    return a ?? b;
  }

  private setBedtime(on: boolean): void {
    if (on === this._isBedtime) return;
    this._isBedtime = on;
    this.engine.setBedtime(on);
    this.isNightAwake = false;
    if (on) {
      // Already drowsy: finish over the lead-in; awake: the next frame starts it (voice told first).
      if (this.engine.state.agentState === 'drowsy' && this.leadIn === null) this.leadIn = LifeCycleController.bedtimeLeadIn;
    } else if (this.engine.state.agentState === 'drowsy' && !this.isForceSleepActive) {
      this.leadIn = null;
    }
    this._onBedtimeChange?.(on);
    this.applyTapPermission(this.engine.state.agentState);
  }

  // MARK: Mood drift

  private updateMood(s: FaceState, activity: boolean, dt: number, warped: number): void {
    const C = LifeCycleController;
    const alone = s.people.length === 0;
    if (activity) {
      if (this._boredom > 0.15) this.bump = 1;
      this.boredomProgress = 0;
    } else if (this._settings.idleMoodDrift && s.agentState === 'idle' && alone) {
      this.boredomProgress = Math.min(this.boredomProgress + warped / C.boredomBuild, 1);
    } else if (s.agentState !== 'drowsy') {
      this.boredomProgress *= Math.exp(-dt / 20);
    }
    if (!this._settings.idleMoodDrift) { this.boredomProgress = 0; this.bump = 0; }
    const p = Math.fround(this.boredomProgress);
    this._boredom = Math.fround(p * p * (3 - 2 * p));
    this.bump *= Math.exp(-dt / C.bumpTau);
    if (this.bump < 1e-4) this.bump = 0;
    const bump = Math.fround(this.bump), b = this._boredom;
    const tx = C.boredOffset.x * b + C.curiousBump.x * bump;
    const ty = C.boredOffset.y * b + C.curiousBump.y * bump;
    const tz = C.boredOffset.z * b + C.curiousBump.z * bump;
    const target = this.moodTarget;
    target[0] = tx; target[1] = ty; target[2] = tz;

    for (let i = 0; i < 3; i++) {
      const sp = this.moodSprings[i];
      sp.step(target[i], C.moodSpring, Math.fround(dt));
      if (!(Number.isFinite(sp.value) && Number.isFinite(sp.velocity))) this.moodSprings[i] = new Spring1(target[i]);
    }
    let vx = this.moodSprings[0].value, vy = this.moodSprings[1].value, vz = this.moodSprings[2].value;
    // Settled at zero: snap exactly to zero so the effective mood is exactly the base mood again.
    if (tx === 0 && ty === 0 && tz === 0 && vx * vx + vy * vy + vz * vz < 1e-8) {
      vx = 0; vy = 0; vz = 0;
      for (let i = 0; i < 3; i++) this.moodSprings[i] = new Spring1(0);
    }
    const o = this.sentOffset;
    const dx = vx - o.x, dy = vy - o.y, dz = vz - o.z;
    const isZero = vx === 0 && vy === 0 && vz === 0;
    if (dx * dx + dy * dy + dz * dz > 1e-10 || (isZero && !(o.x === 0 && o.y === 0 && o.z === 0))) {
      this.sentOffset = { x: vx, y: vy, z: vz };
      this.engine.setMoodOffset(this.sentOffset);
    }
  }
}
