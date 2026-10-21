// Port of ConversationCore/ConversationController.swift.
// port-note: `settings` and `timings` are plain objects. Their Swift `didSet` hooks (captions off clears the bubbles;
// the mood report's heartbeat and gap) run only when a new object is assigned, not on an in-place field change.
import type { AgentState } from '../../engine/AgentState';
import { FaceCommand, type OneShotKind } from '../../engine/Commands';
import { isAnswer } from '../../engine/OneShots';
import { SyllableOnsetDetector } from '../../engine/SyllableOnsets';
import type { AgentEvent, Dismissed, ProactiveDone, ReplyVoice, SentenceStart, ServicesInfo } from '../events/AgentEvents';
import { dismissedReason } from '../events/AgentEvents';
import type { AgentIntent, ContextUpdate, MoodReportPayload } from '../events/AgentIntents';
import type { Caption, CaptionText } from '../events/Captions';
import type { LocalTurnEnd, TurnEndReason, TurnSignal } from '../turn/TurnSignal';
import { availabilityLabel, canListen, type TurnDetectionAvailability, type TurnDetectionStatus } from '../turn/TurnDetectionStatus';
import { roundHalfAway } from '../turn/TurnTunables';
import { Backoff } from './Backoff';
import {
  clampedThinkingTimeout, makeConversationSettings, makeConversationTimings, playoutGain,
  type ConversationSettings, type ConversationTimings,
} from './ConversationSettings';
import { MoodReportScheduler } from './MoodReportScheduler';
import {
  audibleHostTime, type AnnouncementDelivery, type CachedClip, type ConversationAudioControl, type ConversationFace,
  type ConversationLife, type ConversationPerception, type ConversationVoice, type DecisionWireMessage, type EmotionSink,
  type GateEvent, type GreetingClips, type PlayoutSnapshot, type ProactiveBatch, type ProactiveOutcome, type ReplyClock,
  type TransportEvent, type TransportStatus, type VoiceTransport,
} from './Ports';
import type { ConversationTurnDetection } from './TurnDetection';
import { voiceServicesEndpointEqual, type VoiceServicesEndpoint } from './VoiceServicesEndpoint';

/** The controller's own view of where the conversation is. `idle` means "no conversation": the life cycle and the
 *  announcement coordinator own idle / noticing / hasMessage then. */
export type ConversationPhase =
  | 'idle' | 'engaged' | 'listening' | 'thinking' | 'speaking' | 'followUp' | 'interrupted' | 'notForMe' | 'confused'
  | 'sheepish';

export const conversationPhases: readonly ConversationPhase[] = [
  'idle', 'engaged', 'listening', 'thinking', 'speaking', 'followUp', 'interrupted', 'notForMe', 'confused', 'sheepish',
];

/** The agent state a phase writes (null for `idle`). */
export const phaseAgentState = (p: ConversationPhase): AgentState | null => (p === 'idle' ? null : p);

/** The voice session as the controller sees it. `dormant`: voice services not set up, or voice conversation off. */
export type SessionState = 'dormant' | 'disconnected' | 'connecting' | 'ready';

/** What started the current engagement: look-to-talk, the announcement coordinator, or hold to talk / the space bar. */
export type EngagementTrigger = 'gaze' | 'proactive' | 'manual';

/** The answer to `engageManually()`. */
export type ManualEngageResult =
  /** Engaged now: the engaged chirp, then the mic opens by the unmute rule once the session is ready. */
  | { kind: 'engaged' }
  /** Yanni is asleep or still waking: engages as soon as the life cycle allows, within `manualWakeWindow`. */
  | { kind: 'pending' }
  /** A conversation is already under way: nothing changes. */
  | { kind: 'ignored'; phase: ConversationPhase }
  /** The voice loop can't converse (dormant, the owner Settings screen open, the app inactive, force sleep): why. */
  | { kind: 'unavailable'; reason: string };

/** One status-page / event-log line. Never carries transcripts, tokens or announcement text. */
export interface ConversationLogEntry { time: number; kind: string; detail: string }

/** The last user turn's timing breakdown for the status page, in seconds from the VAD's end of speech (design §8.2). */
export interface TurnTimings {
  /** How the turn ended: Smart Turn "complete" (with p) or the silence fallback. */
  reason: TurnEndReason | null;
  /** The turn's last Smart Turn inference (ms). */
  inferenceMs: number | null;
  /** End of speech → the verdict. */
  verdict: number | null;
  /** End of speech → `turn-end` sent. */
  turnEndSent: number | null;
  /** End of speech → `turn-ended` received (the transcript arrived). */
  turnEndedReceived: number | null;
  /** End of speech → the first reply marker (`sentence-start` #0). */
  firstReplyMarker: number | null;
  /** End of speech → the reply was heard (the reply clock's first frame; the speaking state). */
  heard: number | null;
  /** The reply's audio length from `reply-end` (ms), once it arrived. */
  replyAudioMs: number | null;
}

export const makeTurnTimings = (t: Partial<TurnTimings> = {}): TurnTimings => ({
  reason: null, inferenceMs: null, verdict: null, turnEndSent: null, turnEndedReceived: null, firstReplyMarker: null,
  heard: null, replyAudioMs: null, ...t,
});

/** A 4 Hz snapshot for the status card. */
export interface ConversationStatus {
  phase: ConversationPhase;
  session: SessionState;
  micOpen: boolean;
  turnId: string | null;
  servicesReachable: boolean | null;
  lastReplyLatency: number | null;
  /** Home Assistant's version, the clip voice, the decision model and the reply voice from `servicesInfo`. */
  haVersion: string | null;
  voiceId: string | null;
  decisionModel: string | null;
  replyVoice: ReplyVoice | null;
  reconnectIn: number | null;
  lastTurn: TurnTimings | null;
  /** Why the controller is dormant; null otherwise. */
  dormantReason: string | null;
  /** The turn detector's own snapshot. */
  turnDetection: TurnDetectionStatus | null;
  /** Self-trigger rejections this session. */
  selfTriggerRejections: number;
  /** Why the last dismissal closed the mic ("closing p 0.82", "local", …); never words. */
  lastDismissal: string | null;
}

type SheepishCause = 'connection' | 'turn';

const restingStates: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'noticing', 'hasMessage']);
const maxDiscarded = 8;

const availabilityEqual = (a: TurnDetectionAvailability, b: TurnDetectionAvailability | null): boolean =>
  b !== null && a.kind === b.kind && (a.kind !== 'unavailable' || (b.kind === 'unavailable' && a.reason === b.reason));

const sameContext = (a: ContextUpdate, b: ContextUpdate | null): boolean =>
  b !== null && a.quietMode === b.quietMode && a.peopleCount === b.peopleCount;

export interface ConversationControllerOptions {
  face: ConversationFace;
  life: ConversationLife;
  audio: ConversationAudioControl;
  transport: VoiceTransport;
  voice?: ConversationVoice | null;
  settings?: ConversationSettings;
  backoff?: Backoff;
  /** Host seconds (the same base as audio host times; a fake in tests). */
  clock: () => number;
}

/** Single writer of the conversation agent states (engaged, listening, thinking, speaking, followUp, interrupted,
 *  notForMe, confused, sheepish). Drives the session (connect on presence, disconnect rules), the mic gate, the
 *  greeting, barge-in, sentence timing for the emotion layer, mood reports, proactive deliveries and perception's turn
 *  pinning. Everything runs from `afterFrame(hostTime)` (call it after `life.afterFrame`) and from transport events;
 *  all time comes from the injected `clock`. */
export class ConversationController {
  // MARK: Collaborators

  readonly face: ConversationFace;
  readonly life: ConversationLife;
  readonly audio: ConversationAudioControl;
  readonly transport: VoiceTransport;
  voice: ConversationVoice | null;
  private _perception: ConversationPerception | null = null;
  get perception(): ConversationPerception | null { return this._perception; }
  set perception(p: ConversationPerception | null) { this._perception = p; this.appliedDryRun = null; this.applyDryRun(); }
  private _emotion: EmotionSink | null = null;
  get emotion(): EmotionSink | null { return this._emotion; }
  set emotion(e: EmotionSink | null) { this._emotion = e; this.hookEmotion(); }
  announcements: AnnouncementDelivery | null = null;
  greetings: GreetingClips | null = null;
  /** Played as the mic opens for listening (null = no sound). Heard together with the listening glow. */
  listenCue: string | null = null;
  /** The listen cue's level relative to the voice volume (the pop is mastered loud). */
  static readonly listenCueGain = 0.7;
  /** Until when (host seconds) the listen cue is audible: part of the echo rule, like the greeting. */
  private listenCueEnd: number | null = null;
  private _turn: ConversationTurnDetection | null = null;
  /** The device's own turn detection (VAD + Smart Turn): user turns start and end here. null only in tests that never
   *  speak. */
  get turn(): ConversationTurnDetection | null { return this._turn; }
  set turn(t: ConversationTurnDetection | null) { this._turn = t; this.hookTurn(); }
  /** Where reply progress is read (design §7.4): null = the audio engine's playout queue (Spoken); the app sets the
   *  reply renderer here for Yanni's voice. */
  replyClock: ReplyClock | null = null;
  clock: () => number;

  // MARK: Configuration

  private _timings = makeConversationTimings();
  get timings(): ConversationTimings { return this._timings; }
  set timings(t: ConversationTimings) {
    this._timings = t;
    this.mood.heartbeat = t.moodHeartbeat;
    this.mood.labelMinGap = t.moodLabelMinGap;
  }
  private _settings: ConversationSettings;
  get settings(): ConversationSettings { return this._settings; }
  set settings(s: ConversationSettings) {
    this._settings = s;
    if (!s.showCaptions) this.clearCaptions();
  }
  private _endpoint: VoiceServicesEndpoint | null = null;
  /** null = voice services not set up: dormant. */
  get endpoint(): VoiceServicesEndpoint | null { return this._endpoint; }
  set endpoint(e: VoiceServicesEndpoint | null) {
    const old = this._endpoint;
    this._endpoint = e;
    if (!voiceServicesEndpointEqual(e, old)) this.endpointChanged();
    this.applyDryRun();
  }
  /** Look-to-talk and proactive delivery closed (the owner Settings screen is open). */
  isSuppressed = false;
  private _isAppActive = true;
  /** The app is in the foreground (review L8). Going inactive ends any conversation at once (back to noticing /
   *  idle), drops the session and the microphone, without waiting for a frame. */
  get isAppActive(): boolean { return this._isAppActive; }
  set isAppActive(v: boolean) {
    const old = this._isAppActive;
    this._isAppActive = v;
    if (!(old && !v)) return;
    const now = this.clock();
    if (this._phase !== 'idle') {
      this.log('conversation', 'ended: app not active');
      this.endConversation(now, true);
    }
    this.reconnectAt = null;
    if (this.sessionUp) {
      this.log('session', 'disconnect');
      this.transport.disconnect();
      this._session = 'disconnected';
      this.mood.sessionEnded();
    }
    if (this.audioModeOn === true) this.setAudioMode(false);
    this.audioWantedAt = null;
  }

  // MARK: Outputs

  onLog: ((e: ConversationLogEntry) => void) | null = null;
  /** Reachability for the emotion layer's `voiceServicesUnreachable` condition. */
  onServicesReachabilityChange: ((reachable: boolean) => void) | null = null;
  /** The session facts (clip re-render when `voiceId` changes; status page). */
  onServicesInfo: ((info: ServicesInfo) => void) | null = null;
  /** The caption bubbles. Nothing while `settings.showCaptions` is off. Never logged. */
  onCaption: ((c: Caption) => void) | null = null;

  // MARK: Read-outs

  private _phase: ConversationPhase = 'idle';
  get phase(): ConversationPhase { return this._phase; }
  private _session: SessionState = 'dormant';
  get session(): SessionState { return this._session; }
  private _currentTurn: string | null = null;
  get currentTurn(): string | null { return this._currentTurn; }
  private _micOpen = false;
  get micOpen(): boolean { return this._micOpen; }
  private _servicesInfo: ServicesInfo | null = null;
  get servicesInfo(): ServicesInfo | null { return this._servicesInfo; }
  private _servicesReachable: boolean | null = null;
  get servicesReachable(): boolean | null { return this._servicesReachable; }
  private _lastReplyLatency: number | null = null;
  /** End of the user's speech → first heard reply audio, seconds. */
  get lastReplyLatency(): number | null { return this._lastReplyLatency; }
  private lastTurnTimings: TurnTimings | null = null;
  private _turnPerson: number | null = null;
  /** The person holding the turn (null for a proactive turn without eye contact). */
  get turnPerson(): number | null { return this._turnPerson; }
  private _proactiveInFlight: ProactiveBatch | null = null;
  /** The batch being delivered. */
  get proactiveInFlight(): ProactiveBatch | null { return this._proactiveInFlight; }
  private _engagementTrigger: EngagementTrigger | null = null;
  /** What started the current engagement (null with no conversation). */
  get engagementTrigger(): EngagementTrigger | null { return this._engagementTrigger; }
  private _lastDismissal: string | null = null;
  /** Why the last dismissal closed the mic (status page; never words). */
  get lastDismissal(): string | null { return this._lastDismissal; }

  get status(): ConversationStatus {
    const info = this._servicesInfo;
    return {
      phase: this._phase, session: this._session, micOpen: this._micOpen, turnId: this._currentTurn,
      servicesReachable: this._servicesReachable, lastReplyLatency: this._lastReplyLatency,
      haVersion: info?.haVersion ?? null, voiceId: info?.voiceId ?? null, decisionModel: info?.decisionModel ?? null,
      replyVoice: info?.replyVoice ?? null,
      reconnectIn: this.reconnectAt !== null ? Math.max(this.reconnectAt - this.clock(), 0) : null,
      lastTurn: this.lastTurnTimings !== null ? { ...this.lastTurnTimings } : null, dormantReason: this.dormantReason,
      turnDetection: this._turn?.status ?? null, selfTriggerRejections: this.sessionRejections,
      lastDismissal: this._lastDismissal,
    };
  }

  /** Whether the controller is live (configured, enabled, and able to hear turns). */
  get isActive(): boolean { return this.dormantReason === null; }

  /** Why the controller is dormant, or null when it is live. */
  get dormantReason(): string | null {
    if (this._endpoint === null) return 'voice services not set up';
    if (!this._settings.enabled) return 'voice conversation off';
    const a = this._turn?.status.availability;
    if (a !== undefined && !canListen(a)) return `turn detection ${availabilityLabel(a)}`;
    return null;
  }

  // MARK: Private state

  private lastWritten: AgentState | null = null;
  private phaseEnteredAt = 0;
  private consumedEngagement: number | null = null;
  private gazeHeldNoted: number | null = null;
  private engagedAt = 0;
  private firstEngagement = false;
  private greetingPending: CachedClip | null = null;
  private greetingEnd: number | null = null;
  private greetedText: string | null = null;
  private pendingBatch: ProactiveBatch | null = null;
  private arrivalPending = false;
  private lastPresentAt = -Infinity;
  private wasPresent = false;
  private absentSince: number | null = null;
  private lastConversationOrEngagementAt = -Infinity;
  private listenDeadline: number | null = null;
  private speechHeard = false;
  private outcomeNoted = false;
  private thinkingDeadline = Infinity;
  private epoch = 0;
  private replyHintAt: number | null = null;
  private replyStartFrame: number | null = null;
  private markers: SentenceStart[] = [];
  /** Reply pieces' words waiting for their audio (by sentence index), dropped once shown or when the turn ends. */
  private captionTexts = new Map<number, string>();
  /** A caption is (or may still be) on screen. */
  private captionShown = false;
  /** A reply piece shown before its audio length was known: `replyTiming` follows. */
  private untimedCaption: SentenceStart | null = null;
  private replyEndAt: number | null = null;
  private replyAudioMs = 0;
  private followUpDeadline = Infinity;
  private discarded: string[] = [];
  private watchKind: OneShotKind | null = null;
  private watchSeenActive = false;
  private sheepishCause: SheepishCause = 'connection';
  private sheepishAt = -Infinity;
  private mood = new MoodReportScheduler();
  private lastContext: ContextUpdate | null = null;
  /** After an `unavailable` delivery: no re-pull for this person (null = anyone) until the hold ends. */
  private proactiveHold: { person: number | null; until: number } | null = null;
  private lastContextAt = -Infinity;
  private backoff: Backoff;
  private reconnectAt: number | null = null;
  private audioModeOn: boolean | null = null;
  /** When conversation audio was last wanted (the audio-mode hold). */
  private audioWantedAt: number | null = null;
  private appliedGain: number | null = null;
  /** Syllable onsets in the playout audio: the Spoken voice's face cues (talking bounce). */
  private syllables = new SyllableOnsetDetector();
  private appliedDryRun: boolean | null = null;
  private presentationHostTime = 0;
  /** The local turn ended and thinking shows, but the transport's `turn-ended` (and its turnId) hasn't arrived. */
  private awaitingTurnId = false;
  /** A user turn is open in the detector (speech started, not yet ended or discarded). */
  private userTurnOpen = false;
  private lastTurnSignalAt = -Infinity;
  /** Reply latencies are measured from here: the VAD's end of speech (user turns) or the proactive request. */
  private latencyOrigin: number | null = null;
  private sessionRejections = 0;
  private loggedAvailability: TurnDetectionAvailability | null = null;
  /** A manual engagement waiting for Yanni to wake, until this time. */
  private manualPendingUntil: number | null = null;
  /** The warm-up keeps the session and conversation audio wanted until this time. */
  private warmUntil: number | null = null;
  /** Engaged, getting ready to listen: the glow is at its get-ready level. */
  private glowRising = false;
  /** A request plus a sign-off: the mic closes when this turn's reply has played (no follow-up window). */
  private closeAfterReply: Dismissed | null = null;
  /** After a dismissal: no look-to-talk or announcement turn until this time. */
  private dismissHoldUntil: number | null = null;
  /** The "okay!" nod's glance aside, due at this time. */
  private ackGlanceAt: number | null = null;

  // MARK: Init

  constructor(o: ConversationControllerOptions) {
    this.face = o.face;
    this.life = o.life;
    this.audio = o.audio;
    this.transport = o.transport;
    this.voice = o.voice ?? null;
    this._settings = o.settings ?? makeConversationSettings();
    this.backoff = o.backoff ?? new Backoff();
    this.clock = o.clock;
    this.transport.onEvent = (e) => this.handle(e);
  }

  // MARK: - Public inputs

  /** Call once per display frame after the engine, voice and life cycle. */
  afterFrame(hostTime: number): void {
    this.presentationHostTime = hostTime;
    this.talkingBounce(hostTime);
    const now = this.clock();
    this.applyDryRun();
    this.noteAvailability();
    if (!this.isActive) {
      this.becomeDormant(now);
      return;
    }
    if (this._session === 'dormant') this._session = this.transportSession();
    this.trackPresence(now);
    this.reconcileExternalState(now);
    if (this._phase !== 'idle' && !this.lifeAllowsConversation) this.abort(now, `life ${this.life.phase}`);
    this.checkEngagement(now);
    this.updateSession(now);
    this.runPhase(now);
    this.checkTurnWatchdog(now);
    this._turn?.setLocalSoundAudibleUntil(Math.max(this.voice?.audibleUntilHostTime ?? -Infinity,
      this.greetingEnd ?? -Infinity, this.listenCueEnd ?? -Infinity));
    this.updateOutputs(hostTime);
    this.sendPeriodic(now);
  }

  /** The emotion layer's latest mood report (wire `EmotionLayer.onMoodReport` here). */
  noteMoodReport(report: MoodReportPayload): void {
    const r = this.mood.note(report, this.clock(), this._session === 'ready');
    if (r !== null) this.send({ kind: 'mood', payload: r });
  }

  /** The announcement coordinator asks for a proactive turn (a high-priority message, audience present, no eye
   *  contact). The batch is pulled here; nothing happens when a conversation is under way or delivery isn't allowed. */
  requestProactiveTurn(): void {
    const now = this.clock();
    if (!(this.isActive && this._phase === 'idle' && this.lifeAllowsConversation && !this.isSuppressed
      && !this.dismissHeld(now) && restingStates.has(this.face.conversationAgentState))) return;
    const batch = this.announcements?.takeBatch(this.face.conversationPeopleCount, false) ?? null;
    if (batch === null) return;
    this.log('proactive', `requested turn (${batch.ids.length} message(s))`);
    this.beginEngagement(null, batch, 'proactive', now);
  }

  /** Hold to talk / the space bar: engage without gaze. From no conversation or sheepish (a retry, at once) it engages
   *  like look-to-talk with the person looking at Yanni, if any, holding the turn; it never pulls an announcement
   *  first. Asleep or still waking it waits up to `manualWakeWindow`. A conversation already under way ignores it; a
   *  dormant or closed voice loop says why. */
  engageManually(): ManualEngageResult {
    const now = this.clock();
    const why = this.dormantReason;
    if (why !== null) return { kind: 'unavailable', reason: why };
    if (this.isSuppressed) return { kind: 'unavailable', reason: 'settings open' };
    if (!this._isAppActive) return { kind: 'unavailable', reason: 'app not active' };
    if (this.life.isForceSleepActive) return { kind: 'unavailable', reason: 'force sleep' };
    if (!(this._phase === 'idle' || this._phase === 'sheepish')) {
      this.log('manual', `ignored in ${this._phase}`);
      return { kind: 'ignored', phase: this._phase };
    }
    if (this.canEngageManually) {
      this.beginEngagement(this.face.conversationEngagedID, null, 'manual', now);
      return { kind: 'engaged' };
    }
    this.manualPendingUntil = now + this._timings.manualWakeWindow;
    this.log('manual', 'waiting for Yanni to wake');
    return { kind: 'pending' };
  }

  /** A press started on the face: it may become hold to talk, so the session connect and the conversation audio
   *  switch start now. A tap or a scratch simply lets it idle out after `timings.warmUpLinger`. Nothing when the voice
   *  loop can't converse. */
  warmUp(): void {
    const now = this.clock();
    if (!(this.isActive && this.lifeAllowsConversation && !this.isSuppressed)) return;
    if (this.warmUntil === null || this.warmUntil <= now) this.log('warm-up', 'press');
    this.warmUntil = now + this._timings.warmUpLinger;
    this.updateSession(now);
  }

  /** A tap on the face while the mic is open (listening through speaking and the follow-up window): "I didn't mean
   *  to". Everything stops and Yanni goes back to noticing; the engagement stays consumed. Returns false (and does
   *  nothing) when the mic isn't open. */
  cancelByTap(): boolean {
    if (!(this._micOpen || this._phase === 'thinking' || this._phase === 'speaking')) return false;
    const now = this.clock();
    this.log('conversation', `cancelled by a tap in ${this._phase}`);
    const t = this._currentTurn;
    if (t !== null && this._phase === 'speaking' && this._session === 'ready') {
      this.send({ kind: 'cancelTurn', payload: { turnId: t, reason: 'left' } });
    }
    if (this._phase === 'speaking') this.voice?.cancel();
    this.endConversation(now, true);
    return true;
  }

  /** Manual disconnect (status page / settings "voice off"). */
  disconnectNow(): void {
    if (this._phase !== 'idle') this.endConversation(this.clock(), true);
    this.transport.disconnect();
  }

  // MARK: - Constants

  static readonly restingStates = restingStates;

  private get lifeAllowsConversation(): boolean {
    return this.life.phase === 'awake' && !this.life.isForceSleepActive && this._isAppActive;
  }

  private get reply(): ReplyClock { return this.replyClock ?? this.audio; }

  private send(i: AgentIntent): void { this.transport.send(i); }

  /** Swift `phase = …` with its `didSet`: captions only show in listening through follow-up. */
  private assignPhase(p: ConversationPhase): void {
    this._phase = p;
    if (p !== 'listening' && p !== 'thinking' && p !== 'speaking' && p !== 'followUp') this.clearCaptions();
  }

  // MARK: - Dormancy and dry run

  /** The dry run runs while dormant, and while idle when eye contact doesn't open the mic. */
  private applyDryRun(): void {
    const want = !this.isActive || (!this._settings.listenOnEyeContact && this._phase === 'idle');
    const p = this._perception;
    if (this.appliedDryRun === want || p === null) return;
    this.appliedDryRun = want;
    p.setLookToTalkDryRun(want);
  }

  private becomeDormant(now: number): void {
    if (this._phase !== 'idle') this.endConversation(now, true);
    if (this.transport.status.kind !== 'disconnected') this.transport.disconnect();
    this.setAudioMode(false);
    this.audioWantedAt = null;
    this.reconnectAt = null;
    this.warmUntil = null;
    this._session = 'dormant';
  }

  private endpointChanged(): void {
    // New services or credentials: drop the old session; the next frame reconnects if wanted.
    if (this.transport.status.kind !== 'disconnected') this.transport.disconnect();
    this.backoff.reset();
    this.reconnectAt = null;
    this._servicesInfo = null;
  }

  private transportSession(): SessionState {
    switch (this.transport.status.kind) {
      case 'disconnected':
      case 'failed': return 'disconnected';
      case 'connecting': return 'connecting';
      case 'ready': return 'ready';
    }
  }

  // MARK: - Presence

  private trackPresence(now: number): void {
    const t = this._timings;
    if (this.life.isPresent) {
      if (!this.wasPresent) {
        // Someone arrived: the unengaged-presence timer starts now; a long absence before makes it an arrival.
        this.lastConversationOrEngagementAt = now;
        if (now - this.lastPresentAt >= t.arrivalAbsence) this.arrivalPending = true;
      }
      this.lastPresentAt = now;
      this.absentSince = null;
    } else {
      if (this.absentSince === null) this.absentSince = now;
      this.arrivalPending = false;
    }
    this.wasPresent = this.life.isPresent;
    // Someone facing Yanni may be about to engage: keep (or get) the session and voice processing warm.
    if (this._phase !== 'idle' || this.face.conversationEngagedID !== null
      || (this.life.isPresent && this.face.conversationSomeoneFacing)) {
      this.lastConversationOrEngagementAt = now;
    }
    // The earliest gaze signal warms up, so the session and the audio are ready when the dwell engages. Not at
    // bedtime and not when eye contact doesn't open the mic.
    if (this._settings.listenOnEyeContact && !this.life.isBedtime && !this.isSuppressed
      && (this.face.conversationEngagedID !== null || this.face.conversationSomeoneFacing)) {
      if (this.warmUntil === null || this.warmUntil <= now) this.log('warm-up', 'facing');
      this.warmUntil = now + t.warmUpLinger;
    }
  }

  // MARK: - Session

  private get sessionUp(): boolean { return this._session === 'connecting' || this._session === 'ready'; }

  /** Connect on presence (awake, someone confirmed; review H4), stay up through a conversation, drop 20 s after
   *  everyone left, after 90 s of presence without engagement or anyone facing Yanni, on any non-awake phase, force
   *  sleep or backgrounding. At bedtime only an engagement connects. */
  wantsSession(now: number): boolean {
    if (!(this.isActive && this.lifeAllowsConversation)) return false;
    if (this._phase !== 'idle') return true;
    if (this.warmUntil !== null && now < this.warmUntil) return true;
    if (this.life.isBedtime) return false;
    if (this.life.isPresent) return now - this.lastConversationOrEngagementAt < this._timings.unengagedDisconnect;
    if (this.absentSince !== null && now - this.absentSince < this._timings.absentDisconnect) return this.sessionUp;
    return false;
  }

  private updateSession(now: number): void {
    const want = this.wantsSession(now);
    if (want || this.sessionUp) this.audioWantedAt = now;
    this.setAudioMode(this.audioWantedAt !== null ? now - this.audioWantedAt < this._timings.audioModeHold : false);
    if (want) {
      const ep = this._endpoint;
      if (this._session === 'disconnected' && ep !== null && now >= (this.reconnectAt ?? -Infinity)) {
        this.reconnectAt = null;
        this._session = 'connecting';
        this.log('session', 'connect');
        this.transport.connect(ep);
      }
    } else {
      this.reconnectAt = null;
      if (this.sessionUp) {
        this.log('session', 'disconnect');
        this.transport.disconnect();
        this._session = 'disconnected';
        this.mood.sessionEnded();
      }
    }
  }

  private setAudioMode(on: boolean): void {
    if (this.audioModeOn === on) return;
    this.audioModeOn = on;
    this.audio.setConversationMode(on);
    if (on) this._turn?.prepare();   // load and warm the turn models at Noticing, long before the first pause
  }

  private setReachable(r: boolean): void {
    if (this._servicesReachable === r) return;
    this._servicesReachable = r;
    this.onServicesReachabilityChange?.(r);
  }

  private sessionStatusChanged(s: TransportStatus, now: number): void {
    if (!this.isActive) return;
    switch (s.kind) {
      case 'connecting':
        this._session = 'connecting';
        break;
      case 'ready': {
        this._session = 'ready';
        this.backoff.reset();
        this.reconnectAt = null;
        this.setReachable(true);
        this.sessionRejections = 0;
        this.log('session', 'ready');
        const r = this.mood.trigger('connect', now, true);
        if (r !== null) this.send({ kind: 'mood', payload: r });
        this.sendContext(now, true);
        break;
      }
      case 'disconnected':
      case 'failed': {
        const wasUp = this.sessionUp;
        this._session = 'disconnected';
        this.mood.sessionEnded();
        if (s.kind === 'failed') this.log('session', `failed: ${s.reason}`);
        else if (wasUp) this.log('session', 'dropped');
        if (this.wantsSession(now)) {
          const d = this.backoff.nextDelay();
          this.reconnectAt = now + d;
          this.setReachable(false);
          this.log('session', `reconnect in ${d.toFixed(1)} s`);
        }
        switch (this._phase) {
          case 'listening': case 'thinking': case 'speaking': case 'followUp': case 'interrupted': case 'notForMe':
          case 'confused':
            this.enterSheepish('connection', now);
            break;
          default:
            break;
        }
        if (this._micOpen) this.closeMic();
        break;
      }
    }
  }

  // MARK: - Transport events

  private handle(e: TransportEvent): void {
    const now = this.clock();
    switch (e.kind) {
      case 'status':
        this.sessionStatusChanged(e.status, now);
        break;
      case 'agent':
        if (!this.isActive) return;
        this.handleAgent(e.event, now);
        break;
      case 'caption':
        if (!this.isActive) return;
        this.handleCaption(e.caption);
        break;
    }
  }

  // MARK: - Captions (caption bubbles design)

  private handleCaption(c: CaptionText): void {
    if (!this._settings.showCaptions || this.onCaption === null) return;
    switch (c.kind) {
      case 'partial':
        // Only for the turn being heard (the person talking, or the recogniser finishing it before `turn-ended`).
        if (!((this.userTurnOpen || (this._phase === 'thinking' && this.awaitingTurnId)) && this._proactiveInFlight === null)) return;
        this.captionShown = true;
        this.onCaption({ kind: 'transcriptPartial', text: c.text });
        break;
      case 'transcript':
        // Speaking too: the reply's audio can start before this arrives (it still always arrives before the reply's
        // own captions, which follow it on the same stream).
        if (!(c.turnId === this._currentTurn && (this._phase === 'thinking' || this._phase === 'speaking')
          && !this.discarded.includes(c.turnId))) return;
        this.captionShown = true;
        this.onCaption({ kind: 'transcript', turnId: c.turnId, text: c.text });
        break;
      case 'sentence':
        if (!(c.turnId === this._currentTurn && (this._phase === 'thinking' || this._phase === 'speaking'))) return;
        this.captionTexts.set(c.index, c.text);
        break;
    }
  }

  /** The person started speaking to Yanni: the "you" bubble shows at once (a listening placeholder until words come). */
  private captionSpeechStarted(): void {
    if (!(this._settings.showCaptions && this.onCaption !== null && this._session === 'ready'
      && this._proactiveInFlight === null)) return;
    this.captionShown = true;
    this.onCaption({ kind: 'transcriptPartial', text: '' });
  }

  /** A shown reply piece without its audio length gets it once the next piece's offset or the reply's length is known. */
  private timeUntimedCaption(nextOffsetMs: number): void {
    const u = this.untimedCaption;
    const t = this._currentTurn;
    if (u === null || t === null) return;
    this.untimedCaption = null;
    if (!this.captionShown) return;
    this.onCaption?.({ kind: 'replyTiming', turnId: t, index: u.sentenceIndex, audioSeconds: Math.max(nextOffsetMs - u.offsetMs, 0) / 1000 });
  }

  private clearCaptions(): void {
    this.untimedCaption = null;
    this.captionTexts.clear();
    if (!this.captionShown) return;
    this.captionShown = false;
    this.onCaption?.({ kind: 'cleared' });
  }

  private discard(turn: string): void {
    if (this.discarded.includes(turn)) return;
    this.discarded.push(turn);
    if (this.discarded.length > maxDiscarded) this.discarded.splice(0, this.discarded.length - maxDiscarded);
  }

  private handleAgent(e: AgentEvent, now: number): void {
    const turnId = e.kind === 'servicesInfo' || e.kind === 'decisionModelUnavailable' ? null : e.payload.turnId;
    if (turnId !== null && this.discarded.includes(turnId)) return;
    switch (e.kind) {
      case 'servicesInfo':
        this._servicesInfo = e.payload;
        this.onServicesInfo?.(e.payload);
        break;
      case 'turnStarted':
        if (this._phase === 'thinking' && this._proactiveInFlight !== null && this._currentTurn === null
          && e.payload.kind === 'proactive') {
          this._currentTurn = e.payload.turnId;
        }
        break;
      case 'turnEnded':
        this.transportTurnEnded(e.payload.turnId, now);
        break;
      case 'decision':
        this.forward({ kind: 'decision', payload: e.payload });
        break;
      case 'notForMe':
        this.forward({ kind: 'notForMe', payload: e.payload });
        break;
      case 'dismissed': {
        const d = e.payload;
        // A sign-off may land after the reply's audio already started (the audio doesn't wait for events).
        if (!((this._phase === 'thinking' || (d.afterReply && this._phase === 'speaking')) && d.turnId === this._currentTurn
          && this._proactiveInFlight === null)) return;
        if (d.afterReply) {
          this.closeAfterReply = d;
          this.log('conversation', `closing after the reply (${dismissedReason(d)})`);
        } else {
          this.dismiss(d, now);
        }
        break;
      }
      case 'didNotUnderstand':
        this.forward({ kind: 'didNotUnderstand', payload: e.payload });
        break;
      case 'decisionModelUnavailable':
        this.forward({ kind: 'decisionModelUnavailable', payload: e.payload });
        break;
      case 'sentenceStart': {
        const s = e.payload;
        if (!(s.turnId === this._currentTurn && (this._phase === 'thinking' || this._phase === 'speaking'))) return;
        // Emitted in order, before their audio: the marker list is a FIFO.
        const last = this.markers.length > 0 ? this.markers[this.markers.length - 1] : null;
        console.assert(last === null || (last.sentenceIndex < s.sentenceIndex && last.offsetMs <= s.offsetMs),
          'sentence-start out of order');
        this.markers.push(s);
        const u = this.untimedCaption;
        if (u !== null && s.sentenceIndex > u.sentenceIndex) this.timeUntimedCaption(s.offsetMs);
        if (s.sentenceIndex === 0 && this._phase === 'thinking' && this.replyHintAt === null) this.replyHintAt = now;
        break;
      }
      case 'replyEnd': {
        const r = e.payload;
        if (!(r.turnId === this._currentTurn && (this._phase === 'thinking' || this._phase === 'speaking'))) return;
        this.replyEndAt = now;
        this.replyAudioMs = r.audioMs;
        if (this.untimedCaption !== null) this.timeUntimedCaption(r.audioMs);
        if (this.replyStartFrame !== null && this.lastTurnTimings !== null) this.lastTurnTimings.replyAudioMs = r.audioMs;
        break;
      }
      case 'interrupted':
        // The acknowledgement of a local barge-in (already handled): idempotent.
        if (e.payload.turnId !== this._currentTurn) return;
        if (this._phase === 'speaking') this.bargeIn(now, 'transport interrupted');
        break;
      case 'proactiveDone':
        this.proactiveDone(e.payload, now);
        break;
      case 'error': {
        const err = e.payload;
        this.log('agent', `error ${err.code}` + (err.detail !== null ? ` (${err.detail})` : ''));
        if ((err.turnId === null || err.turnId === this._currentTurn) && (this._phase === 'thinking' || this._phase === 'speaking')) {
          this.enterSheepish('turn', now);
        }
        break;
      }
    }
  }

  // MARK: - Emotion and the gate (review H1)

  private hookEmotion(): void {
    if (this._emotion !== null) this._emotion.onGate = (g) => this.handleGate(g);
  }

  private forward(m: DecisionWireMessage): void {
    if (this._emotion !== null) {
      this._emotion.receive(m);
      return;
    }
    // No emotion layer attached: act on the gate directly (the face still has to show it).
    if (m.kind === 'notForMe') this.handleGate({ kind: 'notForMe', turnId: m.payload.turnId });
    else if (m.kind === 'didNotUnderstand') this.handleGate({ kind: 'didNotUnderstand', turnId: m.payload.turnId });
  }

  private handleGate(g: GateEvent): void {
    const now = this.clock();
    if (!(this._phase === 'thinking' && g.turnId === this._currentTurn && this._proactiveInFlight === null)) return;
    if (g.kind === 'notForMe') {
      this.noteOutcome(false);
      this.setPhase('notForMe', now);
      this.watch('lookAway');
    } else {
      this.noteOutcome(true);
      this.setPhase('confused', now);
      this.watch('confusedShake');
    }
    if (this._currentTurn !== null) this.discard(this._currentTurn);
    this._currentTurn = null;
  }

  // MARK: - Engagement

  private checkEngagement(now: number): void {
    const until = this.manualPendingUntil;
    if (until !== null) {
      if (now >= until || this.isSuppressed || this.life.isForceSleepActive) {
        this.manualPendingUntil = null;
        this.log('manual', 'lapsed');
      } else if (this.canEngageManually) {
        this.beginEngagement(this.face.conversationEngagedID, null, 'manual', now);
        return;
      }
    }
    const id = this.face.conversationEngagedID;
    if (id === null) { this.consumedEngagement = null; this.gazeHeldNoted = null; }
    if (id === null || id === this.consumedEngagement) return;
    if (this.dismissHeld(now) && this._phase === 'idle') {
      // Told to go away: this look is used up, so the hold ending doesn't open the mic on someone still looking.
      this.consumedEngagement = id;
      this.log('gaze', `person ${id} held: dismissed recently`);
      return;
    }
    if (!(this._settings.listenOnEyeContact && this.canEngage(now))) { this.noteGazeHeld(id); return; }
    this.beginEngagement(id, null, 'gaze', now);
  }

  /** Perception engaged someone but no conversation starts: says why, once per engagement (Talk log). */
  private noteGazeHeld(id: number): void {
    if (this.gazeHeldNoted === id) return;
    this.gazeHeldNoted = id;
    let why: string;
    if (!this._settings.listenOnEyeContact) why = "eye contact doesn't start listening";
    else if (!this._isAppActive) why = 'app not active';
    else if (this.life.isForceSleepActive) why = 'force sleep';
    else if (this.life.phase !== 'awake') why = `life ${this.life.phase}`;
    else if (this.isSuppressed) why = 'settings open';
    else if (this._phase === 'idle') why = `face ${this.face.conversationAgentState}`;
    else why = this._phase;
    this.log('gaze', `person ${id} held: ${why}`);
  }

  /** Engaged entries: from idle / noticing / hasMessage, followUp (another person takes the turn) and sheepish (a
   *  retry, at most once per window unless the session is back; review L9). */
  private canEngage(now: number): boolean {
    if (!(this.lifeAllowsConversation && !this.isSuppressed)) return false;
    switch (this._phase) {
      case 'idle': return restingStates.has(this.face.conversationAgentState);
      case 'followUp': return true;
      case 'sheepish': return this._session === 'ready' || now - this.sheepishAt >= this._timings.sheepishRetryWindow;
      default: return false;
    }
  }

  /** A manual engagement may start: awake, nothing closed, and no conversation (a resting face, or the dry run's
   *  engaged look) or sheepish. */
  private get canEngageManually(): boolean {
    if (!(this.lifeAllowsConversation && !this.isSuppressed)) return false;
    const s = this.face.conversationAgentState;
    return this._phase === 'sheepish' || (this._phase === 'idle' && (restingStates.has(s) || s === 'engaged'));
  }

  private beginEngagement(person: number | null, batch: ProactiveBatch | null, trigger: EngagementTrigger, now: number): void {
    this.manualPendingUntil = null;
    this.dismissHoldUntil = null;   // asked to talk again (hold to talk): the dismissal is over
    this.ackGlanceAt = null;
    if (person !== null) this.consumedEngagement = person;
    if (this._phase === 'followUp') this.endConversation(now, false, false);
    this._engagementTrigger = trigger;
    this._turnPerson = person;
    this.resetTurn();
    this.engagedAt = now;
    this.outcomeNoted = trigger === 'manual';   // asked by touch: never a look-to-talk outcome for perception
    this.speechHeard = false;
    this.firstEngagement = this.arrivalPending;
    this.greetingPending = null;
    this.greetingEnd = null;
    this.greetedText = null;
    const s = this._settings;
    if (this.arrivalPending && s.greetingEnabled && !s.soundsOff && !s.quietMode && !this.life.isBedtime) {
      this.greetingPending = this.greetings?.nextGreeting() ?? null;
    }
    this.arrivalPending = false;
    this.pendingBatch = batch;
    // Someone who asked to talk talks first: a manual engagement never opens with an announcement.
    if (this.pendingBatch === null && trigger !== 'manual' && !this.isSuppressed && !this.proactiveHeld(person, now)) {
      this.pendingBatch = this.announcements?.takeBatch(this.face.conversationPeopleCount, person !== null) ?? null;
    }
    this.log('engaged', trigger + (person !== null ? `, person ${person}` : ''));
    this.assignPhase('engaged');
    this.applyDryRun();   // the dry run hands the face over before the engaged state is written
    this.setPhase('engaged', now);
    // Getting ready to listen: the glow rises now and reaches full when the mic opens.
    this.glowRising = true;
    this.face.setListeningGlow(this._timings.getReadyGlow);
    this.updateSession(now);   // the session and the audio switch start now, not on the next frame
  }

  // MARK: - Per-phase work

  private runPhase(now: number): void {
    const t = this._timings;
    switch (this._phase) {
      case 'idle':
        if (this.ackGlanceAt !== null && now >= this.ackGlanceAt) {
          this.ackGlanceAt = null;
          this.face.send(FaceCommand.glance({ x: Math.random() < 0.5 ? 0.6 : -0.6, y: 0.2 }, 0.9));
        }
        break;
      case 'engaged':
        this.runEngaged(now);
        break;
      case 'listening':
        if (this.listenDeadline !== null && now >= this.listenDeadline) {
          this.log('listening', this.speechHeard ? 'gave up after speech' : 'no speech');
          this.endConversation(now, false);
        }
        break;
      case 'thinking':
        this.runThinking(now);
        break;
      case 'speaking':
        this.runSpeaking(now);
        break;
      case 'followUp':
        if (now >= this.followUpDeadline) this.followUpEnded(now);
        break;
      case 'interrupted':
        if (now - this.phaseEnteredAt >= t.interruptedFallback) this.enterListening(true, now);
        break;
      case 'notForMe':
        if (this.watchDone() || now - this.phaseEnteredAt >= t.notForMeFallback) this.notForMeDone(now);
        break;
      case 'confused':
        if (this.watchDone() || now - this.phaseEnteredAt >= t.confusedFallback) this.enterListening(false, now);
        break;
      case 'sheepish':
        if (this.sheepishCause === 'connection') {
          if (this._session === 'ready') this.exitSheepish(now);
        } else if (now - this.sheepishAt >= t.sheepishTurnRecovery) {
          this.exitSheepish(now);
        }
        break;
    }
  }

  private get gain(): number { return playoutGain(this._settings, this.life.isBedtime); }

  private runEngaged(now: number): void {
    const t = this._timings;
    // The greeting follows the engaged chirp (planned by the director on the frame after the state entry).
    const g = this.greetingPending;
    if (g !== null && now - this.engagedAt >= 0.06) {
      this.greetingPending = null;
      const chirpEnd = (this.voice?.audibleUntilHostTime ?? 0) - 0.15;
      const start = Math.max(now, chirpEnd + t.greetingGap);
      const end = this.audio.playClip(g.url, start, this.gain);
      if (end !== null) {
        this.greetingEnd = end;
        this.greetedText = g.text;
        this.log('greeting', 'playing');
      }
    }
    if (this._session === 'ready' && this.audio.isAudioReady) {
      if (this.greetingPending !== null) return;
      const minDelay = this.life.isBedtime ? t.unmuteMinDelayNight : t.unmuteMinDelay;
      const audibleEnd = Math.max(this.voice?.audibleUntilHostTime ?? -Infinity, this.greetingEnd ?? -Infinity);
      const unmuteAt = Math.max(this.engagedAt + minDelay, audibleEnd + t.unmuteAfterAudible);
      if (now >= unmuteAt) this.openMic(now);
    } else if (now - this.engagedAt >= t.engagedConnectTimeout) {
      this.log('engaged', this._session === 'ready' ? 'audio not ready' : 'no session');
      this.enterSheepish('connection', now);
    }
  }

  private openMic(now: number): void {
    this._micOpen = true;
    this.glowRising = false;
    this.log('mic', `open ${((now - this.engagedAt) * 1000).toFixed(0)} ms after engaged`);
    if (this.listenCue !== null && !this._settings.soundsOff) {
      this.listenCueEnd = this.audio.playClip(this.listenCue, now, this.gain * ConversationController.listenCueGain);
    }
    this.face.setListeningGlow(1);
    this.transport.setMicEnabled(true);
    this.audio.setCaptureEnabled(true);
    this.userTurnOpen = false;
    this._turn?.setListening(true);
    this.send({ kind: 'engage', payload: { personCount: Math.max(this.face.conversationPeopleCount, 1), firstEngagement: this.firstEngagement } });
    if (this.greetedText !== null) this.send({ kind: 'greeted', payload: { text: this.greetedText } });
    if (this._turnPerson !== null) this._perception?.pinTurn(this._turnPerson);
    const b = this.pendingBatch;
    if (b !== null) {
      this.pendingBatch = null;
      this.startProactive(b, now);
    } else {
      this.enterListening(false, now);
    }
  }

  private closeMic(): void {
    if (this.glowRising) {
      this.glowRising = false;
      this.face.setListeningGlow(0);
    }
    if (!this._micOpen) return;
    this._micOpen = false;
    this.face.setListeningGlow(0);
    this.face.setListeningVoice(0);
    this.transport.setMicEnabled(false);
    this.audio.setCaptureEnabled(false);
    // A turn in progress is discarded by the detector: no turn-end, and the transport drops the ASR audio.
    this.userTurnOpen = false;
    this._turn?.setListening(false);
  }

  private enterListening(speech: boolean, now: number): void {
    this.speechHeard = this.speechHeard || speech;
    this.listenDeadline = speech ? null : now + this._timings.listenTimeout;
    this.setPhase('listening', now);
  }

  // MARK: - Turn detection (on-device turn detection design §8)

  /** A signal from the device's turn detector, handled at once (like a transport event, not on the next frame). */
  turnSignal(s: TurnSignal): void {
    const now = this.clock();
    if (!this.isActive) return;
    switch (s.kind) {
      case 'speechStarted':
        this.localSpeechStarted(s.at, s.echoRule, now);
        break;
      case 'pause': {
        this.lastTurnSignalAt = now;
        const p = s.pause;
        if (p.probability !== null) {
          this.log('turn', `pause → incomplete p ${p.probability.toFixed(2)}, ${(p.inferenceMs ?? 0).toFixed(0)} ms`);
        } else {
          this.log('turn', 'pause → Smart Turn failed or timed out (fallback still ends the turn)');
        }
        break;
      }
      case 'turnEnded':
        this.localTurnEnded(s.end, now);
        break;
      case 'turnDiscarded':
        this.userTurnOpen = false;
        if (this._phase === 'listening') this.clearCaptions();
        this.face.setListeningVoice(0);
        this.log('turn', 'mic closed mid-utterance (discarded, no turn-end)');
        break;
      case 'selfTriggerRejected':
        this.sessionRejections += 1;
        this.log('turn', `self-trigger rejected (peak p ${s.peak.toFixed(2)})`);
        break;
      case 'unavailable':
        this.log('turn', `turn detection unavailable: ${s.reason}`);
        break;
    }
  }

  private hookTurn(): void {
    if (this._turn !== null) this._turn.onSignal = (s) => this.turnSignal(s);
    this.loggedAvailability = null;
  }

  private noteAvailability(): void {
    const a = this._turn?.status.availability;
    if (a === undefined || availabilityEqual(a, this.loggedAvailability)) return;
    this.loggedAvailability = a;
    this.log('turn', `turn detection ${availabilityLabel(a)}`);
  }

  /** Speech start (design §8.2, §9): the face reacts first, then the transport hears `speech-start`. */
  private localSpeechStarted(onset: number, echoRule: boolean, now: number): void {
    if (!this._micOpen) return;
    this.userTurnOpen = true;
    this.face.setListeningVoice(1);
    this.lastTurnSignalAt = now;
    this.life.noteActivity('speech');
    const ms = `${((now - onset) * 1000).toFixed(0)} ms after onset${echoRule ? ', echo rule' : ''}`;
    switch (this._phase) {
      case 'listening':
        this.speechHeard = true;
        this.listenDeadline = null;
        this.log('turn', `speech start (${ms})`);
        break;
      case 'followUp':
        this.log('turn', `speech start (${ms})`);
        this.enterListening(true, now);
        break;
      case 'thinking':
        // The user kept talking: the turn is void, back to listening. The transport voids it too.
        this.log('turn', `speech start while thinking: turn void (${ms})`);
        if (this._currentTurn !== null) {
          this._emotion?.cancelTurn(this._currentTurn);
          this.discard(this._currentTurn);
        }
        this._currentTurn = null;
        this.awaitingTurnId = false;
        if (this._proactiveInFlight !== null) this.finishProactive('interrupted');
        this.enterListening(true, now);
        break;
      case 'speaking':
        this.log('turn', `speech start: barge-in (${ms})`);
        this.bargeIn(now, 'local');
        break;
      case 'interrupted':
      case 'notForMe':
      case 'confused':
        this.speechHeard = true;
        this.log('turn', `speech start (${ms})`);
        break;
      case 'idle':
      case 'engaged':
      case 'sheepish':
        return;
    }
    this.captionSpeechStarted();
    if (this._session === 'ready') this.send({ kind: 'speechStart', payload: { onsetHostTime: onset } });
  }

  /** The local turn end: send `turn-end`, then thinking at once (the turnId follows with `turn-ended`). */
  private localTurnEnded(e: LocalTurnEnd, now: number): void {
    this.userTurnOpen = false;
    this.face.setListeningVoice(0);
    this.lastTurnSignalAt = now;
    if (!this._micOpen) return;
    switch (this._phase) {
      case 'listening': case 'followUp': case 'interrupted': case 'notForMe': case 'confused':
        break;
      default:
        this.log('turn', `turn end ignored in ${this._phase}`);
        return;
    }
    if (e.reason.kind === 'complete') {
      this.log('turn', `turn end (complete p ${e.reason.probability.toFixed(2)}, ${(e.inferenceMs ?? 0).toFixed(0)} ms)`);
    } else {
      this.log('turn', `turn end (fallback ${(e.verdictAt - e.speechEnd).toFixed(1)} s)`);
    }
    if (this._session === 'ready') this.send({ kind: 'turnEnd', payload: { hostTime: e.verdictAt } });
    this.log('turn', 'turn-end sent');
    this.lastTurnTimings = makeTurnTimings({
      reason: e.reason, inferenceMs: e.inferenceMs, verdict: e.verdictAt - e.speechEnd, turnEndSent: now - e.speechEnd,
    });
    this.enterThinking(e.speechEnd, now);
  }

  /** The transport's `turn-ended`: adopted when thinking is waiting for it, otherwise stale → `cancel-turn
   *  {superseded}`. The local transport never emits one for a turn it voided, so this rule is defensive. */
  private transportTurnEnded(turnId: string, now: number): void {
    if (this._phase === 'thinking' && this.awaitingTurnId && this._proactiveInFlight === null) {
      this.awaitingTurnId = false;
      this._currentTurn = turnId;
      if (this.latencyOrigin !== null && this.lastTurnTimings !== null) this.lastTurnTimings.turnEndedReceived = now - this.latencyOrigin;
      this.log('turn', 'turn-ended adopted');
      return;
    }
    this.discard(turnId);
    if (this._session === 'ready') this.send({ kind: 'cancelTurn', payload: { turnId, reason: 'superseded' } });
    this.log('turn', 'stale turn-ended → cancel-turn');
  }

  /** No turn signal for `turnWatchdog` while a user turn is open (detector stalled) → back to noticing, mic gated,
   *  no turn-end. */
  private checkTurnWatchdog(now: number): void {
    if (!(this._micOpen && this.userTurnOpen && this._phase !== 'idle' && now - this.lastTurnSignalAt >= this._timings.turnWatchdog)) return;
    this.log('turn', `watchdog: no turn signal for ${Math.trunc(this._timings.turnWatchdog)} s`);
    this.endConversation(now, false);
  }

  private resetTurn(): void {
    this.closeAfterReply = null;
    this.untimedCaption = null;
    this._currentTurn = null;
    this.markers.length = 0;
    this.replyEndAt = null;
    this.replyAudioMs = 0;
    this.replyHintAt = null;
    this.replyStartFrame = null;
    this.listenDeadline = null;
    this.awaitingTurnId = false;
  }

  private armReply(now: number): void {
    this.epoch = (this.epoch + 1) >>> 0;
    this.reply.armReplyStart(this.epoch);
    this.latencyOrigin = now;
    this.thinkingDeadline = now + clampedThinkingTimeout(this._settings);
  }

  /** The local turn end (design §8.2): thinking at once, the thinking timeout and the mood report start now; the
   *  turnId arrives with the transport's `turn-ended`. */
  private enterThinking(speechEnd: number, now: number): void {
    const from = this._phase;
    this.resetTurn();
    this.awaitingTurnId = true;
    this.armReply(now);
    this.latencyOrigin = speechEnd;
    this.speechHeard = true;
    this.setPhase('thinking', now);
    if (from === 'listening' || from === 'followUp' || from === 'interrupted') {
      const r = this.mood.trigger('endOfTurn', now, this._session === 'ready');
      if (r !== null) this.send({ kind: 'mood', payload: r });
    }
  }

  private startProactive(b: ProactiveBatch, now: number): void {
    this.resetTurn();
    this._proactiveInFlight = b;
    this.armReply(now);
    this.send({ kind: 'proactive', payload: {
      ids: b.ids, items: b.items,
      audience: { people: Math.max(this.face.conversationPeopleCount, 1), engaged: this._turnPerson !== null },
    } });
    this.log('proactive', `delivering ${b.ids.length} message(s)`);
    this.setPhase('thinking', now);
  }

  private runThinking(now: number): void {
    // Exact: the reply clock stamps the first rendered frame of this reply's audio.
    const snap = this.reply.playoutSnapshot();
    const rs = snap.replyStart;
    if (rs !== null && rs.epoch === this.epoch) {
      this.enterSpeaking(rs.frame, now);
    } else if (now >= this.thinkingDeadline) {
      this.log('thinking', this.awaitingTurnId ? 'timeout (no turn-ended)' : 'timeout');
      const t = this._currentTurn;
      if (t !== null && this._session === 'ready') this.send({ kind: 'cancelTurn', payload: { turnId: t, reason: 'thinking-timeout' } });
      this.enterSheepish('turn', now);
    }
  }

  private enterSpeaking(startFrame: number, now: number): void {
    this.replyStartFrame = startFrame;
    const t = this.latencyOrigin;
    if (t !== null) {
      this._lastReplyLatency = now - t;
      const tt = this._proactiveInFlight === null ? { ...(this.lastTurnTimings ?? makeTurnTimings()) } : makeTurnTimings();
      tt.firstReplyMarker = this.replyHintAt !== null ? this.replyHintAt - t : null;
      tt.heard = now - t;
      tt.replyAudioMs = this.replyEndAt !== null ? this.replyAudioMs : null;
      this.lastTurnTimings = tt;
    }
    this.noteOutcome(true);
    if (this.voice !== null) this.voice.isSpeaking = true;
    this.life.noteActivity('voiceReply');   // a real reply heard (review M3), never connection events
    this.setPhase('speaking', now);
    this.runSpeaking(now);
  }

  private runSpeaking(now: number): void {
    const snap = this.reply.playoutSnapshot();
    this.deliverSentenceStarts(snap);
    const end = this.replyEndAt;
    if (end === null || !this.replyPlayed(now, snap, end)) return;
    if (this.closeAfterReply !== null) this.dismiss(this.closeAfterReply, now);
    else this.enterFollowUp(now);
  }

  /** Sentence audio starts (review H5): `offsetMs` counts reply audio from the reply's first frame, so the sentence
   *  is audible when the reply clock passes `replyStart + offset`. Markers arrive in order, so only the head is due. */
  private deliverSentenceStarts(snap: PlayoutSnapshot): void {
    const start = this.replyStartFrame;
    const turn = this._currentTurn;
    if (start === null || turn === null || !(snap.sampleRate > 0)) return;
    while (this.markers.length > 0) {
      const m = this.markers[0];
      const target = start + roundHalfAway(m.offsetMs * snap.sampleRate / 1000);
      if (!(snap.framesPlayed >= target)) return;
      const heard = audibleHostTime(snap, target);
      this._emotion?.sentenceAudioStarted(turn, m.sentenceIndex, heard);
      this.markers.shift();
      const text = this.captionTexts.get(m.sentenceIndex);
      if (text !== undefined) {
        this.captionTexts.delete(m.sentenceIndex);
        this.captionShown = true;
        // The piece's audio length: up to the next piece's offset, or the reply's end (else it follows).
        const next = this.markers.length > 0 ? this.markers[0].offsetMs : (this.replyEndAt !== null ? this.replyAudioMs : null);
        this.untimedCaption = next === null ? m : null;
        this.onCaption?.({ kind: 'replySentence', turnId: turn, index: m.sentenceIndex, text, audibleAtHostTime: heard,
          audioSeconds: next !== null ? Math.max(next - m.offsetMs, 0) / 1000 : null });
      }
    }
  }

  /** End of reply = `reply-end` received and its `audioMs` played by the reply clock. `drainCap` past the reply's
   *  expected end is only a watchdog. */
  private replyPlayed(now: number, snap: PlayoutSnapshot, end: number): boolean {
    if (now - end >= this._timings.drainCap + this.replyAudioMs / 1000) return true;
    const start = this.replyStartFrame;
    if (start === null || !(snap.sampleRate > 0)) return false;
    return (snap.framesPlayed - start) / snap.sampleRate * 1000 >= this.replyAudioMs;
  }

  private enterFollowUp(now: number): void {
    if (this.voice !== null) this.voice.isSpeaking = false;
    this.face.setSpeechLevel(0);
    this.markers.length = 0;
    this.captionTexts.clear();
    this.untimedCaption = null;
    if (this.captionShown && this._currentTurn !== null) this.onCaption?.({ kind: 'replyEnded', turnId: this._currentTurn });
    if (this._proactiveInFlight !== null) this.finishProactive('spoken');
    this._currentTurn = null;
    this.followUpDeadline = now + this._timings.followUpWindow;
    this.setPhase('followUp', now);
    const r = this.mood.trigger('replyEnd', now, this._session === 'ready');
    if (r !== null) this.send({ kind: 'mood', payload: r });
  }

  private proactiveHeld(person: number | null, now: number): boolean {
    const h = this.proactiveHold;
    if (h === null) return false;
    if (now >= h.until) { this.proactiveHold = null; return false; }
    return h.person === null || h.person === person;
  }

  private followUpEnded(now: number): void {
    // Still engaged and something is waiting: "oh, and…" (review H2).
    const engagedNow = this._turnPerson !== null && this.face.conversationEngagedID === this._turnPerson;
    const ann = this.announcements;
    if (engagedNow && !this.isSuppressed && !this.proactiveHeld(this._turnPerson, now) && ann !== null
      && ann.hasDeliverable(this.face.conversationPeopleCount, true)) {
      const b = ann.takeBatch(this.face.conversationPeopleCount, true);
      if (b !== null) {
        this.startProactive(b, now);
        return;
      }
    }
    this.endConversation(now, true);
  }

  private bargeIn(now: number, reason: string): void {
    if (this._phase !== 'speaking') return;
    this.log('barge-in', reason);
    this.audio.flushPlayout();
    this.voice?.cancel();
    if (this.voice !== null) this.voice.isSpeaking = false;
    this.face.setSpeechLevel(0);
    if (this._currentTurn !== null) {
      this._emotion?.cancelTurn(this._currentTurn);
      this.discard(this._currentTurn);
    }
    this._currentTurn = null;
    this.markers.length = 0;
    if (this._proactiveInFlight !== null) this.finishProactive('interrupted');
    this.speechHeard = true;
    this.listenDeadline = null;
    this.setPhase('interrupted', now);   // the face plays the sorry-blink and hands off to listening itself
  }

  /** The person ended the conversation ("go away", "that's all", or a request plus a sign-off once its reply has
   *  played): everything stops as for `cancelByTap()`, look-to-talk rests for `dismissGazeHold`, and Yanni
   *  acknowledges warmly: an "okay!" nod and a glance aside, or, said harshly, a sheepish look away. */
  private dismiss(d: Dismissed, now: number): void {
    const reason = dismissedReason(d);
    this.log('conversation', `dismissed (${reason})`);
    this._lastDismissal = reason;
    this.endConversation(now, true);
    this.dismissHoldUntil = now + this._timings.dismissGazeHold;
    if (d.sheepish) {
      // Starts on a later frame than the noticing write, so the state-scoped look away isn't cut by it.
      this.face.send(FaceCommand.playOneShotAt('lookAway', now + 0.05));
    } else {
      this.face.send(FaceCommand.playOneShot('nodYes'));
      this.ackGlanceAt = now + 0.8;
    }
  }

  private dismissHeld(now: number): boolean { return this.dismissHoldUntil !== null && now < this.dismissHoldUntil; }

  private notForMeDone(now: number): void {
    // Before the face's own lookAway → idle hand-off (review H4): listening if they're still here.
    if (this._turnPerson !== null && this.face.conversationEngagedID === this._turnPerson) {
      this.enterListening(false, now);
    } else {
      this.endConversation(now, false);
    }
  }

  private enterSheepish(cause: SheepishCause, now: number): void {
    this.closeMic();
    if (this._phase === 'speaking') this.audio.flushPlayout();
    if (this._currentTurn !== null) {
      this._emotion?.cancelTurn(this._currentTurn);
      this.discard(this._currentTurn);
    }
    this.resetTurn();
    if (this.voice !== null) this.voice.isSpeaking = false;
    this.face.setSpeechLevel(0);
    this.noteOutcome(true);   // not the person's fault: never counts as a false engagement
    this._perception?.unpinTurn();
    const b = this.pendingBatch;
    if (b !== null) {
      // Pulled at engagement, never sent (the session didn't come up): the voice services were unavailable.
      this.pendingBatch = null;
      this.finishBatch(b, 'unavailable');
    }
    if (this._proactiveInFlight !== null) this.finishProactive('unavailable');
    this.sheepishAt = now;
    this.sheepishCause = cause;
    const s = this._settings;
    const c = this.greetings?.cantThink ?? null;
    if (s.cantThinkLine && !s.soundsOff && !s.quietMode && !this.life.isBedtime && c !== null) {
      this.audio.playClip(c.url, now + 0.7, this.gain);
    }
    this.log('sheepish', cause === 'connection' ? 'voice services unreachable' : 'turn failed');
    this.setPhase('sheepish', now);
  }

  private exitSheepish(now: number): void {
    this.log('sheepish', 'recovered');
    const reconnected = this.sheepishCause === 'connection';
    this.endConversation(now, false);
    // Reconnected: someone still looking gets a fresh engagement (try again). After a failed turn they look away and
    // back first, so a flaky agent never loops engaged → sheepish.
    if (reconnected) this.consumedEngagement = null;
  }

  /** The conversation is over: back to noticing (someone here) or idle. */
  private endConversation(now: number, release: boolean, write = true): void {
    this.noteOutcome(this.speechHeard);
    this.closeMic();
    this._perception?.unpinTurn();
    if (release) this._perception?.releaseTurn();
    const t = this._currentTurn;
    if (t !== null) {
      if (this._phase === 'thinking' && this._session === 'ready') this.send({ kind: 'cancelTurn', payload: { turnId: t, reason: 'left' } });
      this._emotion?.cancelTurn(t);
      this.discard(t);
    }
    if (this._phase === 'speaking') this.audio.flushPlayout();
    this.resetTurn();
    if (this.voice !== null) this.voice.isSpeaking = false;
    this.face.setSpeechLevel(0);
    if (this._proactiveInFlight !== null) this.finishProactive('cancelled');
    const b = this.pendingBatch;
    if (b !== null) { this.pendingBatch = null; this.finishBatch(b, 'cancelled'); }
    this._turnPerson = null;
    this._engagementTrigger = null;
    this.assignPhase('idle');
    this.phaseEnteredAt = now;
    if (write) this.writeFace(this.life.isPresent ? 'noticing' : 'idle');
    this.lastWritten = null;
  }

  /** Someone else moved the face out of the conversation (force sleep, the panel, the life cycle's takeover): stop
   *  everything without writing the state. */
  private abort(now: number, reason: string): void {
    this.log('conversation', `ended: ${reason}`);
    this.endConversation(now, true, false);
  }

  // MARK: - External state changes

  private reconcileExternalState(now: number): void {
    const written = this.lastWritten;
    if (this._phase === 'idle' || written === null) return;
    const s = this.face.conversationAgentState;
    if (s === written) return;
    if (this._phase === 'interrupted' && s === 'listening') {
      // The face's own sorry-blink → listening hand-off.
      this.assignPhase('listening');
      this.phaseEnteredAt = now;
      this.lastWritten = 'listening';
      this.listenDeadline = this.speechHeard ? null : now + this._timings.listenTimeout;
    } else if (this._phase === 'notForMe' && s === 'idle') {
      // The face's lookAway → idle hand-off fired first.
      this.notForMeDone(now);
    } else {
      this.abort(now, `agent state set to ${s}`);
    }
  }

  // MARK: - Proactive (review H2)

  private proactiveDone(p: ProactiveDone, now: number): void {
    const b = this._proactiveInFlight;
    if (b === null || !(p.ids.some((id) => b.ids.includes(id)) || p.ids.length === 0)) return;
    switch (p.status) {
      case 'spoken':
        break;   // reported as spoken once the reply has played (follow-up)
      case 'interrupted':
        if (this._phase !== 'speaking') this.finishProactive('interrupted');
        break;
      case 'unavailable':
        // No voice to say it (review R1): don't pull a batch again for this person for a while, so they can simply
        // talk instead of meeting the same `unavailable` at every engagement.
        this.proactiveHold = { person: this._turnPerson, until: now + this._timings.proactiveUnavailableHold };
        this.finishProactive('unavailable');
        if (this._phase === 'thinking') this.enterSheepish('turn', now);
        break;
      case 'cancelled':
        this.finishProactive('cancelled');
        if (this._phase === 'thinking') this.enterListening(false, now);
        break;
    }
  }

  private finishProactive(outcome: ProactiveOutcome): void {
    const b = this._proactiveInFlight;
    if (b === null) return;
    this._proactiveInFlight = null;
    this.finishBatch(b, outcome);
  }

  private finishBatch(b: ProactiveBatch, outcome: ProactiveOutcome): void {
    this.log('proactive', outcome);
    this.announcements?.finish(b.id, outcome);
  }

  // MARK: - Outputs

  private updateOutputs(hostTime: number): void {
    const g = this.gain;
    if (this.appliedGain !== g) {
      this.appliedGain = g;
      this.audio.setPlayoutGain(g);
    }
    if (this._phase === 'speaking') this.face.setSpeechLevel(this.audio.speechLevel(hostTime) ?? 0);
    // The mic level moves the glow only while the person's turn is live (listening or follow-up, before the turn ends)
    // and none of Yanni's own sounds may be audible, so the glow never dances to Yanni's voice.
    const ownSound = Math.max(this.voice?.audibleUntilHostTime ?? -Infinity, this.greetingEnd ?? -Infinity);
    const live = this._micOpen && (this._phase === 'listening' || this._phase === 'followUp') && hostTime > ownSound;
    this.face.setListeningLevel(live ? this._turn?.inputLevel ?? 0 : 0);
  }

  /** Talking bounce: every syllable of the Spoken voice's playout audio becomes a face cue, timed to when it is
   *  heard. This runs in every phase and even dormant: the first syllable may render before the phase turns speaking.
   *  Onsets already past are dropped. */
  private talkingBounce(hostTime: number): void {
    this.audio.drainSpeechLevels((level, t) => {
      const o = this.syllables.push(level, t);
      if (o === null || !(o.hostTime > hostTime - 0.1)) return;
      // An answer nod or shake owns the face's travel: the syllable hops duck under it.
      const answer = this.face.conversationActiveOneShots.find(isAnswer);
      this.face.send(FaceCommand.vocalCue(SyllableOnsetDetector.cue(o, answer)));
    });
  }

  private sendPeriodic(now: number): void {
    const r = this.mood.tick(now, this._session === 'ready');
    if (r !== null) this.send({ kind: 'mood', payload: r });
    this.sendContext(now, false);
  }

  private sendContext(now: number, force: boolean): void {
    if (this._session !== 'ready') return;
    const c: ContextUpdate = { quietMode: this._settings.quietMode, peopleCount: this.face.conversationPeopleCount };
    if (!(force || (!sameContext(c, this.lastContext) && now - this.lastContextAt >= this._timings.contextMinGap))) return;
    this.lastContext = c;
    this.lastContextAt = now;
    this.send({ kind: 'context', payload: c });
  }

  // MARK: - Helpers

  private noteOutcome(spoke: boolean): void {
    const id = this._turnPerson;
    if (this.outcomeNoted || id === null) return;
    this.outcomeNoted = true;
    this._perception?.noteEngagementOutcome(id, spoke);
  }

  private watch(k: OneShotKind): void {
    this.watchKind = k;
    this.watchSeenActive = false;
  }

  private watchDone(): boolean {
    const k = this.watchKind;
    if (k === null) return true;
    const active = this.face.conversationActiveOneShots.includes(k);
    if (active) this.watchSeenActive = true;
    return this.face.conversationCompletedOneShots.includes(k) || (this.watchSeenActive && !active);
  }

  private setPhase(p: ConversationPhase, now: number): void {
    this.assignPhase(p);
    this.phaseEnteredAt = now;
    if (p !== 'notForMe' && p !== 'confused') this.watchKind = null;
    const s = phaseAgentState(p);
    if (s !== null) this.writeFace(s);
    this.log('state', p);
  }

  private writeFace(s: AgentState): void {
    this.lastWritten = s;
    if (this.face.conversationAgentState !== s) this.face.setAgentState(s);
  }

  private log(kind: string, detail: string): void {
    this.onLog?.({ time: this.clock(), kind, detail });
  }
}
