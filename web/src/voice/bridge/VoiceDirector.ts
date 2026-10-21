// Port of FaceVoice/Bridge/VoiceDirector.swift (the `+LaughFit` and `+Reply` extensions live in their own files and
// are forwarded from here).
import {
  FaceAffect, FaceCommand, OneShotLibrary, OneShotSampler, type AgentState, type FaceEngine, type FaceState,
  type OneShotKind, type SentenceTag, type StartedOneShot, type VocalCue, type VocalCueKind,
} from '../../engine';
import type { V3 } from '../../core/vec';
import { VoiceRenderer, type VoiceRendererLike } from '../dsp/VoiceRenderer';
import { PhraseGenerator } from '../generate/PhraseGenerator';
import { VoiceReactionTables } from '../generate/ReactionTables';
import { HostClock, type VoiceOutput } from '../host/VoiceOutput';
import { VoiceAffect, type Envelope, type Note, type Phrase, type VoiceReaction } from '../model/VoiceModel';
import { ReplyBabbleSettings, ReplyState, type ReplyChunk, type VoicedReplyChunk } from './ReplyBabble';
import { LaughFitState, stepLaughFit } from './VoiceDirector+LaughFit';
import * as Reply from './VoiceDirector+Reply';

export type BedtimeSounds = 'off' | 'quiet';

/// Sound-related settings, mirrored later by app settings and Home Assistant. Persisted across launches
/// (`VoiceSettingsStore`) so a muted Yanni stays muted after a relaunch.
///
/// Whether it is bedtime is not a setting: the life-cycle controller owns it and sets `VoiceDirector.isBedtime` at
/// runtime, so a relaunch in the daytime never starts silent and a panel edit of these settings can never clear
/// bedtime. Older saved settings that still carry a `bedtime` key decode fine (the key is ignored).
export class VoiceSettings {
  volume = 0.7;
  muted = false;
  /// No sounds; the face still reacts.
  quietMode = false;
  /// Spec: night wakes are quiet — default off. `quiet` allows sleepy/sheepish at reduced volume.
  bedtimeSounds: BedtimeSounds = 'off';
  /// Vocalize automatically on agent-state entries and face one-shots.
  autoVocalize = true;
  /// Manual audio/video offset in seconds (±0.06): positive delays the face relative to the sound.
  avOffset = 0;

  constructor(o: Partial<VoiceSettings> = {}) { Object.assign(this, o); }

  copy(): VoiceSettings { return new VoiceSettings(this); }

  equals(o: VoiceSettings): boolean {
    return this.volume === o.volume && this.muted === o.muted && this.quietMode === o.quietMode &&
      this.bedtimeSounds === o.bedtimeSounds && this.autoVocalize === o.autoVocalize && this.avOffset === o.avOffset;
  }

  /// Missing or unreadable keys keep their defaults (older or newer saved settings still load).
  static decode(o: unknown): VoiceSettings {
    const s = new VoiceSettings();
    if (typeof o !== 'object' || o === null) return s;
    const r = o as Record<string, unknown>;
    if (typeof r.volume === 'number') s.volume = r.volume;
    if (typeof r.muted === 'boolean') s.muted = r.muted;
    if (typeof r.quietMode === 'boolean') s.quietMode = r.quietMode;
    if (r.bedtimeSounds === 'off' || r.bedtimeSounds === 'quiet') s.bedtimeSounds = r.bedtimeSounds;
    if (typeof r.autoVocalize === 'boolean') s.autoVocalize = r.autoVocalize;
    if (typeof r.avOffset === 'number') s.avOffset = r.avOffset;
    return s;
  }

  toJSON(): Record<string, unknown> {
    return { volume: this.volume, muted: this.muted, quietMode: this.quietMode, bedtimeSounds: this.bedtimeSounds,
      autoVocalize: this.autoVocalize, avOffset: this.avOffset };
  }
}

/// Saves `VoiceSettings` (JSON in local storage; port-note: user defaults in Swift) so mute, quiet mode, volume etc.
/// survive a relaunch.
export class VoiceSettingsStore {
  static readonly defaultKey = 'yanni.voiceSettings';
  constructor(readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null,
    readonly key = VoiceSettingsStore.defaultKey) {}

  /// The saved settings, or null when nothing (readable) was saved.
  load(): VoiceSettings | null {
    try {
      const text = this.storage?.getItem(this.key);
      if (text === null || text === undefined) return null;
      const o: unknown = JSON.parse(text);
      return typeof o === 'object' && o !== null ? VoiceSettings.decode(o) : null;
    } catch { return null; }
  }

  save(settings: VoiceSettings): void {
    try { this.storage?.setItem(this.key, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
  }
}

/// One phrase as the director scheduled it (sound start, stretch, the face cues sent for it).
export class ScheduledPhrase {
  /// The face one-shot this phrase is lined up with (director-initiated or auto-matched).
  pairedOneShot: OneShotKind | null;
  /// Host time sent with `.playOneShotAt` (director-initiated only).
  oneShotHostTime: number | null;
  /// Played on the reply renderer (babble and its answer chirp) rather than the chirp renderer.
  onReply = false;
  constructor(
    public phrase: Phrase,
    /// Host seconds at which the renderer starts the phrase (audible `latency` later).
    public startHostTime: number,
    public timeStretch: number,
    /// Output latency used for the face cues.
    public latency: number,
    /// Face cues sent for this phrase (one per note), in note order.
    public cues: VocalCue[],
    paired: OneShotKind | null,
    oneShotHostTime: number | null,
    /// Planned automatically (state entry / started one-shot) rather than by `react`/`emote`/`repeatLast`.
    public isAuto: boolean,
    /// True when the sound was expected to be heard (not muted/quiet/suppressed, output running).
    public audible: boolean,
    /// The renderer accepted the phrase (stub renderers return false).
    public enqueued: boolean,
  ) {
    this.pairedOneShot = paired;
    this.oneShotHostTime = oneShotHostTime;
  }

  /// Host time at which the last note's release ends at the speaker.
  get audibleEnd(): number { return this.startHostTime + this.phrase.duration * this.timeStretch + this.latency; }
}

export type Alignment =
  | { kind: 'none' }
  /// No one-shot; start at this host time (or as soon as the lead allows).
  | { kind: 'at'; t: number }
  /// Voice-initiated: the director sends `.playOneShotAt`.
  | { kind: 'director'; oneShot: OneShotKind }
  /// A one-shot the engine started on its own (idle beats, state entry, panel).
  | { kind: 'started'; started: StartedOneShot; frameHost: number };

export interface PendingOneShot { kind: OneShotKind; hostTime: number; phraseID: number; confirmed: boolean }

/// Bridges the face engine and the voice: plans phrases from the same affect snapshot the face uses, schedules
/// audio and face cues on one host clock, and lines up one-shot accents with notes.
///
/// Timing model (all host seconds):
/// - a phrase starts at `start ≥ now + lead`, `lead = max(40 ms, 2·ioBufferDuration + 10 ms)`; after
///   `idleAfter` of silence the output is idled and the lead is read before waking it, so it covers the idle buffer;
/// - note `i` is heard at `start + note.start·stretch + outputLatency`; its face cue carries that time plus
///   `settings.avOffset` (positive delays the face);
/// - with a paired one-shot started at host time `T`, the accent note is heard at
///   `T + accent/rate·stretch + visualLead − avOffset` (`visualLead` 10 ms: the face leads the sound), where
///   `rate` is the one-shot playback rate and `stretch = 1/timeScale`.
///
/// Face cues are always sent, even when the sound is muted, quiet, suppressed or there is no running output:
/// the face never depends on audio.
export class VoiceDirector {
  readonly engine: FaceEngine;
  private _renderer: VoiceRendererLike;
  /// Yanni's babble replies play here (a second renderer with its own queue): never muted by Sounds off, quiet mode
  /// or bedtime, at the voice volume × the night factor at a bedtime night wake (`ReplyBabble.ts`).
  readonly replyRenderer: VoiceRendererLike;
  private _output: VoiceOutput | null;
  private _generator: PhraseGenerator;
  private _replySettings = new ReplyBabbleSettings();
  private _settings = new VoiceSettings();
  private _isBedtime = false;

  /// Host clock in seconds (tests inject a fake).
  clock: () => number = () => HostClock.nowSeconds();
  /// Set by the voice loop while Yanni speaks; auto-vocalization pauses.
  isSpeaking = false;
  /// Called after the director rebuilt the renderer for a new output sample rate.
  onRendererReplaced: ((r: VoiceRendererLike) => void) | null = null;
  /// port-note: makes the renderer for a new output rate (Swift: `VoiceRenderer(sampleRate:)`); the browser host
  /// swaps in its worklet port.
  makeRenderer: (rate: number) => VoiceRendererLike = (rate) => new VoiceRenderer(rate);
  /// port-note (web): Yanni may be audible over [start, end] host seconds — wired to `ConversationAudio.markPlayout`
  /// (the echo rule's window; the iPad's voice-processing engine gets this from the shared playout instead).
  onPlayout: ((start: number, end: number) => void) | null = null;
  /// port-note (web): a cancel cut what was marked after this host time (`PlayoutAudibility.cutAfter`).
  onPlayoutCut: ((after: number) => void) | null = null;

  // MARK: Tunables

  /// Minimum scheduling lead (s); the effective lead also covers two IO buffers + 10 ms.
  static readonly minLead = 0.040;
  /// The face leads the sound: the accented note is heard this long after the one-shot's accent (s).
  static readonly visualLead = 0.010;
  /// Auto phrases that would land more than this late against their one-shot are skipped (s).
  static readonly maxLateness = 0.150;
  /// Tail added to `audibleUntilHostTime` (s).
  static readonly audibleTail = 0.150;
  /// At most one auto phrase per this interval (s), counted from the last phrase of any origin.
  static readonly autoInterval = 1.5;
  /// Escalations that carry meaning (a startle, the "hmph" when tapped too much) only need this gap after the
  /// last phrase, so a quick friendly chirp a moment earlier doesn't always swallow them (s). Their own
  /// per-reaction cooldowns still apply.
  static readonly urgentAutoInterval = 0.6;
  /// Reactions that use `urgentAutoInterval`.
  static readonly urgentAutoReactions: ReadonlySet<VoiceReaction> = new Set<VoiceReaction>(['startled', 'hmph']);
  /// A director-initiated one-shot that hasn't started this long after its time is treated as rejected (s, ≈ 2–3 frames).
  static readonly rejectionGrace = 0.05;
  /// Volume factor for `bedtimeSounds == quiet`.
  static readonly bedtimeVolume = 0.4;
  /// Inter-onset interval (s) from which a note gets a discrete face hop even when not accented.
  static readonly hopInterval = 0.18;
  /// After this long without sound (s) the output goes idle (longer IO buffer); the next phrase wakes it.
  static readonly idleAfter = 30;
  /// While nobody is engaged (idle or noticing), auto chirps sound at most this often; the one-shots still play,
  /// silent. Startles and "hmph", taps and tickles are not limited.
  static readonly idleAmbientInterval = 90;

  // MARK: Read-outs

  /// The last phrase planned (for the panel read-out).
  lastPhrase: Phrase | null = null;
  /// The last phrase as scheduled (start, stretch, cues).
  lastScheduled: ScheduledPhrase | null = null;
  /// Effective renderer controls last applied.
  rendererMuted = false;
  rendererVolume = 0.7;
  /// The reply renderer's linear gain on top of the volume (1, or the night factor at a bedtime night wake).
  replyGain = 1;
  /// Director-initiated one-shots that never started (the engine rejected them).
  rejectedOneShotCount = 0;
  /// Phrases re-timed because the audio thread started them late.
  retimedPhraseCount = 0;

  /// Until when (host seconds) Yanni's own sound may be audible, incl. a 150 ms tail; the voice loop gates
  /// voice-activity detection and barge-in on it.
  get audibleUntilHostTime(): number { return Math.max(this.audibleUntil, this.reply.audibleUntil); }

  // MARK: Internal state (Swift `private`/internal; public here for the extension files and tests)

  audibleUntil = 0;
  nextID = 0;
  records: ScheduledPhrase[] = [];
  pending: PendingOneShot[] = [];
  private lastAgentState: AgentState;
  lastPhraseTime = -Infinity;
  lastAutoTime = new Map<VoiceReaction, number>();
  private readonly lastStartedSeen = { id: 0, hostTime: 0 };
  private readonly replyLastStartedSeen = { id: 0, hostTime: 0 };
  /// The reply being babbled (`ReplyBabble.ts`).
  reply = new ReplyState();
  /// The tickle's laugh fit (`VoiceDirector+LaughFit.ts`).
  laughFit = new LaughFitState();
  /// Host time the output was last made (or found) active; null until the first frame with this output.
  activeSince: number | null = null;

  constructor(engine: FaceEngine, renderer: VoiceRendererLike, output: VoiceOutput | null,
    generator: PhraseGenerator = new PhraseGenerator(), replyRenderer?: VoiceRendererLike) {
    this.engine = engine;
    this._renderer = renderer;
    this.replyRenderer = replyRenderer ?? new VoiceRenderer(renderer.sampleRate);
    this._output = output;
    this._generator = generator;
    this.lastAgentState = engine.state.agentState;
    this.hookOutput();
    this.applySettings();
    renderer.setFingerprint(generator.fingerprint);
    this.replyRenderer.setFingerprint(generator.fingerprint);
  }

  get renderer(): VoiceRendererLike { return this._renderer; }

  get output(): VoiceOutput | null { return this._output; }
  set output(o: VoiceOutput | null) { this._output = o; this.hookOutput(); this.activeSince = null; }

  get generator(): PhraseGenerator { return this._generator; }
  set generator(g: PhraseGenerator) {
    const old = this._generator;
    this._generator = g;
    if (!g.fingerprint.equals(old.fingerprint)) {
      this._renderer.setFingerprint(g.fingerprint);
      this.replyRenderer.setFingerprint(g.fingerprint);
    }
  }

  /// Babble caps, the tag deadline and the night factor (Tune › Sound › Reply babble).
  /// port-note: Swift structs fire `didSet` on member writes (`director.settings.muted = true`); the getters hand out a
  /// Proxy that routes member writes through the setters, so both spellings behave the same.
  get replySettings(): ReplyBabbleSettings { return this.replySettingsView; }
  set replySettings(s: ReplyBabbleSettings) {
    const old = this._replySettings;
    this._replySettings = s.validated();
    this.replySettingsView = this.watch(this._replySettings, (v) => { this.replySettings = v; });
    if (!this._replySettings.equals(old)) this.applySettings();
  }

  get settings(): VoiceSettings { return this.settingsView; }
  set settings(s: VoiceSettings) {
    const old = this._settings;
    this._settings = s.copy();
    this.settingsView = this.watch(this._settings, (v) => { this.settings = v; });
    if (!s.equals(old)) this.applySettings();
  }

  private settingsView = this.watch(this._settings, (v) => { this.settings = v; });
  private replySettingsView = this.watch(this._replySettings, (v) => { this.replySettings = v; });

  private watch<T extends { copy(): T }>(target: T, assign: (v: T) => void): T {
    return new Proxy(target, {
      set: (t, k, v) => {
        const next = t.copy();
        Reflect.set(next as object, k, v);
        assign(next);
        return true;
      },
    });
  }

  /// Bedtime (night) sound rules: silent unless `settings.bedtimeSounds == quiet` (then only sleepy / sheepish at
  /// reduced volume). Runtime only, never persisted; written only by the life-cycle controller. Replacing `settings`
  /// never touches it.
  get isBedtime(): boolean { return this._isBedtime; }
  set isBedtime(b: boolean) {
    const old = this._isBedtime;
    this._isBedtime = b;
    if (b !== old) this.applySettings();
  }

  // MARK: - Public actions

  /// Plays a named reaction now, optionally with its paired face one-shot (accent-aligned).
  react(reaction: VoiceReaction, withFace = true): void {
    const now = this.clock();
    const kind = withFace ? VoiceDirector.pairedOneShot(reaction) : null;
    if (kind !== null) this.plan(reaction, now, { kind: 'director', oneShot: kind }, false);
    else this.plan(reaction, now, { kind: 'none' }, false);
  }

  /// A free phrase from the current affect.
  emote(): void { this.react('emote', false); }

  /// Barge-in: fade out sound on both renderers (chirps and the babble reply, 30 ms) and drop pending face cues.
  cancel(): void {
    const now = this.clock();
    this._renderer.cancelAll();
    this.replyRenderer.cancelAll();
    this.engine.send(FaceCommand.cancelVocalCues(now));
    this.records.length = 0;
    this.pending.length = 0;
    this.audibleUntil = Math.min(this.audibleUntil, now + VoiceDirector.audibleTail);
    this.reply.cancel(now, VoiceDirector.audibleTail);
    this.laughFit = new LaughFitState();
    this.onPlayoutCut?.(now + VoiceDirector.audibleTail);
  }

  /// Replays the last phrase exactly (A/B listening in the tuning panel). Same notes and affect; a fresh id;
  /// no face one-shot (cues are still sent).
  repeatLast(): void {
    const p = this.lastPhrase;
    if (!p) return;
    this.schedule(p, this.clock(), { kind: 'none' }, false);
  }

  /// New generator seed, keeping the fingerprint.
  randomizeSeed(seed: bigint = BigInt.asUintN(64, BigInt(Math.floor(Math.random() * 2 ** 53)) << 11n) | 1n): void {
    this.generator = new PhraseGenerator(this._generator.fingerprint, seed);
  }

  /// The affect a phrase planned now would use: mood + influence·(shown expression PAD − Neutral PAD), clamped,
  /// exactly as the face's mood colour computes it.
  affectSnapshot(): VoiceAffect {
    return VoiceAffect.fromPAD(VoiceDirector.effectivePAD(this.engine.state, this.expressionInfluence));
  }

  /// Scheduling lead (s) for the current output.
  get lead(): number { return Math.max(VoiceDirector.minLead, 2 * (this._output?.ioBufferDuration ?? 0) + 0.010); }

  /// Time stretch for the slow-motion preview: 1/timeScale, never below 1.
  get timeStretch(): number {
    const ts = this.engine.timeScale;
    if (!(Number.isFinite(ts) && ts > 0)) return 1;
    return Math.max(1, 1 / Math.max(ts, 0.05));
  }

  // MARK: - Per frame

  /// Call once per display frame after the engine ticks: reacts to started one-shots and state entries.
  afterFrame(hostTime: number): void {
    const s = this.engine.state;
    this.retimeIfShifted();
    stepLaughFit(this);

    // (a) Started one-shots: confirm our own, auto-vocalize the rest.
    for (const started of s.startedOneShots) {
      const startedAt = started.hostTime ?? hostTime;
      const i = this.pending.findIndex((p) =>
        !p.confirmed && p.kind === started.kind && startedAt >= p.hostTime - VoiceDirector.rejectionGrace);
      if (i >= 0) { this.pending[i].confirmed = true; continue; }
      const reaction = VoiceDirector.reactionForOneShot(started.kind);
      if (reaction === null) continue;
      // The laugh fit is the tickle's voice: its laugh bursts stay silent.
      if (started.kind === 'laugh' && this.laughFit.active) continue;
      // hasMessage repeats perkUp as a reminder: that one stays silent.
      if (started.kind === 'perkUp' && s.agentState === 'hasMessage') continue;
      const now = this.clock();
      if (!this.autoAllowed(reaction, now)) continue;
      if (this.plan(reaction, now, { kind: 'started', started, frameHost: hostTime }, true, started.softVoice) !== null) {
        this.lastAutoTime.set(reaction, now);
      }
    }

    // Fallback confirmation: the kind is active once its time has come.
    for (const p of this.pending) {
      if (!p.confirmed && hostTime >= p.hostTime && s.activeOneShots.includes(p.kind)) p.confirmed = true;
    }

    // Rejected one-shots: cancel the phrase only if it is the only one pending; otherwise let it play alone.
    let i = 0;
    while (i < this.pending.length) {
      const p = this.pending[i];
      if (p.confirmed) {
        if (hostTime > p.hostTime + 1) this.pending.splice(i, 1); else i += 1;
        continue;
      }
      if (!(hostTime > p.hostTime + VoiceDirector.rejectionGrace)) { i += 1; continue; }
      this.pending.splice(i, 1);
      this.rejectedOneShotCount += 1;
      const now = this.clock();
      const othersPending = this.records.some((r) => r.phrase.id !== p.phraseID && r.audibleEnd > now);
      if (!othersPending) {
        this._renderer.cancelAll();
        this.engine.send(FaceCommand.cancelVocalCues(now));
        this.records = this.records.filter((r) => r.phrase.id !== p.phraseID);
        this.audibleUntil = Math.min(this.audibleUntil, now + VoiceDirector.audibleTail);
        this.onPlayoutCut?.(now + VoiceDirector.audibleTail);
      }
    }

    // (b) Agent-state entries (compared with the last seen state, not `agentStateChanged`).
    if (s.agentState !== this.lastAgentState) {
      this.lastAgentState = s.agentState;
      const reaction = VoiceDirector.reactionForStateEntry(s.agentState);
      if (reaction !== null) {
        const now = this.clock();
        if (this.autoAllowed(reaction, now) && this.plan(reaction, now, { kind: 'none' }, true) !== null) {
          this.lastAutoTime.set(reaction, now);
        }
      }
    }

    // Forget phrases that have finished.
    if (this.records.length > 0) {
      const now = this.clock();
      this.records = this.records.filter((r) => !(r.audibleEnd + 1 < now));
    }

    // Long silence: idle output (a compare per frame; nothing once idle).
    const out = this._output;
    if (out && !(out.isIdle ?? false) && this.records.length === 0 && this.pending.length === 0) {
      const now = this.clock();
      const since = this.activeSince ?? now;
      this.activeSince = since;
      if (now > Math.max(this.audibleUntil, this.reply.audibleUntil, since) + VoiceDirector.idleAfter) out.setIdle?.(true);
    }
  }

  /// Rebuilds around a new renderer (e.g. after a sample-rate change): reapplies settings, attaches it to the
  /// output and drops pending face cues (the old renderer's schedule is gone).
  replaceRenderer(r: VoiceRendererLike): void {
    this._renderer = r;
    r.setFingerprint(this._generator.fingerprint);
    this.records.length = 0;
    this.pending.length = 0;
    this.engine.send(FaceCommand.cancelVocalCues(this.clock()));
    this.applySettings();
    this._output?.attach(r);
    this.onRendererReplaced?.(r);
  }

  // MARK: - Planning

  private plan(reaction: VoiceReaction, now: number, alignment: Alignment, isAuto: boolean, soft = false): ScheduledPhrase | null {
    const affect = this.affectSnapshot();   // ONE snapshot: the phrase and its cues' valence share it.
    let phrase = this._generator.make(reaction, affect);
    if (soft) phrase = VoiceDirector.softened(phrase);
    phrase.affect = { ...affect };
    return this.schedule(phrase, now, alignment, isAuto);
  }

  /// `nightOK`: allowed at a quiet bedtime like sleepy / sheepish (the laugh fit, at the night volume).
  schedule(planned: Phrase, now: number, alignment: Alignment, isAuto: boolean, nightOK = false): ScheduledPhrase | null {
    const phrase = planned.copy();
    const stretch = this.timeStretch;
    const latency = this._output?.outputLatency ?? 0;
    const earliest = now + this.lead;
    const k = VoiceDirector.accentIndex(phrase);
    const accentOffset = phrase.notes.length > 0 ? phrase.notes[k].start * stretch : 0;

    let start = earliest;
    let paired: OneShotKind | null = null;
    let oneShotT: number | null = null;
    switch (alignment.kind) {
      case 'none':
        break;
      case 'at':
        start = Math.max(earliest, alignment.t);
        break;
      case 'director': {
        const a = VoiceDirector.accentTime(alignment.oneShot) / this.oneShotRate * stretch;
        let t = earliest;
        start = t + a + VoiceDirector.visualLead - this._settings.avOffset - latency - accentOffset;
        if (start < earliest) { t += earliest - start; start = earliest; }
        paired = alignment.oneShot;
        oneShotT = t;
        break;
      }
      case 'started': {
        const s = alignment.started;
        const t0 = s.hostTime ?? alignment.frameHost;
        const rate = Number.isFinite(s.rate) && s.rate > 0 ? s.rate : this.oneShotRate;
        const a = (s.accentTimes[0] ?? VoiceDirector.accentTime(s.kind)) / rate * stretch;
        const target = t0 + a + VoiceDirector.visualLead - this._settings.avOffset - latency - accentOffset;
        if (target < earliest) {
          if (!(earliest - target <= VoiceDirector.maxLateness)) return null;
        } else {
          start = target;
        }
        paired = s.kind;
        break;
      }
    }

    // Leave idle only now: `earliest` was computed from the idle (longer) buffer, so the phrase starts
    // late enough for the switch; face cues use the same start.
    this.activeSince = now;
    const out = this._output;
    if (out && out.isIdle) out.setIdle?.(false);

    this.nextID += 1;
    phrase.id = this.nextID;

    const soundAllowed = nightOK || VoiceDirector.soundAllowed(phrase.reaction, this._settings, this._isBedtime);
    const outputRunning = this._output?.isRunning === true;
    let enqueued = false;
    if (soundAllowed && outputRunning) enqueued = this._renderer.enqueue(phrase, start, stretch);
    const audible = soundAllowed && outputRunning && !this.rendererMuted;

    if (alignment.kind === 'director' && oneShotT !== null) {
      this.engine.send(FaceCommand.playOneShotAt(alignment.oneShot, oneShotT));
      this.pending.push({ kind: alignment.oneShot, hostTime: oneShotT, phraseID: phrase.id, confirmed: false });
    }

    const cues = this.makeCues(phrase, start, stretch, latency, paired);
    for (const c of cues) this.engine.send(FaceCommand.vocalCue(c));

    const rec = new ScheduledPhrase(phrase, start, stretch, latency, cues, paired, oneShotT, isAuto, audible, enqueued);
    this.records.push(rec);
    if (audible) {
      this.audibleUntil = Math.max(this.audibleUntil, rec.audibleEnd + VoiceDirector.audibleTail);
      this.onPlayout?.(start + latency, rec.audibleEnd);
    }
    this.lastPhrase = phrase;
    this.lastScheduled = rec;
    this.lastPhraseTime = now;
    return rec;
  }

  makeCues(phrase: Phrase, start: number, stretch: number, latency: number, paired: OneShotKind | null): VocalCue[] {
    const n = phrase.notes.length;
    const cues: VocalCue[] = [];
    const base = start + latency + this._settings.avOffset;
    for (let i = 0; i < n; i++) {
      const note = phrase.notes[i];
      const ioi = i === 0 ? Infinity : (note.start - phrase.notes[i - 1].start) * stretch;
      let kind = VoiceDirector.cueKind(phrase.reaction, i, n, note);
      if (kind === 'plain' && note.accent) kind = 'accent';
      const cue: VocalCue = {
        hostTime: base + note.start * stretch,
        duration: note.duration * stretch,
        contour: note.contour.copy(),
        intensity: Math.min(Math.max(note.gain, 0), 1),
        articulation: VoiceDirector.articulation(note.envelope),
        valence: phrase.affect.pleasure,
        kind,
        accent: note.accent || ioi >= VoiceDirector.hopInterval,
      };
      if (paired !== null) cue.pairedOneShot = paired;
      cues.push(cue);
    }
    return cues;
  }

  /// The audio thread shifted a late phrase: re-send its cues (and later phrases' cues) at the actual time.
  private retimeIfShifted(): void {
    this.retime(this._renderer.lastStarted(), this.lastStartedSeen);
    this.retime(this.replyRenderer.lastStarted(), this.replyLastStartedSeen);
  }

  private retime(started: { id: number; hostTime: number } | null, seen: { id: number; hostTime: number }): void {
    if (!started || (started.id === seen.id && started.hostTime === seen.hostTime)) return;
    seen.id = started.id; seen.hostTime = started.hostTime;
    const idx = this.records.findIndex((r) => r.phrase.id === started.id);
    if (idx < 0) return;
    const rec = this.records[idx];
    const actual = started.hostTime;
    const delta = actual - rec.startHostTime;
    const firstCue = rec.cues[0]?.hostTime;
    if (!(Math.abs(delta) > 0.002) || firstCue === undefined) return;
    rec.startHostTime = actual;
    for (const c of rec.cues) c.hostTime += delta;
    this.retimedPhraseCount += 1;
    const cutoff = Math.min(firstCue, rec.cues[0]?.hostTime ?? firstCue);
    this.engine.send(FaceCommand.cancelVocalCues(cutoff));
    for (const r of this.records) for (const c of r.cues) if (c.hostTime >= cutoff) this.engine.send(FaceCommand.vocalCue(c));
    if (rec.audible) {
      if (rec.onReply) this.reply.audibleUntil = Math.max(this.reply.audibleUntil, rec.audibleEnd + VoiceDirector.audibleTail);
      else this.audibleUntil = Math.max(this.audibleUntil, rec.audibleEnd + VoiceDirector.audibleTail);
      this.onPlayout?.(rec.startHostTime + rec.latency, rec.audibleEnd);
    }
    if (this.lastScheduled?.phrase.id === started.id) this.lastScheduled = rec;
  }

  private autoAllowed(reaction: VoiceReaction, now: number): boolean {
    const st = this.engine.state;
    if (!(this._settings.autoVocalize && !this.isSpeaking && st.agentState !== 'speaking')) return false;
    // A babble reply (and its answer chirp) is Yanni speaking: no auto chirp over it, e.g. for the nod it opens.
    if (now < this.reply.audibleUntil) return false;
    if (this._settings.quietMode || this._settings.muted) return false;
    if (this._isBedtime) {
      if (!(this._settings.bedtimeSounds === 'quiet' && VoiceDirector.bedtimeReactions.has(reaction))) return false;
    }
    const urgent = VoiceDirector.urgentAutoReactions;
    const interval = urgent.has(reaction) ? VoiceDirector.urgentAutoInterval : VoiceDirector.autoInterval;
    if (now - this.lastPhraseTime < interval) return false;
    const t = this.lastAutoTime.get(reaction);
    if (t !== undefined && now - t < VoiceDirector.cooldown(reaction)) return false;
    const touched = st.tapAnnoyance > 0.01 || st.tickleLaugh > 0;   // a tap or tickle is interaction, not ambient
    if ((st.agentState === 'idle' || st.agentState === 'noticing') && !touched && !urgent.has(reaction)) {
      for (const [r, at] of this.lastAutoTime) {
        if (!urgent.has(r) && now - at < VoiceDirector.idleAmbientInterval) return false;
      }
    }
    return true;
  }

  // MARK: - Settings / output

  private applySettings(): void {
    const s = this._settings;
    const muted = s.muted || s.quietMode || (this._isBedtime && s.bedtimeSounds === 'off');
    const volume = Math.min(Math.max(s.volume, 0), 1) * (this._isBedtime ? VoiceDirector.bedtimeVolume : 1);
    this.rendererMuted = muted;
    this.rendererVolume = volume;
    this._renderer.setMuted(muted);
    this._renderer.setVolume(volume);
    // The reply is not a chirp: never muted; voice volume, × the night factor at a bedtime night wake.
    this.replyGain = this._isBedtime ? this._replySettings.nightVoiceFactor : 1;
    this.replyRenderer.setMuted(false);
    this.replyRenderer.setVolume(Math.min(Math.max(s.volume, 0), 1));
    this.replyRenderer.setGain(this.replyGain);
  }

  private hookOutput(): void {
    const out = this._output;
    if (!out) return;
    out.onConfigurationChange = () => this.outputConfigurationChanged();
    out.attachReply?.(this.replyRenderer);
  }

  /// Latency and IO buffer are re-read at every schedule; a new sample rate needs a new renderer.
  private outputConfigurationChanged(): void {
    const out = this._output;
    if (!out) return;
    const rate = out.sampleRate;
    if (rate > 0 && Math.abs(rate - this._renderer.sampleRate) > 0.5) this.replaceRenderer(this.makeRenderer(rate));
    if (rate > 0) this.replyRenderer.setSampleRate(rate);   // re-rated in place, between renders
  }

  get oneShotRate(): number {
    const r = OneShotSampler.speedRange;
    const sp = this.engine.state.modulation.speed;
    return Number.isFinite(sp) ? Math.min(Math.max(sp, r[0]), r[1]) : 1;
  }

  private get expressionInfluence(): number {
    // MoodColor may not be registered yet in the port: Swift's `as? MoodColor` fallback (0.5) covers it.
    const m = this.engine.director.modifier('MoodColor') as unknown as { expressionInfluence?: number } | undefined;
    return m?.expressionInfluence ?? 0.5;
  }

  // MARK: - Reply (VoiceDirector+Reply.ts)

  get isReplying(): boolean { return Reply.isReplying(this); }
  get replyAudibleUntilHostTime(): number { return this.reply.audibleUntil; }
  get replyStartHostTime(): number | null { return this.reply.origin; }
  get replyDuration(): number { return Reply.replyDuration(this); }
  beginReply(seed: bigint): void { this.reply.begin(seed); }
  beginReplyTurn(turnId: string): void { Reply.beginReplyTurn(this, turnId); }
  babbleAffect(tag: SentenceTag | null): VoiceAffect { return Reply.babbleAffect(this, tag); }
  voiceReplyChunk(chunk: ReplyChunk, withFace = false): VoicedReplyChunk { return Reply.voiceReplyChunk(this, chunk, withFace); }
  cancelReply(): void { Reply.cancelReply(this); }
  replyChirp(r: VoiceReaction): ScheduledPhrase { return Reply.replyChirp(this, r); }
  scheduleReply(planned: Phrase, start: number, latency: number, paired: OneShotKind | null, now: number): ScheduledPhrase {
    return Reply.scheduleReply(this, planned, start, latency, paired, now);
  }

  // MARK: - Tables

  static readonly bedtimeReactions: ReadonlySet<VoiceReaction> = new Set<VoiceReaction>(['sleepy', 'sheepish']);

  static soundAllowed(r: VoiceReaction, s: VoiceSettings, bedtime: boolean): boolean {
    return !(bedtime && s.bedtimeSounds === 'quiet' && !VoiceDirector.bedtimeReactions.has(r));
  }

  /// Per-reaction cooldown for auto phrases (s).
  static cooldown(r: VoiceReaction): number {
    switch (r) {
      case 'engaged': case 'embarrassed': case 'sheepish': return 4;
      case 'sleepy': return 6;
      case 'curious': case 'confused': case 'hmph': case 'doubleTake': return 3;
      case 'startled': case 'delighted': case 'giggle': case 'danceBeat': case 'emote': return 2;
      case 'mmHm': case 'mmHmBig': case 'uhUh': case 'nuhUh': return 1.5;   // answers can come turn after turn
      case 'babble': return 0;                                              // a reply, never an auto-vocalisation
    }
  }

  /// Reaction → the one-shot the director plays with it (`react(withFace:)`).
  static readonly oneShotPairs: readonly (readonly [VoiceReaction, OneShotKind])[] = [
    ['engaged', 'perkUp'], ['startled', 'bigSurprise'], ['delighted', 'delightedSquint'], ['curious', 'curiousTilt'],
    ['sleepy', 'yawn'], ['giggle', 'laugh'], ['danceBeat', 'dance'], ['hmph', 'mockOffense'],
    ['doubleTake', 'doubleTake'], ['confused', 'confusedShake'], ['embarrassed', 'lookAway'],
    ['mmHm', 'nodYes'], ['mmHmBig', 'nodYesBig'], ['uhUh', 'shakeNo'], ['nuhUh', 'shakeNoBig'],
  ];

  /// The face one-shot paired with a reaction, if any.
  static pairedOneShot(r: VoiceReaction): OneShotKind | null {
    return VoiceDirector.oneShotPairs.find((p) => p[0] === r)?.[1] ?? null;
  }

  /// The reaction that vocalizes a face one-shot, if any. sorryBlink stays silent here (it plays during
  /// barge-in, when Yanni must not make sound); stretch and sideEye are silent in the generator's table.
  static reactionForOneShot(k: OneShotKind): VoiceReaction | null {
    return k === 'sorryBlink' ? null : VoiceReactionTables.forOneShot(k);
  }

  /// Reactions on agent-state entry.
  static reactionForStateEntry(s: AgentState): VoiceReaction | null { return VoiceReactionTables.forAgentStateEntry(s); }

  /// First accent of a one-shot at rate 1 (s), measured from its authored curves.
  static accentTime(k: OneShotKind): number { return OneShotLibrary.spec(k).accentTimes[0] ?? 0; }

  /// The note lined up with a one-shot accent (the generator's per-reaction choice).
  static accentIndex(p: Phrase): number { return PhraseGenerator.alignNoteIndex(p); }

  /// Note gain factor of a soft phrase (−6 dB) and its note-length factor.
  static readonly softGain = 0.5;
  static readonly softDuration = 0.75;

  /// A softer, shorter take on `p` (perception's nod mirror, `StartedOneShot.softVoice`: "mm-hm" agreeing along
  /// rather than answering): every note's gain × `softGain` (−6 dB) and length × `softDuration`. Onsets, contours
  /// and accents are kept, so the notes still land on the one-shot's beats.
  static softened(p: Phrase): Phrase {
    const out = p.copy();
    for (const n of out.notes) {
      n.gain *= VoiceDirector.softGain;
      n.duration *= VoiceDirector.softDuration;
    }
    return out;
  }

  static cueKind(r: VoiceReaction, i: number, n: number, note: Note): VocalCueKind {
    switch (r) {
      case 'startled': return 'startle';
      case 'sleepy': return 'sleepy';
      case 'babble':
        // A babbled question's last note asks, like curious.
        return note.contour.end - note.contour.start >= 3 && i === n - 1 ? 'question' : 'plain';
      case 'sheepish': return 'wobble';
      case 'curious': case 'confused': case 'doubleTake':
        if (i === 0) return 'curious';
        if (i === n - 1 && note.contour.end > note.contour.start) return 'question';
        return 'plain';
      default: return 'plain';
    }
  }

  /// Attack sharpness 0…1 from the envelope's attack time constant (2 ms → 1, 30 ms → 0).
  static articulation(e: Envelope): number {
    const tau = Number.isFinite(e.attackTau) ? e.attackTau : 0.008;
    return Math.min(Math.max(1 - (tau - 0.002) / 0.028, 0), 1);
  }

  /// The same affect point MoodColor uses (shared so sound and face read one snapshot).
  static effectivePAD(s: FaceState, expressionInfluence: number): V3 {
    return FaceAffect.effectivePAD(s, expressionInfluence);
  }
}
