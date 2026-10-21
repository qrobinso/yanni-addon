// Port of yanni/Perception/PerceptionHarness.swift and PerceptionHarness+Recording.swift (perception upgrade design
// §5): consent and the feature recorder, the labelled-session runner, the counters behind the Home Assistant sensors,
// the HUD's read-outs, retention, delete and export; plus the calibration state (Swift keeps it on PerceptionModel).
// The analysis side (Swift PerceptionHarnessTaps) is the live pipeline's `onFrame`: every analysed camera frame goes
// to the timing monitor and, while a session runs, to the writer. Nothing here runs per display frame.
import type { DisplayState } from '@yanni/server/protocol';
import type { ConversationPerception } from '../conversation/core/Ports';
import { CalibrationState } from '../perception/CalibrationState';
import { CollectPreset, ScriptedSessionRunner, type ScriptedPhase } from '../perception/CollectScript';
import { FeatureRecordingHeader, RecordingSessionType } from '../perception/FeatureRecordFormat';
import {
  FeatureRecordingStore, MemoryFileSystem, SessionMark, makeSessionLabels, type RecordingSessionSummary, type SessionLabels,
} from '../perception/FeatureRecordingStore';
import { FeatureRecordingSession } from '../perception/FeatureRecordingSession';
import { FeatureRecordingWriter, RecordedEvent, type RecordingStatus } from '../perception/FeatureRecordingWriter';
import { PerceptionTimingMonitor, StageTimings, type StageTimingSummary, makeStageTimingSummary } from '../perception/HarnessTiming';
import { PerceptionCounters, type PerceptionCounts } from '../perception/PerceptionCounters';
import { PerceptionTier, type PerceptionEvent } from '../perception/PerceptionTypes';
import {
  RecordingConsentText, RecordingGate, RecordingLimits, RecordingPolicy, RecordingStartCheck, makeRecordingParticipant,
  type RecordingParticipant,
} from '../perception/RecordingConsent';
import { StagePlan } from '../perception/TierPolicy';
import {
  openBrowserRecordingStore, tarDirectory, type PersistentFileSystem,
} from '../perception/web/BrowserRecordingFileSystem';
import type { PerceptionHandle } from '../perception/web/startPerception';
import type { FrameStats } from '../render/FrameStats';
import { mountHarnessOverlays } from '../preview/perception/HarnessOverlays';

/** The HUD's numbers (refreshed at 4 Hz while it is on screen). */
export interface PerceptionHUDNumbers {
  summary: StageTimingSummary;
  lateFraction: number;
  plan: string;
  tier: string;
  /** The face's frames over the same 5 s: delivered / requested and hitch time. */
  delivered: number;
  hitchMsPerSecond: number;
}

/** The owner PIN as the recorder needs it (OwnerAccess). */
export interface RecordingPINPort {
  readonly isPINRequired: boolean;
  verify(pin: string): Promise<'ok' | 'wrong' | { locked: number }>;
}

export interface HarnessAttachOptions {
  frameStats?: FrameStats;
  /** The drawn face's size (CSS px): recording headers. */
  faceSize?: () => { width: number; height: number };
  appBuild?: string;
}

const now0 = (): number => performance.now() / 1000;
const listFormat = (v: readonly string[]): string =>
  v.length <= 1 ? (v[0] ?? '') : `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`;

export class PerceptionHarness {
  readonly counters = new PerceptionCounters();
  readonly timing = new PerceptionTimingMonitor();
  readonly calibration: CalibrationState;
  /** The recorder's store: the browser's persistent storage once open (`ready`), in memory until then / without one. */
  store: FeatureRecordingStore;
  fs: PersistentFileSystem | null = null;
  readonly ready: Promise<void>;
  access: RecordingPINPort | null = null;
  perception: PerceptionHandle | null = null;
  private attachOpts: HarnessAttachOptions = {};
  private detachFrame: (() => void) | null = null;
  private overlaysMounted = false;

  writer: FeatureRecordingWriter | null = null;
  runner: ScriptedSessionRunner | null = null;
  pendingLabels: SessionLabels = makeSessionLabels();
  policy: RecordingPolicy;
  /** The running session's live status (null when not recording). */
  status: RecordingStatus | null = null;
  sessionType: RecordingSessionType | null = null;
  declared: string[] = [];
  sessionID: string | null = null;
  sessions: RecordingSessionSummary[] = [];
  totalBytes = 0;
  /** The scripted session's current prompt. */
  prompt: ScriptedPhase | null = null;
  /** The last action's message (Status, the panel). */
  message = '';
  hudEnabled = false;
  hud: PerceptionHUDNumbers = { summary: makeStageTimingSummary(), lateFraction: 0, plan: '', tier: '', delivered: 1, hitchMsPerSecond: 0 };
  private frameWindow: { t: number; delivered: number; requested: number; hitch: number; seconds: number }[] = [];
  private lastPurge = -Infinity;
  private lastLabelSave = 0;
  private lastSlowTick = -Infinity;
  private intrinsics: FeatureRecordingHeader['intrinsics'] | null = null;

  /** `store` for tests; otherwise the browser's persistent store opens in the background. */
  constructor(o: { store?: FeatureRecordingStore; clock?: () => number } = {}) {
    this.clock = o.clock ?? now0;
    this.calibration = new CalibrationState(this.clock);
    this.store = o.store ?? new FeatureRecordingStore(new MemoryFileSystem(), FeatureRecordingStore.defaultRoot);
    this.policy = this.store.loadPolicy();
    this.refreshSessions();
    this.ready = o.store ? Promise.resolve() : openBrowserRecordingStore().then((r) => {
      if (!r || this.isRecording) return;
      this.store = r.store;
      this.fs = r.fs;
      this.policy = r.store.loadPolicy();
      this.refreshSessions();
      this.purgeIfDue(this.clock());
    }, (e) => { console.warn(`perception recorder: storage unavailable (${e instanceof Error ? e.message : String(e)})`); });
  }

  readonly clock: () => number;

  get isRecording(): boolean { return this.sessionID !== null; }
  get pinSet(): boolean { return this.access?.isPINRequired ?? false; }

  // MARK: The live pipeline (Swift PerceptionHarnessTaps)

  /** Follows a (re)started perception handle: its analysed frames feed the timing monitor, the recorder and the
   *  calibration. */
  attach(p: PerceptionHandle | null, o: HarnessAttachOptions = {}): void {
    this.detachFrame?.();
    this.detachFrame = null;
    this.perception = p;
    this.attachOpts = o;
    if (!p) return;
    // The recording banner must show whenever a session runs (consent text), so it mounts with the first pipeline.
    if (!this.overlaysMounted && typeof document !== 'undefined') { this.overlaysMounted = true; mountHarnessOverlays(this); }
    this.detachFrame = p.onFrame((out, r) => {
      const camera = p.stats().source === 'camera';
      if (camera) {
        const st = StageTimings.fromValues(StageTimings.names.map((n) => r.stages[n] ?? 0));
        this.timing.note(st, r.detections.time);
        this.intrinsics = r.detections.intrinsics;
        this.writer?.offer(r.detections, out.snapshot, st, p.stats().tier);
      }
      this.calibration.observe(out.snapshot, p.coordinator.settings, r.detections);
    });
  }

  // MARK: Inputs

  /** Every coordinator log entry (event + what the coordinator did). Camera and replay only. */
  note(e: PerceptionEvent, note: string | null, now: number): void {
    if (this.perception?.coordinator.source === 'simulated') return;
    this.counters.note(e, note, now);
    this.writer?.note(RecordedEvent.of(e, now, note));
  }

  noteEngagementOutcome(spoke: boolean): void { this.counters.noteEngagementOutcome(spoke); }

  /** The owner's "Wrong reaction" (Status page or Home Assistant): counts a false positive and, while recording,
   *  marks the surrounding 5 s of the session. */
  wrongReaction(): string {
    const last = this.counters.reportWrongReaction();
    if (this.isRecording) {
      this.pendingLabels.marks.push({ t: last?.at ?? this.clock(), kind: SessionMark.wrongReaction,
        note: last ? `${last.gesture} → ${last.beat}` : null });
    }
    this.message = last ? `Marked ${last.gesture} → ${last.beat} as a wrong reaction` : 'Counted (no reaction yet)';
    return this.message;
  }

  // MARK: 4 Hz

  /** The 4 Hz tick (main.ts): counters, the recorder's status, the script, the HUD; once a second re-entries, the
   *  allocation proxy and retention. */
  tick(now: number, visibleIDs: () => readonly number[]): void {
    this.counters.tick(now);
    if (now - this.lastSlowTick >= 0.99) {
      this.lastSlowTick = now;
      const heap = this.timing.takeHeap();
      this.counters.noteHeap(heap.blocksDelta, heap.samples);
      this.counters.noteVisible(visibleIDs());
      this.purgeIfDue(now);
    }
    const w = this.writer;
    if (w) {
      const s = w.status;
      this.status = s;
      if (s.state === 'stopped') this.stop(s.stopReason ?? 'stopped');
      else if (this.perception?.stats().source !== 'camera') this.stop('the camera stopped being the people source');
    }
    const r = this.runner;
    if (r) {
      const p = r.phase(now);
      this.prompt = p;
      if (p.kind === 'done') this.stop('script finished');
      else if (now - this.lastLabelSave > 30) { this.saveLabels(); this.lastLabelSave = now; }
    }
    if (this.hudEnabled) this.refreshHUD(now);
  }

  private refreshHUD(now: number): void {
    const p = this.perception;
    const st = p?.stats();
    const tier = st?.tier ?? PerceptionTier.full;
    const h: PerceptionHUDNumbers = { summary: this.timing.summary(now), lateFraction: st?.lateFraction ?? 0,
      tier: PerceptionTier.label(tier), plan: StagePlan.summary(StagePlan.plan(tier)), delivered: 1, hitchMsPerSecond: 0 };
    const fs = this.attachOpts.frameStats?.snapshot();
    if (fs) {
      const tiers = [fs.asleep, fs.awake, fs.burst];
      const sum = (f: (t: (typeof tiers)[number]) => number) => tiers.reduce((a, t) => a + f(t), 0);
      this.frameWindow.push({ t: now, delivered: sum((t) => t.delivered), requested: sum((t) => t.requested),
        hitch: sum((t) => t.hitchSeconds), seconds: sum((t) => t.seconds) });
      this.frameWindow = this.frameWindow.filter((x) => !(now - x.t > 5.5));
      const a = this.frameWindow[0], b = this.frameWindow[this.frameWindow.length - 1];
      if (a && b && b.t > a.t) {
        const req = b.requested - a.requested, del = b.delivered - a.delivered;
        h.delivered = req > 0 ? del / req : 1;
        h.hitchMsPerSecond = b.seconds > a.seconds ? (b.hitch - a.hitch) * 1000 / (b.seconds - a.seconds) : 0;
      }
    }
    this.hud = h;
  }

  refreshSessions(): void {
    this.sessions = this.store.sessions();
    this.totalBytes = this.sessions.reduce((s, x) => s + x.bytes, 0);
  }

  private purgeIfDue(now: number): void {
    if (!(now - this.lastPurge > 3600)) return;
    this.lastPurge = now;
    const gone = this.store.purge(this.policy.retentionDays).filter((id) => id !== this.sessionID);
    if (gone.length > 0) this.refreshSessions();
  }

  // MARK: Consent, participants, sessions (PerceptionHarness+Recording.swift)

  /** "Allow recording" (the caller has checked the PIN). Turning it off stops a running session. */
  setAllowed(on: boolean): void {
    if (on && !this.pinSet) { this.message = RecordingStartCheck.message({ kind: 'noPIN' }); return; }
    this.policy.allowed = on;
    this.savePolicy();
    if (!on && this.isRecording) this.stop('recording switched off');
  }

  setRetentionDays(d: number): void {
    this.policy.retentionDays = d;
    this.savePolicy();
  }

  /** Declares a household member with their consent recorded now (a child's from a guardian). Pseudonyms only. */
  addParticipant(child: boolean, guardian: string | null): RecordingParticipant | null {
    if (child && (guardian === null || guardian === 'self')) { this.message = "A child's consent must come from a guardian."; return null; }
    let n = this.policy.participants.length + 1;
    while (this.policy.participants.some((p) => p.pseudonym === `P${n}`)) n += 1;
    const p = makeRecordingParticipant(`P${n}`, new Date(), { isChild: child, consentedBy: child ? guardian ?? '' : 'self' });
    this.policy.participants.push(p);
    this.savePolicy();
    return p;
  }

  /** Withdraws a participant's consent and deletes every session they took part in. */
  withdraw(pseudonym: string): void {
    if (this.declared.includes(pseudonym)) this.stop('consent withdrawn');
    this.policy.participants = this.policy.participants.filter((p) => p.pseudonym !== pseudonym);
    this.savePolicy();
    for (const s of this.store.sessions()) {
      if (s.header?.participants.some((p) => p.pseudonym === pseudonym) ?? true) this.store.delete(s.id);
    }
    this.refreshSessions();
  }

  private savePolicy(): void {
    this.policy = this.policy.validated();
    try { this.store.savePolicy(this.policy); } catch (e) { this.message = `Couldn't save: ${e instanceof Error ? e.message : String(e)}`; }
  }

  /** Starts a session. `pinVerified`: the PIN was entered for this start; `consentConfirmed`: the consent text was
   *  read with everyone taking part. A preset runs the prompt cards (their go-windows are the labels). */
  start(o: { type: RecordingSessionType; declared: string[]; consentConfirmed: boolean; pinVerified: boolean;
    preset?: CollectPreset | null; distance?: number | null }): RecordingStartCheck {
    if (this.isRecording) return { kind: 'ok' };
    const check = RecordingGate.canStart({ policy: this.policy, pinSet: this.pinSet, pinVerified: o.pinVerified,
      declared: o.declared, consentConfirmed: o.consentConfirmed, storedBytes: this.store.totalBytes() });
    if (check.kind !== 'ok') { this.message = RecordingStartCheck.message(check); return check; }
    const p = this.perception;
    const st = p?.stats();
    if (!p || !st || st.source !== 'camera' || !(st.camera.kind === 'running' || st.camera.kind === 'lowRate')) {
      this.message = "The camera isn't running (People source: Camera).";
      return { kind: 'notAllowed' };
    }
    const id = FeatureRecordingStore.newSessionID();
    const now = this.clock();
    const preset = o.preset ?? null;
    const h = new FeatureRecordingHeader(id, preset ? CollectPreset.sessionType(preset) : o.type,
      this.policy.participants.filter((q) => o.declared.includes(q.pseudonym)), new Date(), now);
    h.platform = 'web';
    h.interfaceOrientation = typeof screen !== 'undefined' ? screen.orientation?.type ?? '' : '';
    h.deviceModel = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : '';
    h.visionRevisions = { 'mediapipe-tasks-vision': '1.1.1', face: 'face_landmarker float16/1', hand: 'hand_landmarker float16/1',
      pose: 'pose_landmarker_lite float16/1' };
    h.captureFormat = `${st.video.width}×${st.video.height} RGBA`;
    if (this.intrinsics) h.intrinsics = this.intrinsics;
    h.cameraOffset = { ...st.cameraOffset };
    const fsz = this.attachOpts.faceSize?.();
    if (fsz) h.faceSizePoints = { x: fsz.width, y: fsz.height };
    h.appBuild = this.attachOpts.appBuild ?? '';
    h.tier = PerceptionTier.label(st.tier);
    h.stagePlan = StagePlan.summary(StagePlan.plan(st.tier));
    try {
      this.writer = new FeatureRecordingWriter(this.store.fs, this.store.directory(id), h, RecordingLimits.maxTotalBytes - this.store.totalBytes());
    } catch (e) {
      this.message = `Couldn't start: ${e instanceof Error ? e.message : String(e)}`;
      return { kind: 'storageFull' };
    }
    this.sessionID = id;
    this.sessionType = h.sessionType;
    this.declared = [...o.declared];
    this.pendingLabels = makeSessionLabels();
    this.status = this.writer.status;
    this.counters.noneSessionActive = h.sessionType === 'none' || h.sessionType === 'hardNegatives';
    if (preset) this.runner = new ScriptedSessionRunner(CollectPreset.prompts(preset, o.declared, o.distance ?? null), now);
    this.message = `Recording ${RecordingSessionType.title(h.sessionType)} with ${listFormat(o.declared)}`;
    return { kind: 'ok' };
  }

  /** Stops the running session and saves its labels. */
  stop(reason = 'stopped by the owner'): void {
    const w = this.writer;
    if (!w) return;
    this.writer = null;
    const h = w.finish(reason);
    this.saveLabels();
    this.runner = null;
    this.prompt = null;
    this.status = null;
    this.sessionID = null;
    this.sessionType = null;
    this.declared = [];
    this.counters.noneSessionActive = false;
    this.message = `Saved ${h.framesWritten} frames (${h.framesPausedUndeclared} paused, ${h.framesDropped} dropped) · ${reason}`;
    this.refreshSessions();
  }

  saveLabels(): void {
    const id = this.sessionID;
    if (id === null) return;
    const l = makeSessionLabels([...this.pendingLabels.labels, ...(this.runner?.labels ?? [])], [...this.pendingLabels.marks]);
    try { this.store.saveLabels(l, id); } catch { /* the next save retries */ }
  }

  skipPrompt(): void { this.runner?.skip(this.clock()); }

  delete(id: string): void {
    if (id === this.sessionID) return;
    this.store.delete(id);
    this.refreshSessions();
  }

  deleteAll(): void {
    if (this.isRecording) this.stop('delete all');
    this.store.deleteAll();
    this.refreshSessions();
    this.message = 'All recordings deleted';
  }

  /** Reads a stored session (the skeleton viewer, the replay source). */
  async loadSession(id: string): Promise<FeatureRecordingSession> {
    const dir = this.store.directory(id);
    await this.fs?.preload(dir);
    try { return FeatureRecordingSession.load(this.store.fs, dir); } finally { this.fs?.evict(dir); }
  }

  /** Saves a session's edited labels (the skeleton viewer). */
  saveSessionLabels(id: string, l: SessionLabels): void { this.store.saveLabels(l, id); }

  /** One session folder as a tar for download (Swift: a zip for the share sheet). */
  async exportTar(id: string): Promise<{ name: string; bytes: Uint8Array }> {
    const dir = this.store.directory(id);
    await this.fs?.preload(dir);
    try { return { name: `yanni-perception-${id}.tar`, bytes: tarDirectory(this.store.fs, dir, id) }; } finally { this.fs?.evict(dir); }
  }

  // MARK: Home Assistant

  homeSignals(): Pick<DisplayState, 'false_engagements_per_hour' | 'gesture_reactions_per_hour' |
    'gesture_false_reports_per_hour' | 'perception_recording'> {
    const c = this.counters.lifetime;
    const r = (x: number) => Math.round(x * 10) / 10;
    return { false_engagements_per_hour: r(c.perHour(c.falseEngagements)), gesture_reactions_per_hour: r(c.perHour(c.reactions)),
      gesture_false_reports_per_hour: r(c.perHour(c.gestureFalsePositives)), perception_recording: this.isRecording };
  }

  get counts(): PerceptionCounts { return this.counters.lifetime; }

  /** The consent text shown before each session. */
  static readonly consentText = RecordingConsentText.text;
}

/** The voice loop's view of perception, counting each engagement's outcome on the way (CountingConversationPerception). */
export function countingConversationPerception(base: ConversationPerception, harness: PerceptionHarness): ConversationPerception {
  return {
    pinTurn: (id) => base.pinTurn(id),
    unpinTurn: () => base.unpinTurn(),
    releaseTurn: () => base.releaseTurn(),
    noteEngagementOutcome: (id, spoke) => { harness.noteEngagementOutcome(spoke); base.noteEngagementOutcome(id, spoke); },
    setLookToTalkDryRun: (on) => base.setLookToTalkDryRun(on),
  };
}
