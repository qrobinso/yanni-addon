// Port of FaceEmotion/EmotionLayer.swift.
import {
  FaceCommand, makeSentenceTag, type AgentState, type FaceEngine,
  type OneShotKind, type PupilReactionReason, type SentenceTag,
} from '../engine';
import type { ExpressionMix } from '../model';
import { EmotionClassifier, MoodLabeler } from './EmotionClassifier';
import { EmotionDynamics } from './EmotionDynamics';
import { EmotionRules } from './EmotionRules';
import { EmotionSettings, PersistedMood, PersonalityPreset, type MoodStore } from './EmotionSettings';
import {
  EmotionCondition, EmotionImpulse, EmotionSnapshot, MoodReport, NudgeLook, P3, type EmotionEvent, type EmotionEventKind,
  type EmotionInput, type EmotionNudge, type GateEvent, type MoodReportTrigger, type PAD3, type RecentImpulse,
} from './EmotionTypes';
import { DecisionMapper } from './Decision/DecisionMapper';
import { DecisionMessage, type Decision } from './Decision/DecisionMessage';
import { DecisionScheduler, type ScheduledDecision } from './Decision/DecisionScheduler';
import { ExpressiveMapper, type ExpressiveDecision } from './Decision/ExpressiveMapper';

/// What the layer reads from the rest of the app each frame (the life cycle's boredom and debounced presence).
export interface EmotionEnvironment {
  /// The life cycle's idle boredom, 0…1 (mood report, mood label).
  boredom: number;
  /// Someone is present (the life cycle's debounced presence). Null: read the engine's people.
  isPresent: boolean | null;
}
export const makeEnvironment = (boredom = 0, isPresent: boolean | null = null): EmotionEnvironment => ({ boredom, isPresent });

interface Queued { impulse: EmotionImpulse; at: number; moodOnly: boolean }
interface Fallback { cueID: number; hint: OneShotKind; deadline: number }

const CONDITIONS = EmotionCondition.allCases;
const f2 = (v: number): string => v.toFixed(2);
/// Swift "%+.2f".
const sf2 = (v: number): string => (v < 0 || Object.is(v, -0) ? '-' : '+') + Math.abs(v).toFixed(2);
const absMax = (a: PAD3, b: PAD3): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));

/// The emotion layer: one persistent feeling between everything that happens and the face (emotion layer design).
///
/// Inputs: decisions from the conversation client (`receive`, `sentenceAudioStarted`, `cancelTurn`), raw impulses and
/// Home Assistant nudges (`apply`), conditions (`setCondition`), and — observed on the engine each frame — agent state
/// transitions, poke annoyance tiers and presence.
///
/// Outputs: `engine.setMood(felt)`, `engine.setEmotionExpression(mix, weight)` from the classifier, one beat per
/// decision (`playOneShot` or a `reactionCue` for the pupil reaction arbiter, with a fallback to the decision's
/// one-shot hint when the arbiter rejects the cue for rarity), gate hand-offs (`onGate`) and mood reports
/// (`onMoodReport`).
///
/// Clock: `afterFrame(hostTime)` (after the voice and the life cycle) advances by the real host-time delta, clamped to
/// 0.25 s per call, × `timeScale`, in fixed 10 ms steps; impulses land on the first step at or after their time.
/// Outputs are interpolated between the last two steps, so the face never sees stair steps.
export class EmotionLayer {
  readonly engine: FaceEngine;

  private _settings: EmotionSettings;
  get settings(): EmotionSettings { return this._settings; }
  set settings(v: EmotionSettings) { this._settings = v.validated(); this.applySettings(); }

  private _personality: PersonalityPreset;
  /// The personality (owner setting).
  get personality(): PersonalityPreset { return this._personality; }
  set personality(v: PersonalityPreset) { this._personality = v; this.updateBaseline(); }

  private _baselineOverride: PAD3 | null = null;
  /// Preview: a baseline that replaces the personality's (the inspector's mood sliders). Eased like any change.
  get baselineOverride(): PAD3 | null { return this._baselineOverride; }
  set baselineOverride(v: PAD3 | null) { this._baselineOverride = v; this.updateBaseline(); }

  private _timeScale = 1;
  /// Preview slow motion / fast forward, 0.1…10.
  get timeScale(): number { return this._timeScale; }
  set timeScale(v: number) { this._timeScale = Number.isFinite(v) ? Math.min(Math.max(v, 0.1), 10) : 1; }

  /// Preview: mood integrates and decays this many times faster (1…120), to watch minutes of mood in seconds.
  get moodTimeWarp(): number { return this.dyn.moodWarp; }
  set moodTimeWarp(v: number) { this.dyn.moodWarp = Number.isFinite(v) ? Math.min(Math.max(v, 1), 120) : 1; }

  /// Preview: hold the dynamics (outputs and reports keep going).
  isFrozen = false;

  /// Mood reports for the conversation client (sent verbatim upstream).
  onMoodReport: ((r: MoodReport) => void) | null = null;
  /// Gate outcomes for the conversation controller (which sets notForMe / confused).
  onGate: ((g: GateEvent) => void) | null = null;
  /// Every logged event (the Dev Status event log).
  onEvent: ((e: EmotionEvent) => void) | null = null;
  /// Boredom and presence from the life cycle (read once per frame).
  environment: (() => EmotionEnvironment) | null = null;

  readonly moodStore: MoodStore | null;
  /// Unix seconds (Swift: `() -> Date`).
  private readonly wallClock: () => number;

  // Core.
  private dyn: EmotionDynamics;
  private classifier = new EmotionClassifier();
  private labeler = new MoodLabeler();
  private mapper: DecisionMapper;
  private expressive = new ExpressiveMapper();
  private scheduler = new DecisionScheduler();
  private _lastExpressive: string | null = null;
  private _expressiveApplied = 0;
  /// The last considered reaction (trigger · plan) and how many played (status card).
  get lastExpressive(): string | null { return this._lastExpressive; }
  get expressiveApplied(): number { return this._expressiveApplied; }

  // Clock.
  private _layerTime = 0;
  private _realTime = 0;
  /// Layer time (seconds, × timeScale; frozen while `isFrozen`).
  get layerTime(): number { return this._layerTime; }
  /// Real time since the first frame (reports, saving).
  get realTime(): number { return this._realTime; }
  private lastHost: number | null = null;
  private prevFelt: PAD3 = P3.zero;

  // Queued impulses (applied at their step).
  private queue: Queued[] = [];
  static readonly maxImpulsesPerStep = 8;

  // Conditions: activation time per `EmotionCondition.allCases` index (null = inactive).
  private conditionSince: (number | null)[] = CONDITIONS.map(() => null);

  // Observation.
  private lastState: AgentState | null = null;
  private lastTapTier = 0;
  private wasPresent = false;
  private absentSince = 0;
  private lastEngagedAt = -Infinity;
  private ruleFiredAt = new Map<AgentState, number>();
  private sleepy = false;

  // Fallback beats.
  private fallbacks: Fallback[] = [];
  private nextCueID = 1;
  private lastPupilSerial = 0;
  /// Arbiter reasons that are about rarity (the hint may play instead).
  static readonly fallbackReasons: ReadonlySet<PupilReactionReason> = new Set<PupilReactionReason>(['globalCooldown',
    'shapeCooldown', 'habituated', 'repeatKey', 'recentCancel', 'busy', 'otherActivity', 'disabled', 'shapeDisabled']);

  // Outputs.
  private lastPushedMood: PAD3 | null = null;
  private lastMixVersion = -1;
  private currentMix: ExpressionMix | null = null;
  private lastWeight = -1;
  private lastIntensity = -1;
  private libraryVersion = Number.MIN_SAFE_INTEGER;
  private shownWeight = 0;
  private shownIntensity = 0;

  // Reports.
  private lastReportAt = 0;
  private reportLabel = '';
  private reportMoodLabel = '';
  private labelChangePending = false;
  private _lastReport: MoodReport | null = null;
  private _reportsSent = 0;
  get lastReport(): MoodReport | null { return this._lastReport; }
  get reportsSent(): number { return this._reportsSent; }
  static readonly heartbeat = 60;
  static readonly reportMinInterval = 1;

  // Status.
  private _events: EmotionEvent[] = [];
  static readonly eventCapacity = 80;
  private nextEventID = 1;
  private recentImpulses: RecentImpulse[] = [];
  private _lastDecision: string | null = null;
  private _versionMismatches = 0;
  private loggedMismatch = false;
  private _decisionsApplied = 0;
  private _decisionsDropped = 0;
  get events(): readonly EmotionEvent[] { return this._events; }
  get lastDecision(): string | null { return this._lastDecision; }
  get versionMismatches(): number { return this._versionMismatches; }
  get decisionsApplied(): number { return this._decisionsApplied; }
  get decisionsDropped(): number { return this._decisionsDropped; }

  // Persistence.
  private nextSaveAt = 30;
  static readonly saveInterval = 30;

  constructor(engine: FaceEngine, o: { settings?: EmotionSettings; personality?: PersonalityPreset;
    moodStore?: MoodStore | null; wallClock?: () => number } = {}) {
    this.engine = engine;
    this._settings = (o.settings ?? new EmotionSettings()).validated();
    this._personality = o.personality ?? 'playful';
    this.moodStore = o.moodStore ?? null;
    this.wallClock = o.wallClock ?? ((): number => Date.now() / 1000);
    this.dyn = new EmotionDynamics(this._settings.dynamics, PersonalityPreset.baseline(this._personality));
    this.mapper = new DecisionMapper(this._settings.mapper);
    this.applySettings();
    this.restoreMood();
    this.prevFelt = this.dyn.felt;
    this.labeler.reset(this.dyn.moodPoint, 0);
    this.pushOutputs(true);
  }

  // MARK: Settings

  private applySettings(): void {
    const s = this._settings;
    this.dyn.settings = s.dynamics;
    this.mapper.settings = s.mapper;
    this.expressive.settings = s.mapper.copy();
    this.scheduler.lateGrace = s.mapper.lateGrace;
    this.scheduler.pendingExpiry = s.mapper.pendingExpiry;
    this.classifier.setCandidates(this.engine.state.library, s.classifier.allowList);
    this.libraryVersion = this.engine.state.libraryVersion;
    this.engine.emotionAuthority = s.authority;
  }

  private updateBaseline(): void {
    const o = this._baselineOverride;
    this.dyn.baselineTarget = o !== null && P3.isFinite(o) ? o : PersonalityPreset.baseline(this._personality);
  }

  private get impulseScale(): number {
    return this._settings.dynamics.impulseGain * PersonalityPreset.reactivity(this._personality);
  }

  // MARK: Inputs

  /// A raw impulse or a Home Assistant nudge. Perception impulses are ignored while sleepy, at bedtime or sulking;
  /// nudges while sleepy or at bedtime.
  apply(input: EmotionInput): void {
    if (input.kind === 'impulse') this.enqueue(input.impulse);
    else this.applyNudge(input.nudge);
  }

  private applyNudge(n: EmotionNudge): void {
    const st = this.engine.state;
    if (st.isBedtime || EmotionRules.isSleepy(st.agentState)) {
      this.log('nudge', `nudge ${n.feeling} ignored (${st.isBedtime ? 'bedtime' : st.agentState})`);
      return;
    }
    const lib = st.library;
    const want = n.feeling.toLowerCase();
    const name = lib.names.find((x) => x.toLowerCase() === want);
    const pad = name === undefined ? undefined : lib.get(name)?.pad;
    if (name === undefined || pad === undefined) {
      this.log('nudge', `nudge ${n.feeling} ignored (unknown feeling)`);
      return;
    }
    const strength = Math.min(Math.max(Number.isFinite(n.strength) ? n.strength : 0.5, 0), EmotionRules.nudgeMaxStrength);
    const target = { x: Math.max(pad.p, EmotionRules.nudgeMinPleasure), y: pad.a, z: pad.d };
    if (n.look !== null) this.engine.send(FaceCommand.glance(NudgeLook.gazePoint(n.look), EmotionRules.nudgeGlanceSeconds));
    this.enqueue(EmotionImpulse.toward(target, strength, 'home', `nudge ${name}`));
    this.log('nudge', `nudge ${name} ${f2(strength)}${n.look !== null ? ` look ${n.look}` : ''}`);
  }

  /// Queues an impulse at the current layer time (gated by source).
  private enqueue(i: EmotionImpulse, moodOnly = false): void {
    if (!EmotionImpulse.isValid(i)) return;
    const st = this.engine.state;
    if (i.source === 'perception' || i.source === 'home') {
      if (st.isBedtime || EmotionRules.isSleepy(st.agentState) || (i.source === 'perception' && st.isSulking)) {
        this.log('impulse', `${i.label === '' ? i.source : i.label} ignored (${st.isBedtime ? 'bedtime' : st.isSulking ? 'sulking' : st.agentState})`);
        return;
      }
    }
    if (this.queue.length >= 64) this.queue.shift();
    this.queue.push({ impulse: i, at: this._layerTime, moodOnly });
  }

  /// A considered reaction (expressive decisions design §8): the answers map to a plan (null below the threshold: the
  /// reflex alone), the impulse queues like a perception impulse (ignored while sleepy, at bedtime or sulking), then
  /// the engine plays the plan, gated for the moment. `trigger` keys the variety memory ("gesture:wave").
  playExpressive(answers: Record<string, Record<string, number>>, trigger: string): ExpressiveDecision | null {
    const id = this.nextCueID;
    this.nextCueID += 1;
    const x = this.expressive.map(answers, trigger, 'perception', this.lastHost, id);
    if (x === null) {
      this.log('decision', `expressive ${trigger}: below threshold (reflex only)`);
      return null;
    }
    if (this.engine.state.isSulking) { this.log('decision', `expressive ${trigger}: sulking`); return null; }
    if (x.impulse !== null) this.enqueue(x.impulse);
    const played = this.engine.playExpressive(x.plan);
    if (played !== null) this._expressiveApplied += 1;
    this._lastExpressive = `${trigger} · ${x.summary}${played === null ? ' (gated)' : ''}`;
    this.log('decision', this._lastExpressive);
    return x;
  }

  /// Sets or clears a sustained condition. Clearing `voiceServicesUnreachable` gives a little relief.
  setCondition(c: EmotionCondition, active: boolean): void {
    const i = CONDITIONS.indexOf(c);
    if (i < 0) return;
    const was = this.conditionSince[i] !== null;
    if (was === active) return;
    this.conditionSince[i] = active ? this._layerTime : null;
    this.log('condition', `${c} ${active ? 'on' : 'off'}`);
    if (!active && c === 'voiceServicesUnreachable') {
      this.enqueue(EmotionImpulse.toward(EmotionRules.relief.target, EmotionRules.relief.strength, 'failure', 'relief'));
    }
  }

  isActive(c: EmotionCondition): boolean {
    const i = CONDITIONS.indexOf(c);
    return i >= 0 && this.conditionSince[i] !== null;
  }

  /// A data-channel message from the conversation client.
  receive(message: DecisionMessage): void {
    switch (message.kind) {
      case 'decision': {
        const d = message.decision;
        if (!DecisionMessage.supportedVersions.has(d.version)) { this.noteVersionMismatch(d.version); return; }
        this.setCondition('decisionModelDown', false);
        const outcome = this.scheduler.receive(d, this._layerTime, this.lastHost);
        if (outcome.kind === 'dropped') {
          this._decisionsDropped += 1;
          this.log('dropped', `${d.pass === 'utterance' ? 'A' : 'B'} ${d.turnId}${d.sentenceIndex === null ? '' : `#${d.sentenceIndex}`} dropped (${outcome.reason})`);
        } else if (outcome.kind === 'waiting') {
          this.log('decision', `B ${d.turnId}#${d.sentenceIndex ?? 0} waiting for its audio`);
        }
        this.drainDropped();
        break;
      }
      case 'gate': {
        const g = message.gate;
        if (this.scheduler.isClosed(g.turnId)) {
          this.log('dropped', `gate ${g.turnId} ignored (turn closed)`);
          return;
        }
        this.scheduler.gate(g.turnId);
        this.drainDropped();
        if (g.kind === 'notForMe') this.log('gate', `not for me (${g.turnId})`);
        else this.log('gate', `didn't understand (${g.turnId})`);
        this.onGate?.(g);
        break;
      }
      case 'decisionModelUnavailable':
        if (!this.isActive('decisionModelDown')) {
          this.enqueue(EmotionImpulse.make({ kind: 'relative', pad: EmotionRules.decisionModelDip.delta },
            EmotionRules.decisionModelDip.strength, 'failure', 'decision model down'));
        }
        this.setCondition('decisionModelDown', true);
        break;
    }
  }

  /// Decodes and receives a raw data-channel message. Returns false when it isn't the layer's.
  receiveData(data: string): boolean {
    const r = DecisionMessage.decode(data);
    switch (r.kind) {
      case 'message': this.receive(r.message); return true;
      case 'unsupportedVersion': this.noteVersionMismatch(r.version); return true;
      case 'notOurs': return false;
      case 'malformed': this.log('dropped', `malformed decision message (${r.why})`); return true;
    }
  }

  private noteVersionMismatch(v: number): void {
    this._versionMismatches += 1;
    if (!this.loggedMismatch) {
      this.loggedMismatch = true;
      this.log('dropped', `decision version ${v} not supported (ignored; logged once)`);
    }
  }

  /// The voice loop: sentence `index` of `turnId` becomes audible at `hostTime` (marker receipt + playout delay +
  /// output latency). Its tag, if any, applies then.
  sentenceAudioStarted(turnId: string, index: number, hostTime: number): void {
    const at = this.layerTimeForHost(hostTime);
    const outcomes = this.scheduler.sentenceAudioStarted(turnId, index, at, hostTime, this._layerTime);
    for (const o of outcomes) if (o.kind === 'dropped') this._decisionsDropped += 1;
    this.drainDropped();
  }

  /// The reply is voiced in Yanni's own voice (babble): only a stance the voice claimed through `sentenceTag(for:)`
  /// nods or shakes, so every nod has its answer chirp. Off (Spoken): the first confident stance of a reply plays,
  /// silently (chirps never play over speech).
  get stanceNeedsClaim(): boolean { return this.mapper.stanceNeedsClaim; }
  set stanceNeedsClaim(v: boolean) { this.mapper.stanceNeedsClaim = v; }

  /// What a Pass B tag means for the babble voice (direct Home Assistant design §7.2): its feel PAD and strength (the
  /// same numbers its impulse will use) and, when its stance is confident and the reply's one stance is still free,
  /// the answer one-shot, claimed for this sentence. Call it once per tag, before voicing its chunk.
  sentenceTag(d: Decision): SentenceTag {
    if (!DecisionMessage.supportedVersions.has(d.version)) return makeSentenceTag();
    const lib = this.engine.state.library;
    const fx = DecisionMapper.feel(d, this.mapper.settings, (name) => {
      const p = lib.get(name)?.pad;
      return p ? { x: p.p, y: p.a, z: p.d } : null;
    });
    const answer = this.mapper.claimStance(d);
    if (answer !== null) this.log('decision', `B ${d.turnId}#${d.sentenceIndex ?? 0} stance claimed → ${answer}`);
    return makeSentenceTag(fx.hasFeel ? fx.pad : null, fx.strength, answer);
  }

  /// Barge-in or a cancelled reply: the turn's pending decisions are dropped, and later ones for it too.
  cancelTurn(turnId: string): void {
    this.scheduler.cancel(turnId);
    this.drainDropped();
    this.log('dropped', `turn ${turnId} cancelled`);
  }

  /// The conversation session connected: send a mood report now.
  sessionConnected(): void { this.sendReport('connect'); }

  /// Sends a mood report now (preview).
  sendMoodReportNow(): void { this.sendReport('manual'); }

  /// Emotion, mood and conditions back to the baseline at once (preview).
  resetToBaseline(): void {
    this.dyn.baselineTarget = this._baselineOverride ?? PersonalityPreset.baseline(this._personality);
    this.dyn.reset();
    this.queue.length = 0;
    for (let i = 0; i < this.conditionSince.length; i++) this.conditionSince[i] = null;
    this.classifier.reset();
    this.prevFelt = this.dyn.felt;
    this.labeler.reset(this.dyn.moodPoint, this.environment?.().boredom ?? 0);
    this.log('impulse', 'reset to baseline');
    this.pushOutputs(true);
  }

  /// Preview: sets the slow mood (deviation from the baseline) directly, to watch it decay.
  setSlowMood(m: PAD3): void {
    this.dyn.setMood(m);
    this.log('impulse', `mood set to ${sf2(m.x)} ${sf2(m.y)} ${sf2(m.z)}`);
  }

  /// Saves the slow mood now (scene going to the background); also every 30 s.
  saveMood(): void {
    this.moodStore?.save(PersistedMood.make(this.dyn.mood, this.wallClock()));
  }

  private restoreMood(): void {
    const p = this.moodStore?.load() ?? null;
    if (p === null) return;
    const elapsed = this.wallClock() - p.savedAt;
    const m = PersistedMood.mood(p);
    if (!Number.isFinite(elapsed) || !(elapsed > -60) || !P3.isFinite(m)) return;
    this.dyn.setMood(this.dyn.decayed(m, Math.max(elapsed, 0)));
  }

  private layerTimeForHost(h: number): number {
    const last = this.lastHost;
    if (!Number.isFinite(h) || last === null) return this._layerTime;
    return this._layerTime + (h - last) * this._timeScale;
  }

  // MARK: Frame

  /// After every engine frame (after the voice and the life cycle).
  afterFrame(hostTime: number): void {
    if (!Number.isFinite(hostTime)) return;
    const last = this.lastHost;
    if (last === null) {
      this.lastHost = hostTime;
      this.observeEngine(true);
      return;
    }
    const realDt = Math.min(Math.max(hostTime - last, 0), 0.25);
    this.lastHost = hostTime;
    this._realTime += realDt;
    const st = this.engine.state;
    if (st.libraryVersion !== this.libraryVersion) {
      this.libraryVersion = st.libraryVersion;
      this.classifier.setCandidates(st.library, this._settings.classifier.allowList);
    }
    this.observeEngine(false);
    if (!this.isFrozen) this.advance(realDt * this._timeScale);
    this.pushOutputs(false);
    this.pollArbiter();
    this.updateReports();
    if (this._realTime >= this.nextSaveAt) {
      this.nextSaveAt = this._realTime + EmotionLayer.saveInterval;
      this.saveMood();
    }
  }

  /// Advances layer time by `dt` in fixed steps (also used by tests and the preview's fast-forward).
  advance(dt: number): void {
    if (!Number.isFinite(dt) || !(dt > 0)) return;
    const h = EmotionDynamics.step;
    this._layerTime += dt;
    const target = Math.floor(this._layerTime / h + 1e-7);
    while (this.dyn.steps < target) {
      const t = (this.dyn.steps + 1) * h;
      this.updateRest(t);
      this.applyDue(t);
      this.prevFelt = this.dyn.felt;
      this.dyn.step();
      if (this.dyn.steps % 5 === 0) this.classify(t);
    }
    this.scheduler.expire(this._layerTime);
    if (this.scheduler.hasDropped) this.drainDropped();
  }

  private updateRest(t: number): void {
    let r = P3.zero;
    if (!this.sleepy) {
      CONDITIONS.forEach((c, i) => {
        const since = this.conditionSince[i];
        if (since === null) return;
        r = P3.add(r, P3.scale(EmotionRules.shift(c), EmotionRules.conditionFade(t - since)));
      });
    }
    this.dyn.restTarget = r;
    this.dyn.sleepy = this.sleepy;
  }

  private applyDue(t: number): void {
    if (this.queue.length > 0) {
      let applied = 0;
      let mergedT = P3.zero, mergedS = 0, mergedMax = 0;
      let mergedRel = P3.zero;
      let i = 0;
      while (i < this.queue.length) {
        if (!(this.queue[i].at <= t + 1e-9)) { i += 1; continue; }
        const q = this.queue.splice(i, 1)[0];
        const s = q.impulse.strength * this.impulseScale;
        const tg = q.impulse.target;
        if (q.moodOnly) {
          if (tg.kind === 'absolute') this.dyn.applyToMood(tg.pad, s, EmotionRules.moodOnlyGain);
        } else if (applied < EmotionLayer.maxImpulsesPerStep) {
          this.dyn.apply(tg, s);
          applied += 1;
        } else if (tg.kind === 'absolute') {
          // Extras in one step merge (strength-weighted mean of the targets).
          mergedT = P3.add(mergedT, P3.scale(tg.pad, s)); mergedS += s; mergedMax = Math.max(mergedMax, s);
        } else {
          mergedRel = P3.add(mergedRel, P3.scale(tg.pad, s));
        }
        this.noteImpulse(q.impulse, s, t);
      }
      if (mergedS > 0) this.dyn.apply({ kind: 'absolute', pad: P3.div(mergedT, mergedS) }, mergedMax);
      if (!P3.isZero(mergedRel)) this.dyn.apply({ kind: 'relative', pad: mergedRel }, 1);
    }
    for (let sd = this.scheduler.popDue(t); sd !== null; sd = this.scheduler.popDue(t)) this.applyDecision(sd, t);
  }

  private padLookup = (name: string): PAD3 | null => {
    const p = this.engine.state.library.get(name)?.pad;
    return p ? { x: p.p, y: p.a, z: p.d } : null;
  };

  private applyDecision(sd: ScheduledDecision, t: number): void {
    const id = this.nextCueID;
    this.nextCueID += 1;
    const fx = this.mapper.map(sd.decision, t, sd.hostTime ?? this.lastHost, id, this.padLookup);
    this._decisionsApplied += 1;
    this._lastDecision = fx.summary;
    this.log('decision', fx.summary);
    // Impulse first, then the beat.
    const imp = fx.impulse;
    if (imp !== null) {
      const s = imp.strength * this.impulseScale;
      this.dyn.apply(imp.target, s);
      this.noteImpulse(imp, s, t);
      if (fx.valence < EmotionRules.somberValence) {
        this.dyn.markSomber(t);
        this.engine.markSomber();
        this.log('decision', `somber window (valence ${sf2(fx.valence)})`);
      }
    }
    const b = fx.beat;
    if (b.kind === 'oneShot') {
      const k = b.oneShot;
      const h = sd.hostTime;
      if (fx.stance !== null && h !== null && Number.isFinite(h)) {
        // The stance nod starts exactly when its sentence is heard (and its answer chirp lands on its bobs).
        this.engine.send(FaceCommand.playOneShotAt(k, h));
        this.log('beat', `stance ${k}`);
      } else {
        this.engine.send(FaceCommand.playOneShot(k));
        this.log('beat', fx.stance !== null ? `stance ${k}` : k);
      }
    } else if (b.kind === 'cue') {
      const c = b.cue;
      this.engine.send(FaceCommand.reactionCue(c));
      if (fx.hint !== null) this.fallbacks.push({ cueID: c.id, hint: fx.hint, deadline: this._realTime + 6 });
      this.log('cue', `cue ${c.kind} ${f2(c.confidence)} → arbiter`);
    }
    // Pass B's brow and glance (question set 3): a subtle plan at the sentence's audio start.
    const p = fx.plan;
    if (p !== null && this.engine.playExpressive(p) !== null) {
      this.log('beat', `sentence brow ${p.brow} · gaze ${p.gaze}`);
    }
  }

  private classify(t: number): void {
    this.classifier.update(this.classifierPoint(this.dyn.felt), this.dyn.baseline, t, this._settings.classifier);
  }

  /// What the classifier reads: the deviation of felt from the reference (baseline + `moodShare` × mood, pleasure
  /// somber-scaled like felt's), mapped by `EmotionClassifier.point`, plus the life cycle's offset.
  private classifierPoint(felt: PAD3): PAD3 {
    const d = this.dyn, share = this._settings.classifier.moodShare;
    const m = { x: d.mood.x * d.somberScale * share, y: d.mood.y * share, z: d.mood.z * share };
    return EmotionClassifier.point(d.baseline, P3.sub(P3.sub(felt, d.baseline), m), this.engine.state.moodOffset,
      this._settings.classifier);
  }

  // MARK: Observation (once per frame)

  private observeEngine(first: boolean): void {
    const st = this.engine.state;
    this.sleepy = st.isBedtime || EmotionRules.isSleepy(st.agentState);

    if (st.agentState !== this.lastState) {
      const from = this.lastState;
      this.lastState = st.agentState;
      if (!first && from !== null) this.stateChanged(from, st.agentState);
    }

    const tier = EmotionRules.tapTier(st.tapAnnoyance, st.isSulking);
    if (tier > this.lastTapTier && !first) {
      const s = EmotionRules.tapStrength(tier);
      if (s > 0) {
        this.enqueue(EmotionImpulse.make({ kind: 'relative', pad: EmotionRules.tapDelta }, s, 'touch',
          tier === 3 ? 'sulk' : tier === 2 ? 'hmph' : 'hey'));
      }
    }
    this.lastTapTier = tier;

    const present = this.environment?.().isPresent ?? st.people.length > 0;
    if (st.engagedPersonID !== null) this.lastEngagedAt = this._layerTime;
    if (present !== this.wasPresent && !first) {
      if (present) {
        if (this._layerTime - this.absentSince >= EmotionRules.arrivalAloneSeconds) {
          this.enqueue(EmotionImpulse.toward(EmotionRules.arrival.target, EmotionRules.arrival.strength, 'perception', 'arrival'));
        }
      } else {
        this.absentSince = this._layerTime;
        if (this._layerTime - this.lastEngagedAt <= EmotionRules.leaveEngagedWindow) {
          this.enqueue(EmotionImpulse.toward(EmotionRules.leaveWhileEngaged.target, EmotionRules.leaveWhileEngaged.strength,
            'perception', 'left while engaged'));
        }
      }
    }
    if (first && !present) this.absentSince = this._layerTime;
    this.wasPresent = present;
  }

  private stateChanged(from: AgentState, to: AgentState): void {
    if (from === 'listening' && to === 'thinking') this.sendReport('endOfTurn');
    if (from === 'speaking' && to === 'followUp') this.sendReport('replyEnded');
    const rule = EmotionRules.stateRule(to);
    if (rule === null) return;
    const last = this.ruleFiredAt.get(to);
    if (rule.cooldown > 0 && last !== undefined && this._layerTime - last < rule.cooldown) return;
    this.ruleFiredAt.set(to, this._layerTime);
    this.enqueue(EmotionImpulse.toward(rule.target, rule.strength, 'conversation', to), rule.moodOnly);
  }

  // MARK: Outputs

  private interpolatedFelt(): PAD3 {
    const h = EmotionDynamics.step;
    const alpha = Math.min(Math.max((this._layerTime - this.dyn.time) / h, 0), 1);
    const cur = this.dyn.felt;
    return P3.add(this.prevFelt, P3.scale(P3.sub(cur, this.prevFelt), alpha));
  }

  private pushOutputs(force: boolean): void {
    const felt = this.interpolatedFelt();
    const settled = P3.equals(felt, this.dyn.felt) && P3.equals(this.prevFelt, felt);
    const lp = this.lastPushedMood;
    if (force || lp === null || absMax(felt, lp) > 0.002 || (settled && !P3.equals(felt, lp))) {
      this.engine.setMood({ pleasure: felt.x, arousal: felt.y, dominance: felt.z });
      this.lastPushedMood = felt;
    }

    const { weight: w, intensity } = this.classifier.weightAndIntensity(this.classifierPoint(felt), this.dyn.baseline,
      this._settings.classifier);
    this.shownWeight = w;
    this.shownIntensity = intensity;
    let changed = force;
    if (this.classifier.mixVersion !== this.lastMixVersion) {
      this.lastMixVersion = this.classifier.mixVersion;
      const label = this.classifier.labelName;
      this.currentMix = this.classifier.mix(intensity);
      this.lastIntensity = intensity;
      changed = true;
      if (label !== null || this.currentMix === null) this.logLabel(label);
    } else if (this.currentMix !== null && Math.abs(intensity - this.lastIntensity) > 0.005) {
      this.currentMix.intensity = intensity;
      this.lastIntensity = intensity;
      changed = true;
    }
    if (changed || Math.abs(w - this.lastWeight) > 0.002 || (w === 0 && this.lastWeight !== 0)) {
      this.engine.setEmotionExpression(this.currentMix, this.currentMix === null ? 0 : w);
      this.lastWeight = w;
    }
  }

  private lastLoggedLabel: string | null = null;
  private logLabel(label: string | null): void {
    if (label === this.lastLoggedLabel) return;
    this.lastLoggedLabel = label;
    const r = this.classifier.runnerUpName;
    this.log('label', `label ${label ?? '—'}${r !== null ? ` + ${r}` : ''}`);
  }

  // MARK: Arbiter outcomes (fallback beats)

  private pollArbiter(): void {
    const pr = this.engine.pupilReactionEvents;
    if (pr.serial !== this.lastPupilSerial) {
      const since = this.lastPupilSerial;
      this.lastPupilSerial = pr.serial;
      for (const e of pr.events) {
        if (!(e.serial > since)) continue;
        const w = e.what;
        if (w.kind !== 'decision' || w.cue.id === 0) continue;
        const c = w.cue, reason = w.reason;
        const k = this.fallbacks.findIndex((f) => f.cueID === c.id);
        if (k < 0) {
          if (reason !== 'waiting') this.log('cue', `cue ${c.kind} ${reason === 'accepted' ? 'accepted' : `rejected (${reason})`}`);
          continue;
        }
        if (reason === 'waiting') continue;
        const fb = this.fallbacks.splice(k, 1)[0];
        if (reason === 'accepted') {
          this.log('cue', `cue ${c.kind} accepted`);
        } else if (EmotionLayer.fallbackReasons.has(reason)) {
          if (this.mapper.hintReady(fb.hint, this._layerTime)) {
            this.mapper.chargeHint(fb.hint, this._layerTime);
            this.engine.send(FaceCommand.playOneShot(fb.hint));
            this.log('beat', `cue ${c.kind} rejected (${reason}) → ${fb.hint}`);
          } else {
            this.log('cue', `cue ${c.kind} rejected (${reason}); hint cooling down`);
          }
        } else {
          this.log('cue', `cue ${c.kind} rejected (${reason}); no fallback`);
        }
      }
    }
    if (this.fallbacks.length > 0) {
      let i = 0;
      while (i < this.fallbacks.length) {
        if (this._realTime > this.fallbacks[i].deadline) this.fallbacks.splice(i, 1); else i += 1;
      }
    }
  }

  // MARK: Mood reports

  /// The emotion label for reports ("Neutral" inside the deadzone).
  get label(): string { return this.shownWeight > 0 ? this.classifier.labelName ?? 'Neutral' : 'Neutral'; }

  private updateReports(): void {
    const env = this.environment?.() ?? { boredom: 0, isPresent: null };
    this.labeler.update(P3.add(this.dyn.moodPoint, this.engine.state.moodOffset), env.boredom, this._realTime);
    const l = this.label, ml = this.labeler.label;
    if (this.reportLabel === '' && this.reportMoodLabel === '') {
      this.reportLabel = l; this.reportMoodLabel = ml;
    } else if (l !== this.reportLabel || ml !== this.reportMoodLabel) {
      this.reportLabel = l; this.reportMoodLabel = ml;
      this.labelChangePending = true;
    }
    if (this.labelChangePending && this._realTime - this.lastReportAt >= EmotionLayer.reportMinInterval) {
      this.sendReport('labelChange');
    } else if (this._realTime - this.lastReportAt >= EmotionLayer.heartbeat) {
      this.sendReport('heartbeat');
    }
  }

  /// The report for now (the conversation client sends it verbatim).
  makeReport(trigger: MoodReportTrigger): MoodReport {
    const env = this.environment?.() ?? { boredom: 0, isPresent: null };
    const conds: string[] = [];
    CONDITIONS.forEach((c, i) => { if (this.conditionSince[i] !== null) conds.push(c); });
    return new MoodReport(this.dyn.felt, this.dyn.moodPoint, this.label, this.labeler.label, env.boredom, conds, trigger);
  }

  private sendReport(trigger: MoodReportTrigger): void {
    const r = this.makeReport(trigger);
    this._lastReport = r;
    this._reportsSent += 1;
    this.lastReportAt = this._realTime;
    this.labelChangePending = false;
    this.reportLabel = r.label;
    this.reportMoodLabel = r.moodLabel;
    this.log('report', `mood report (${trigger}): ${r.label}, ${r.moodLabel}`);
    this.onMoodReport?.(r);
  }

  // MARK: Log

  private noteImpulse(i: EmotionImpulse, strength: number, t: number): void {
    if (this.recentImpulses.length >= 8) this.recentImpulses.shift();
    this.recentImpulses.push({ label: i.label === '' ? i.source : i.label, source: i.source, strength, at: t });
    if (strength >= 0.2 || i.source === 'debug') {
      this.log('impulse', `${i.label === '' ? 'impulse' : i.label} (${i.source}) ${f2(strength)}`);
    }
  }

  private drainDropped(): void {
    for (const { decision: d, turnId, reason } of this.scheduler.takeDropped()) {
      this._decisionsDropped += 1;
      const what = d === null ? turnId
        : `${d.pass === 'utterance' ? 'A' : 'B'} ${turnId}${d.sentenceIndex === null ? '' : `#${d.sentenceIndex}`}`;
      this.log('dropped', `${what} dropped (${reason})`);
    }
  }

  private log(kind: EmotionEventKind, text: string): void {
    const e: EmotionEvent = { id: this.nextEventID, time: this._layerTime, kind, text };
    this.nextEventID += 1;
    if (this._events.length >= EmotionLayer.eventCapacity) this._events.shift();
    this._events.push(e);
    this.onEvent?.(e);
  }

  // MARK: Read-outs

  /// Recent impulses, oldest first (label, source, strength, layer time).
  get impulses(): readonly RecentImpulse[] { return this.recentImpulses; }

  /// The dynamics (the live object, Swift hands out a copy: read it, don't keep or mutate it).
  get dynamics(): EmotionDynamics { return this.dyn; }
  /// The classifier (live object; read only).
  get classifierState(): EmotionClassifier { return this.classifier; }
  get felt(): PAD3 { return this.dyn.felt; }

  /// Everything the status card and the preview show (4 Hz; allocates).
  get snapshot(): EmotionSnapshot {
    const s = new EmotionSnapshot();
    const d = this.dyn, st = this.engine.state;
    s.baseline = d.baseline;
    s.felt = d.felt;
    s.mood = d.mood;
    s.emotion = d.emotion;
    s.rest = d.rest;
    s.effective = P3.add(d.felt, st.moodOffset);
    s.label = this.classifier.labelName ?? 'Neutral';
    s.runnerUp = this.classifier.runnerUpName;
    s.challenger = this.classifier.challengerName;
    s.weight = this.shownWeight;
    s.intensity = this.shownIntensity;
    s.authority = st.emotionAuthority.get(st.agentState);
    s.moodLabel = this.labeler.label;
    s.boredom = this.environment?.().boredom ?? 0;
    s.somber = d.somberScale < 0.99;
    CONDITIONS.forEach((c, i) => { if (this.conditionSince[i] !== null) s.conditions.push(c); });
    const last = this.recentImpulses[this.recentImpulses.length - 1];
    if (last) s.lastImpulse = { label: last.label, source: last.source, strength: last.strength, age: this._layerTime - last.at };
    s.lastDecision = this._lastDecision;
    s.lastReport = this._lastReport;
    s.reportsSent = this._reportsSent;
    s.versionMismatches = this._versionMismatches;
    s.decisionsApplied = this._decisionsApplied;
    s.decisionsDropped = this._decisionsDropped;
    s.time = this._layerTime;
    return s;
  }
}
