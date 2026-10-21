// Port of FaceVoice/Host/VoiceOutput.swift. The Web Audio implementation is playback/VoiceAudioHost.ts
// (port-note: replaces Host/VoiceAudioHost.swift's AVAudioEngine).
import type { VoiceRendererLike } from '../dsp/VoiceRenderer';

/// Where synthesized audio goes. In the browser: `VoiceAudioHost` (an AudioWorklet on the conversation's
/// AudioContext, so the browser's echo canceller hears it). Swapping implementations is mechanical.
export interface VoiceOutput {
  /// Hardware sample rate the renderer must run at.
  readonly sampleRate: number;
  /// Seconds from a render buffer's host time to audible output (excludes the buffer itself).
  readonly outputLatency: number;
  /// IO buffer duration (seconds); scheduling lead must exceed ~2× this.
  readonly ioBufferDuration: number;
  /// True when the output is running and producing audio.
  readonly isRunning: boolean;
  /// True while the output is being rebuilt in the background (a mode switch): not running, but not failed either.
  readonly isSwitching?: boolean;
  /// Called after a route/configuration change; the director re-queries latency and the renderer may be rebuilt at
  /// a new sample rate.
  onConfigurationChange: (() => void) | null;
  /// Idle mode: a longer IO buffer through long silences (the director decides when). Outputs without one never idle.
  readonly isIdle?: boolean;
  /// Enter (true) or leave (false) idle mode. Idempotent and cheap when already in that mode.
  setIdle?(idle: boolean): void;
  attach(renderer: VoiceRendererLike): void;
  /// Attaches the reply renderer: Yanni's babble replies, a second source into the same mix, never muted by Sounds
  /// off, quiet mode or bedtime. Outputs without one ignore it (they play no babble; the face cues still fire).
  attachReply?(renderer: VoiceRendererLike): void;
  start(): void | Promise<void>;
  stop(): void;
}

/// Host clock in seconds: `performance.now()` (the display-link / rAF time base), port-note: mach ticks in Swift.
export const HostClock = {
  now(): number {
    const p = (globalThis as { performance?: { now(): number } }).performance;
    return p ? p.now() / 1000 : Date.now() / 1000;
  },
  nowSeconds(): number { return HostClock.now(); },
};
