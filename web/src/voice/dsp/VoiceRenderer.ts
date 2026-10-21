// Port of FaceVoice/DSP/VoiceRenderer.swift.
// port-note: host times are seconds (`HostClock`, performance.now()/1000) instead of mach ticks, and there are no
// atomics: in the browser the renderer runs inside the AudioWorklet (playback/voiceWorklet.ts) and the main thread
// talks to it through `VoiceRendererPort`; node tests call `render` directly. The Swift warm-up render (JIT/metadata
// touch) is dropped: it leaves no state behind.
import { HostClock } from '../host/VoiceOutput';
import { VoiceFingerprint } from '../model/VoiceFingerprint';
import type { Phrase } from '../model/VoiceModel';
import { roundSchool } from '../generate/VoiceRNG';
import { PhraseRing, type QueuedPhrase } from './PhraseRing';
import { PhraseVoice, type VoiceStage } from './PhraseVoice';
import { SineTable, softLimit, volumeGain } from './VoiceDSP';

/// The producer-side surface the director needs (the real renderer, or the worklet port in the browser).
export interface VoiceRendererLike {
  readonly sampleRate: number;
  setSampleRate(rate: number): void;
  setFingerprint(fp: VoiceFingerprint): void;
  enqueue(phrase: Phrase, startHostTime: number, timeStretch?: number): boolean;
  cancelAll(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setGain(gain: number): void;
  readonly gain: number;
  lastStarted(): { id: number; hostTime: number } | null;
  readonly isSounding: boolean;
}

/// Real-time voice synthesizer: phrases are queued (8 slots, full → the newest is rejected), `cancelAll` bumps a
/// generation (older voices fade out, older queued phrases drop), volume/mute/gain are smoothed over 20 ms and the
/// fingerprint is snapshotted into each phrase at enqueue.
///
/// Scheduling: each phrase's start host time is converted once (at dequeue) to a sample index on the renderer's own
/// sample clock. Up to 150 ms late → the whole phrase is shifted to start now and the actual start is published
/// (`lastStarted()`); more than 150 ms late → dropped (this also prevents bursts after the engine was stopped).
/// Host time comes from the render call when valid; otherwise the renderer anchors sampleTime ↔ hostTime once and
/// extrapolates.
export class VoiceRenderer implements VoiceRendererLike {
  /// Phrase voices in the active table (current phrase + release tails).
  static readonly voiceCapacity = 3;
  /// Phrases later than this at dequeue are dropped; earlier lateness shifts the phrase.
  static readonly maxLateness = 0.150;

  // Producer → consumer state.
  private readonly ring = new PhraseRing();
  private cancelGeneration = 0;
  private volume = 1;
  private muted = false;
  private gainValue = 1;
  private baseHz = VoiceFingerprint.default.basePitchHz;
  private maxHz = VoiceFingerprint.default.maxPitchHz;
  private loudness = VoiceFingerprint.default.loudness;
  private requestedRate: number;
  private pendingRate = 0;
  // Consumer → producer.
  private lastStartedPair: { id: number; hostTime: number } | null = null;
  private soundingFlag = false;

  // Renderer-owned state.
  private fs: number;
  private masterStep: number;          // linear master ramp per sample (full scale in 20 ms)
  private clock = 0;                   // renderer sample clock at the current buffer start
  private master = 1;                  // smoothed volume × mute
  private prevSilent = true;           // previous buffer had no voices (master may snap without a click)
  private seenGeneration = 0;
  private lastHost = 0;                // host time of the previous buffer (0 = none)
  private lastFrames = 0;
  private anchorValid = false;         // sampleTime ↔ hostTime anchor for buffers without a valid host time
  private anchorHost = 0;
  private anchorSample = 0;
  private lastSampleTime = -1;
  private seed = 0x12345678;
  private readonly voices: PhraseVoice[] = [];
  private readonly sineTable = SineTable.make();

  constructor(sampleRate: number) {
    const rate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.requestedRate = rate;
    this.fs = rate;
    this.masterStep = 1 / (0.020 * rate);
    for (let i = 0; i < VoiceRenderer.voiceCapacity; i++) this.voices.push(new PhraseVoice());
  }

  private setRate(rate: number): void {
    this.fs = rate;
    this.masterStep = 1 / (0.020 * rate);
  }

  // MARK: Producer API

  /// The sample rate the renderer runs at (the most recently requested one; see `setSampleRate`).
  get sampleRate(): number { return this.requestedRate; }

  /// Re-rates the renderer in place (e.g. after a route change). Adopted at the start of the next render — never
  /// mid-buffer — and silences any playing voices. Queued phrases survive.
  setSampleRate(rate: number): void {
    if (!(Number.isFinite(rate) && rate >= 8000) || rate === this.sampleRate) return;
    this.requestedRate = rate;
    this.pendingRate = rate;
  }

  /// Sets the voice identity used for phrases enqueued from now on (base pitch, pitch cap, loudness).
  setFingerprint(fp: VoiceFingerprint): void {
    this.baseHz = Math.max(fp.basePitchHz, 20);
    this.maxHz = Math.max(fp.maxPitchHz, 20);
    this.loudness = Math.min(Math.max(fp.loudness, 0), 1);
  }

  /// Queues a phrase to start at `startHostTime` (host seconds; audible at + output latency). `timeStretch` > 1
  /// slows timing (slow-motion preview) without changing pitch. Returns false if the queue is full.
  enqueue(phrase: Phrase, startHostTime: number, timeStretch = 1): boolean {
    return this.ring.push({
      phrase: phrase.copy(), startHostTime,
      timeStretch: Number.isFinite(timeStretch) ? Math.min(Math.max(timeStretch, 1), 16) : 1,
      generation: this.cancelGeneration, baseHz: this.baseHz, maxHz: this.maxHz, loudness: this.loudness,
    });
  }

  /// Fades out everything playing or queued before this call (generation bump; ≤ 20 ms fade); later enqueues
  /// are unaffected.
  cancelAll(): void { this.cancelGeneration = (this.cancelGeneration + 1) >>> 0; }

  /// Linear 0…1 user volume (mapped to −40 dB…0 dB internally); smoothed over 20 ms. Default 1.
  setVolume(volume: number): void { this.volume = Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 1) : 0; }

  /// Silences output (smoothed 20 ms) without dropping the schedule (face cues still run).
  setMuted(muted: boolean): void { this.muted = muted; }

  /// A linear factor on top of the volume (smoothed with it), 0…1. The reply renderer's night factor at a bedtime
  /// night wake (voice volume × 0.5, like spoken replies). Default 1.
  setGain(gain: number): void { this.gainValue = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 1; }

  /// The linear factor last set with `setGain`.
  get gain(): number { return this.gainValue; }

  /// The most recent phrase start actually performed: (phrase id, host seconds of its first sample — later than
  /// requested when the phrase was shifted for lateness).
  /// Treat as read-only: a fresh object per start (no allocation per render quantum).
  lastStarted(): { readonly id: number; readonly hostTime: number } | null { return this.lastStartedPair; }

  /// True while any voice is sounding.
  get isSounding(): boolean { return this.soundingFlag; }

  /// Test hook: stage of voice `i` in the active table.
  debugVoiceStage(i: number): VoiceStage { return this.voices[i].stage; }

  // MARK: Render

  /// Renders `frameCount` mono samples into `buffer` from `offset` (overwrites). `hostTime` is the buffer's output
  /// host time in seconds when valid, else null; `sampleTime` the buffer's sample time when valid.
  render(frameCount: number, hostTime: number | null, buffer: Float32Array, sampleTime: number | null = null, offset = 0): void {
    if (!(frameCount > 0)) return;

    // Rate change requested between renders.
    const pending = this.pendingRate;
    this.pendingRate = 0;
    if (pending !== 0) {
      this.setRate(pending);
      for (const v of this.voices) v.free();
      this.lastHost = 0;
      this.anchorValid = false;
    }

    const bufferHost = this.resolveHostTime(hostTime, sampleTime);
    this.handleDiscontinuity(bufferHost);
    this.applyCancel();
    this.dequeue(bufferHost, frameCount);

    // Master target.
    const target = this.muted ? 0 : volumeGain(this.volume) * this.gainValue;

    let anyVoice = false;
    for (const v of this.voices) if (v.stage !== 'free') { anyVoice = true; break; }

    buffer.fill(0, offset, offset + frameCount);
    // While nothing was sounding the output was silent, so the master gain may jump straight to its target.
    if (!anyVoice || this.prevSilent) this.master = target;
    this.prevSilent = !anyVoice;
    if (!anyVoice) {
      this.soundingFlag = false;
      this.finishBuffer(bufferHost, frameCount);
      return;
    }

    let sounding = false;
    const fs = this.fs;
    for (const v of this.voices) {
      if (v.stage === 'free') continue;
      let n = 0;
      if (v.stage === 'pending') {
        const off = v.startSample - this.clock;
        if (off >= frameCount) continue;
        n = Math.max(off, 0);
        v.stage = 'active';
        const actual = bufferHost + n / fs;
        this.lastStartedPair = { id: v.q.phrase.id, hostTime: actual };
      }
      sounding = true;
      let alive = true;
      while (n < frameCount) {
        if (v.blockLeft === 0) {
          if (!alive) break;
          alive = v.control(fs);
          v.blockLeft = v.blockSize;
        }
        const m = Math.min(v.blockLeft, frameCount - n);
        v.renderSamples(buffer, offset + n, m, this.sineTable);
        v.blockLeft -= m;
        n += m;
      }
      if (!alive || !Number.isFinite(v.amp)) v.free();
    }

    // Master gain (linear 20 ms ramp), soft limiter, final NaN guard.
    let master = this.master;
    const step = this.masterStep;
    for (let i = 0; i < frameCount; i++) {
      const d = target - master;
      master += Math.min(Math.max(d, -step), step);
      let x = buffer[offset + i] * master;
      if (!Number.isFinite(x)) x = 0;
      buffer[offset + i] = softLimit(x);
    }
    this.master = master;
    this.soundingFlag = sounding;
    this.finishBuffer(bufferHost, frameCount);
  }

  // MARK: Render helpers

  private finishBuffer(host: number, frames: number): void {
    this.clock += frames;
    this.lastHost = host;
    this.lastFrames = frames;
  }

  /// Host time of this buffer: the given one when valid (and re-anchor), else extrapolated from the anchor
  /// (by sample time when given, else by the renderer's own sample clock), else anchored to now.
  private resolveHostTime(hostTime: number | null, sampleTime: number | null): number {
    const st = sampleTime ?? this.clock;
    if (hostTime !== null && hostTime !== 0) {
      this.anchorValid = true;
      this.anchorHost = hostTime;
      this.anchorSample = st;
      this.lastSampleTime = st;
      return hostTime;
    }
    // Sample timeline restarted (engine restart): re-anchor.
    if (this.anchorValid && st < this.lastSampleTime) this.anchorValid = false;
    this.lastSampleTime = st;
    if (this.anchorValid) return this.anchorHost + (st - this.anchorSample) / this.fs;
    const now = HostClock.now();
    this.anchorValid = true;
    this.anchorHost = now;
    this.anchorSample = st;
    return now;
  }

  /// If host time jumped relative to the sample clock (engine stopped/restarted, hiccup), re-convert pending
  /// voices from their host start times and apply the lateness rule, so nothing bursts after a stop.
  private handleDiscontinuity(host: number): void {
    if (this.lastHost === 0) return;
    const predicted = this.lastHost + this.lastFrames / this.fs;
    if (!(Math.abs(host - predicted) > 0.020)) return;
    for (const v of this.voices) {
      if (v.stage !== 'pending') continue;
      const s = this.startSampleFor(v.q.startHostTime, host);
      if (s === null) { v.free(); continue; }
      v.startSample = s;
    }
  }

  /// Sample index for a host start time, or null when more than `maxLateness` late.
  private startSampleFor(startHost: number, bufferHost: number): number | null {
    if (startHost <= bufferHost) {
      const late = bufferHost - startHost;
      return late > VoiceRenderer.maxLateness ? null : this.clock;
    }
    const ahead = roundSchool((startHost - bufferHost) * this.fs);
    return this.clock + Math.min(ahead, 1e15);
  }

  private applyCancel(): void {
    const g = this.cancelGeneration;
    if (g === this.seenGeneration) return;
    this.seenGeneration = g;
    for (const v of this.voices) {
      switch (v.stage) {
        case 'free': break;
        case 'pending': if (v.q.generation !== g) v.free(); break;
        case 'active': if (v.q.generation !== g) v.beginFadeOut(); break;
      }
    }
  }

  private dequeue(bufferHost: number, frameCount: number): void {
    const g = this.seenGeneration;
    let item: QueuedPhrase | null;
    while ((item = this.ring.peek()) !== null) {
      if (item.generation !== g) { this.ring.pop(); continue; }
      const s = this.startSampleFor(item.startHostTime, bufferHost);
      if (s === null) { this.ring.pop(); continue; }
      const slot = this.voices.findIndex((v) => v.stage === 'free');
      if (slot < 0) {
        // Table full: fade out the oldest non-fading voice once the new phrase is due; retry next buffer.
        if (s < this.clock + frameCount) this.stealOldest();
        return;
      }
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
      this.voices[slot].activate(item, s, this.fs, this.seed);
      this.ring.pop();
    }
  }

  private stealOldest(): void {
    let oldest = -1;
    let oldestStart = Infinity;
    this.voices.forEach((v, i) => {
      if (v.stage === 'active' && !v.cancelling && v.startSample < oldestStart) { oldestStart = v.startSample; oldest = i; }
    });
    if (oldest >= 0) this.voices[oldest].beginFadeOut();
  }
}
