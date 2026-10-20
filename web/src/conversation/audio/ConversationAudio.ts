// The Web Audio front end (port-note: the platform part of ConversationAudio/ConversationAudioEngine.swift). One
// AudioContext for the microphone and Yanni's playout:
// - `startMic()`: getUserMedia with the browser's echo cancellation, noise suppression and auto gain (the iPad uses
//   Apple's voice processing I/O), → the capture worklet (16 kHz, 512-sample frames) → `TurnAudioPump` → `onFrame`.
// - `onLevel`: the pump's smoothed, noise-gated mic level (MicLevelMeter), per 10 ms tick while the mic is open.
// - `markPlayout(start, end)`: Yanni is audible over [start, end] host seconds (the echo rule's window). `playPcm`
//   schedules reply audio and marks its loud spans itself; `flushPlayout` is barge-in's 30 ms fade.
// Host seconds are `performance.now() / 1000`.
import type { CaptureFrameMessage } from './captureWorklet';
import workletUrl from './captureWorklet.ts?worker&url';
import { PlayoutAudibility } from './PlayoutAudibility';
import { hostNow, TurnAudioPump } from './TurnAudioPump';

export class ConversationAudio {
  readonly pump = new TurnAudioPump();
  readonly audibility = new PlayoutAudibility();
  /** Each 16 kHz frame (512 samples, a fresh array) and the host time just after its last sample. */
  onFrame: ((samples: Float32Array, endHostTime: number) => void) | null = null;

  private ctx: AudioContext | null = null;
  private worklet: Promise<void> | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private playoutGain: GainNode | null = null;
  private playoutEnd = 0;
  private sources = new Set<AudioBufferSourceNode>();

  set onLevel(fn: ((level: number, db: number) => void) | null) { this.pump.onLevel = fn; }
  get onLevel(): ((level: number, db: number) => void) | null { return this.pump.onLevel; }

  get context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.playoutGain = this.ctx.createGain();
      this.playoutGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get micOpen(): boolean { return this.stream !== null; }

  /** Opens the microphone (needs a user gesture the first time for the AudioContext). Idempotent. */
  async startMic(): Promise<void> {
    if (this.stream) return;
    const ctx = this.context;
    await ctx.resume();
    this.worklet ??= ctx.audioWorklet.addModule(workletUrl);
    await this.worklet;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
    });
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, 'yanni-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    this.node.port.onmessage = (e: MessageEvent<CaptureFrameMessage>) => this.frame(e.data);
    // A muted sink keeps the worklet pulled by the graph on every browser.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
    this.pump.noteDiscontinuity('newGeneration');
    this.pump.start();
  }

  /** Closes the microphone (the privacy gate): nothing more is captured. Idempotent. */
  stopMic(): void {
    this.pump.stop();
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
  }

  /** Yanni may be audible over [start, end] host seconds (chirps, greeting, any sound played outside `playPcm`). */
  markPlayout(start: number, end: number): void {
    this.audibility.markPlayout(start, end);
  }

  /** Host seconds of an AudioContext time. */
  hostTime(contextTime: number): number {
    const ctx = this.context;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.performanceTime / 1000 + (contextTime - ts.contextTime);
    }
    return hostNow() - (ctx.currentTime - contextTime);
  }

  /** Queues reply audio after whatever is playing and marks its loud spans; returns its host-time span. */
  playPcm(samples: Float32Array, rate: number): { start: number; end: number } {
    const ctx = this.context;
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.playoutGain!);
    const at = Math.max(ctx.currentTime + 0.02, this.playoutEnd);
    src.start(at);
    this.playoutEnd = at + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    this.playoutGain!.gain.cancelScheduledValues(at);
    this.playoutGain!.gain.setValueAtTime(1, at);
    this.audibility.outputLatency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const host0 = this.hostTime(at);
    for (const [a, b] of PlayoutAudibility.loudSpans(samples, rate)) this.audibility.markPlayout(host0 + a, host0 + b);
    return { start: host0, end: host0 + buf.duration };
  }

  /** Barge-in: a 30 ms fade, then everything queued is dropped. */
  flushPlayout(): void {
    if (!this.ctx || !this.playoutGain) return;
    const now = this.ctx.currentTime;
    const g = this.playoutGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.03);
    for (const s of this.sources) s.stop(now + 0.03);
    this.sources.clear();
    this.playoutEnd = 0;
    this.audibility.cutAfter(this.hostTime(now + 0.03));
  }

  private frame(m: CaptureFrameMessage): void {
    const end = this.hostTime(m.endFrame / m.inputRate);
    this.onFrame?.(m.samples, end);
    this.pump.push(m.samples, end, m.inputFrames);
  }
}
