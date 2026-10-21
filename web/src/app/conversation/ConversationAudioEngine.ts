// The controller's `ConversationAudioControl` on the browser's one AudioContext (port of the control surface of
// ConversationAudio/ConversationAudioEngine.swift and PlayoutTap.swift, over `ConversationAudio` and `PlayoutQueue`):
// - conversation mode opens the microphone (the iPad's voice processing I/O); ambient closes it. Without permission it
//   runs output-only, as the iPad does.
// - the privacy gate: while capture is off no microphone sample reaches turn detection (the pump is stopped) or the ASR
//   tap (frames are dropped here).
// - the Spoken voice's speech envelope: 5 ms RMS blocks of the reply audio (pre-gain, −50 dBFS → 0, −10 dBFS → 1),
//   stamped with their audible host time, released as they would render (the face's speech level, the talking bounce).
// - clips (greeting, listen cue) decoded ahead and scheduled at a host time.
import type { ConversationAudio } from '../../conversation/audio/ConversationAudio';
import type { AsrAudioTap } from '../../conversation/audio/AsrAudioTap';
import { PlayoutQueue } from '../../conversation/audio/PlayoutQueue';
import { hostNow } from '../../conversation/audio/TurnAudioPump';
import type { ConversationAudioControl, PlayoutSnapshot } from '../../conversation/core/Ports';

export type MicrophonePermission = 'notUsed' | 'undetermined' | 'granted' | 'denied';

export class ConversationAudioEngine implements ConversationAudioControl {
  /** PlayoutTap.envelopeHop. */
  static readonly envelopeHop = 0.005;
  /** About 1.3 s of envelope kept for `speechLevel` (SpeechLevelMeter.capacity). */
  static readonly envelopeCapacity = 256;

  readonly playout: PlayoutQueue;
  microphone: MicrophonePermission = 'undetermined';
  /** One line per audio event (never samples). */
  onLog: ((line: string) => void) | null = null;

  private mode = false;
  private switching = false;
  private generation = 0;
  private capture = false;
  private gain = 1;
  /** Envelope (level, audible host time), oldest first; `cursor` = the first not yet drained. */
  private levels: number[] = [];
  private times: number[] = [];
  private cursor = 0;
  private clips = new Map<string, AudioBuffer | 'loading' | 'failed'>();
  private clipSource: AudioBufferSourceNode | null = null;

  constructor(readonly audio: ConversationAudio, readonly asr: AsrAudioTap, private readonly now: () => number = hostNow) {
    this.playout = new PlayoutQueue({
      playPcm: (s, r) => this.playPcm(s, r),
      flushPlayout: () => audio.flushPlayout(),
      get context() { return audio.context; },
    }, now);
    audio.onFrame = (samples, end) => { if (this.capture) asr.write(samples, end); };
  }

  get isConversationMode(): boolean { return this.mode; }

  // MARK: Mode and the privacy gate

  setConversationMode(on: boolean): void {
    if (on === this.mode) return;
    this.mode = on;
    const g = ++this.generation;
    if (!on) { this.switching = false; this.audio.stopMic(); this.onLog?.('ambient mode'); return; }
    if (this.microphone === 'denied') { this.onLog?.('conversation mode (output only: microphone off)'); return; }
    this.switching = true;
    this.audio.startMic().then(() => {
      if (g !== this.generation) return;
      this.switching = false;
      this.microphone = 'granted';
      // startMic starts the pump: closed again until the controller opens the gate.
      if (!this.capture) this.audio.pump.stop();
      this.onLog?.('conversation mode');
    }, (e: unknown) => {
      if (g !== this.generation) return;
      this.switching = false;
      const name = e instanceof Error ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') this.microphone = 'denied';
      this.audio.stopMic();
      this.onLog?.(`conversation mode (output only: ${name || 'microphone failed'})`);
    });
  }

  get isAudioReady(): boolean { return !this.switching; }

  setCaptureEnabled(on: boolean): void {
    if (on === this.capture) return;
    this.capture = on;
    if (on) this.asr.noteDiscontinuity(); else this.audio.pump.stop();
  }

  // MARK: Reply playout

  setPlayoutGain(gain: number): void { this.gain = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 0; }

  armReplyStart(epoch: number): void { this.playout.armReplyStart(epoch); }
  playoutSnapshot(): PlayoutSnapshot { return this.playout.playoutSnapshot(); }

  flushPlayout(): void {
    this.playout.flush();
    const cut = this.now() + 0.03;
    let n = this.times.length;
    while (n > this.cursor && this.times[n - 1] > cut) n--;
    this.levels.length = n;
    this.times.length = n;
  }

  speechLevel(atOrBefore: number): number | null {
    for (let i = this.times.length - 1; i >= 0; i--) if (this.times[i] <= atOrBefore) return this.levels[i];
    return null;
  }

  drainSpeechLevels(body: (level: number, hostTime: number) => void): void {
    // An entry renders about one quantum plus the output latency before it is heard.
    const ctx = this.audio.context;
    const until = this.now() + (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + 128 / ctx.sampleRate;
    while (this.cursor < this.times.length && this.times[this.cursor] <= until) {
      body(this.levels[this.cursor], this.times[this.cursor]);
      this.cursor++;
    }
    const drop = this.times.length - ConversationAudioEngine.envelopeCapacity;
    if (drop > 0 && this.cursor >= drop) {
      this.levels.splice(0, drop);
      this.times.splice(0, drop);
      this.cursor -= drop;
    }
  }

  /** RMS → 0…1 on a dB scale: −50 dBFS → 0, −10 dBFS → 1 (PlayoutTap.normalizedLevel). */
  static normalizedLevel(rms: number): number {
    if (!(rms > 0) || !Number.isFinite(rms)) return 0;
    return Math.min(Math.max((20 * Math.log10(rms) + 50) / 40, 0), 1);
  }

  /** Measures the envelope before the gain, then schedules the scaled audio.
   *  shortcut: the gain applies per enqueued chunk (the iPad ramps it per render buffer); a volume change mid-chunk
   *  lands on the next chunk. Upgrade if ConversationAudio exposes its playout gain node. */
  private playPcm(samples: Float32Array, rate: number): { start: number; end: number } {
    const scaled = this.gain === 1 ? samples : samples.map((s) => s * this.gain);
    const span = this.audio.playPcm(scaled, rate);
    const hop = Math.max(1, Math.round(ConversationAudioEngine.envelopeHop * rate));
    for (let i = 0; i < samples.length; i += hop) {
      const end = Math.min(i + hop, samples.length);
      let sum = 0;
      for (let k = i; k < end; k++) sum += samples[k] * samples[k];
      this.levels.push(ConversationAudioEngine.normalizedLevel(Math.sqrt(sum / (end - i))));
      this.times.push(span.start + i / rate);
    }
    return span;
  }

  // MARK: Clips

  /** Fetches and decodes a clip so `playClip` can schedule it at once. */
  async preloadClip(url: string): Promise<void> {
    if (this.clips.has(url)) return;
    this.clips.set(url, 'loading');
    try {
      const data = await (await fetch(url)).arrayBuffer();
      this.clips.set(url, await this.audio.context.decodeAudioData(data));
    } catch {
      this.clips.set(url, 'failed');
      this.onLog?.('clip unreadable');
    }
  }

  forgetClip(url: string): void { this.clips.delete(url); }

  /** Schedules a decoded clip so it is heard at `atHostTime` (no sooner than two quanta from now); a new clip replaces
   *  one still playing. Null when not in conversation mode, the context isn't running or the clip isn't decoded yet. */
  playClip(url: string, atHostTime: number, gain: number): number | null {
    const ctx = this.audio.context;
    const buf = this.clips.get(url);
    if (buf === undefined) void this.preloadClip(url);
    if (!this.mode || ctx.state !== 'running' || !(buf instanceof AudioBuffer)) return null;
    const now = this.now();
    const start = Math.max(Number.isFinite(atHostTime) ? atHostTime : 0, now + Math.max(2 * 128 / ctx.sampleRate, 0.02));
    // Host ↔ context time from the output timestamp (host times here are audible times).
    const offset = this.audio.hostTime(ctx.currentTime) - ctx.currentTime;
    this.clipSource?.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 0;
    src.connect(g).connect(ctx.destination);
    src.start(Math.max(start - offset, ctx.currentTime));
    src.onended = () => { g.disconnect(); if (this.clipSource === src) this.clipSource = null; };
    this.clipSource = src;
    return start + buf.duration;
  }
}
