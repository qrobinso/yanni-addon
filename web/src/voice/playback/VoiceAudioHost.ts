// The Web Audio voice output (port-note: replaces Host/VoiceAudioHost.swift's AVAudioEngine host).
//
// Playback design: one AudioWorkletNode ('yanni-voice') runs the ported `VoiceRenderer`s (chirps + babble reply) on
// the audio thread, 128 frames per quantum, exactly as the Swift source node pulls its renderer. Chosen over
// pre-rendered AudioBufferSourceNodes because (1) synthesis stays off the main thread, so the face's frame budget never
// pays for a phrase (a 1 s phrase is ~5 ms of JS), (2) the renderer's own scheduling rules port unchanged: the
// lateness shift/drop, cancel generations with 20 ms fades, voice stealing, the 20 ms volume/mute ramp and the soft
// limiter over the mix, and (3) cancel is immediate (a buffer source can only be stopped or ramped from outside).
//
// Timing: host seconds are `performance.now()/1000`. A quantum at context time c is heard at the output timestamp's
// performance time; the worklet's buffer host time is that minus `outputLatency` (the Swift contract: buffer host
// time + outputLatency = audible), sent as an offset to the worklet's `currentTime`.
//
// iOS Silent switch: there is no web equivalent (port-note); Sounds off / quiet mode / bedtime are the director's.
// Audio unlock: browsers start an AudioContext suspended until a user gesture — `installAudioUnlock`.
import type { VoiceRendererLike } from '../dsp/VoiceRenderer';
import { HostClock, type VoiceOutput } from '../host/VoiceOutput';
import type { VoiceFingerprint } from '../model/VoiceFingerprint';
import type { Phrase } from '../model/VoiceModel';
import { phraseToData, type FromWorklet, type RendererId, type ToWorklet } from './protocol';
import workletUrl from './voiceWorklet.ts?worker&url';

/// The director's view of one renderer living in the worklet.
export class VoiceRendererPort implements VoiceRendererLike {
  private gainValue = 1;
  private started: { id: number; hostTime: number } | null = null;
  private sounding = false;
  constructor(private readonly host: VoiceAudioHost, readonly id: RendererId) {}

  get sampleRate(): number { return this.host.sampleRate; }
  /// The worklet runs at the context's rate for its whole life (a new rate means a new AudioContext).
  setSampleRate(_rate: number): void {}
  setFingerprint(fp: VoiceFingerprint): void {
    this.host.post({ t: 'setFingerprint', r: this.id, basePitchHz: fp.basePitchHz, maxPitchHz: fp.maxPitchHz, loudness: fp.loudness });
  }
  /// port-note: the Swift ring answers "full" synchronously; across the message hop the worklet's renderer applies
  /// the same 8-slot rule but the answer can't come back in time, so this reports whether the message was sent.
  enqueue(phrase: Phrase, startHostTime: number, timeStretch = 1): boolean {
    this.host.syncClock();
    return this.host.post({ t: 'enqueue', r: this.id, phrase: phraseToData(phrase), start: startHostTime, stretch: timeStretch });
  }
  cancelAll(): void { this.host.post({ t: 'cancelAll', r: this.id }); }
  setVolume(v: number): void { this.host.post({ t: 'setVolume', r: this.id, v }); }
  setMuted(v: boolean): void { this.host.post({ t: 'setMuted', r: this.id, v }); }
  setGain(v: number): void {
    this.gainValue = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
    this.host.post({ t: 'setGain', r: this.id, v });
  }
  get gain(): number { return this.gainValue; }
  lastStarted(): { id: number; hostTime: number } | null { return this.started; }
  get isSounding(): boolean { return this.sounding; }

  /// Worklet reports.
  receive(m: FromWorklet): void {
    if (m.t === 'started') this.started = { id: m.id, hostTime: m.hostTime };
    else this.sounding = m.v;
  }
}

export class VoiceAudioHost implements VoiceOutput {
  readonly chirp = new VoiceRendererPort(this, 'chirp');
  readonly reply = new VoiceRendererPort(this, 'reply');
  onConfigurationChange: (() => void) | null = null;
  private node: AudioWorkletNode | null = null;
  private pending: ToWorklet[] = [];
  private loading: Promise<void> | null = null;
  private offset = Number.NaN;

  /// `destination`: where the voice goes (default the context's destination; the conversation's playout path when
  /// it has one, so the browser's echo canceller hears it).
  constructor(readonly ctx: AudioContext, private readonly destination: AudioNode = ctx.destination) {
    ctx.addEventListener('statechange', () => this.onConfigurationChange?.());
  }

  get sampleRate(): number { return this.ctx.sampleRate; }
  get outputLatency(): number { return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0); }
  /// One render quantum.
  get ioBufferDuration(): number { return 128 / this.ctx.sampleRate; }
  get isRunning(): boolean { return this.node !== null && this.ctx.state === 'running'; }

  /// The renderers are created by the host (they live in its worklet); attaching just checks that.
  attach(renderer: VoiceRendererLike): void {
    if (renderer !== this.chirp) throw new Error('VoiceAudioHost renders only its own `chirp` port');
  }
  attachReply(_renderer: VoiceRendererLike): void {}

  /// Loads the worklet and connects it (the context still needs a gesture to run: `installAudioUnlock`).
  async start(): Promise<void> {
    this.loading ??= this.ctx.audioWorklet.addModule(workletUrl).then(() => {
      const node = new AudioWorkletNode(this.ctx, 'yanni-voice', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => (e.data.r === 'chirp' ? this.chirp : this.reply).receive(e.data);
      node.connect(this.destination);
      this.node = node;
      this.syncClock();
      for (const m of this.pending) node.port.postMessage(m);
      this.pending = [];
    });
    await this.loading;
    await this.ctx.resume().catch(() => {});
    this.onConfigurationChange?.();
  }

  stop(): void {
    this.node?.disconnect();
    this.node?.port.close();
    this.node = null;
    this.loading = null;
    this.offset = Number.NaN;
  }

  /// Sends a message (queued until the worklet exists; settings set before start still apply).
  post(m: ToWorklet): boolean {
    if (this.node) { this.node.port.postMessage(m); return true; }
    if (m.t !== 'enqueue') this.pending.push(m);
    return false;
  }

  /// Keeps the worklet's host-time offset current (it drifts slowly with the output clock); only real changes are
  /// sent, since a jump > 20 ms reads as a discontinuity to the renderer.
  syncClock(): void {
    if (!this.node) return;
    const ts = this.ctx.getOutputTimestamp?.();
    const offset = ts && ts.performanceTime !== undefined && ts.contextTime !== undefined && ts.performanceTime > 0
      ? ts.performanceTime / 1000 - ts.contextTime - this.outputLatency
      : HostClock.now() - this.ctx.currentTime;
    if (Number.isFinite(this.offset) && Math.abs(offset - this.offset) < 0.002) return;
    this.offset = offset;
    this.node.port.postMessage({ t: 'hostOffset', offset } satisfies ToWorklet);
  }
}

/// Resumes the context on the first pointer or key gesture (browsers keep it suspended until then). Returns a
/// remover.
export function installAudioUnlock(ctx: AudioContext, target: EventTarget = window): () => void {
  const events = ['pointerdown', 'keydown', 'touchend'];
  const unlock = (): void => {
    void ctx.resume().then(() => { if (ctx.state === 'running') remove(); });
  };
  const remove = (): void => { for (const e of events) target.removeEventListener(e, unlock); };
  for (const e of events) target.addEventListener(e, unlock);
  return remove;
}

/// Marks Yanni's audible windows in the conversation's echo rule (`ConversationAudio.markPlayout`) and cuts them on
/// barge-in, so turn detection ignores the face's own chirps and babble.
export function connectPlayout(
  director: { onPlayout: ((a: number, b: number) => void) | null; onPlayoutCut: ((t: number) => void) | null },
  audio: { markPlayout(start: number, end: number): void; audibility: { cutAfter(at: number): void } },
): void {
  director.onPlayout = (a, b) => audio.markPlayout(a, b);
  director.onPlayoutCut = (t) => audio.audibility.cutAfter(t);
}
