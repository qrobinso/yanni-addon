// Port of ConversationTurn/TurnTunables.swift.

/** Schoolbook rounding (Swift `.rounded()`). */
export const roundHalfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/** The detectors' audio format: 16 kHz mono Float32, Silero's 32 ms frames, Smart Turn's 8 s window. */
export const TurnAudioFormat = {
  sampleRate: 16_000,
  /** New samples per Silero frame (the adapter keeps its own 64-sample context). */
  frameSamples: 512,
  /** One frame in seconds (0.032). */
  frameDuration: 512 / 16_000,
  /** Smart Turn input: the turn's last 8 s, zero-padded at the beginning. */
  windowSamples: 128_000,
  /** The turn buffer keeps this much 16 kHz audio (10 s). */
  bufferSamples: 160_000,
} as const;

/** Every turn-detection tunable (design §6.4). Seconds unless noted. Edited live from Sound → Listening. */
export interface TurnTunables {
  /** Speech-like when p ≥ this; silent when p < this − `hysteresis`. */
  vadThreshold: number;
  /** Speech confirmed after this much speech-like audio (2 frames). */
  minSpeech: number;
  /** While Yanni may be audible the onset threshold rises by this (0.6 → 0.85, capped at 0.95). */
  echoThresholdBoost: number;
  /** While Yanni may be audible an onset needs this much speech-like audio (3 frames). */
  echoMinSpeech: number;
  /** Added to every audible-until (room reverb, the canceller's adaptation after loud playout). */
  echoTail: number;
  /** Silence before Smart Turn is asked (rounds to 6 frames, 192 ms). */
  stopSecs: number;
  /** Smart Turn p ≥ this means the turn is complete. */
  completionThreshold: number;
  /** The turn ends after this much silence even when Smart Turn says incomplete. */
  fallbackSilence: number;
  /** Audio kept before the confirmed onset (fixed). */
  preRoll: number;
  /** A Smart Turn run without a result after this long counts as failed (fixed). */
  smartTurnTimeout: number;
}

export function makeTurnTunables(overrides: Partial<TurnTunables> = {}): TurnTunables {
  return {
    vadThreshold: 0.6, minSpeech: 0.064, echoThresholdBoost: 0.25, echoMinSpeech: 0.096, echoTail: 0.3,
    stopSecs: 0.2, completionThreshold: 0.5, fallbackSilence: 3.0, preRoll: 0.5, smartTurnTimeout: 0.5,
    ...overrides,
  };
}

export const TurnTunablesStatics = {
  /** Silero's `neg_threshold` offset. */
  hysteresis: 0.15,
  /** Silero's LSTM state is reset after this much continuous silence outside a turn. */
  vadResetSilence: 5,
  defaults: Object.freeze(makeTurnTunables()) as Readonly<TurnTunables>,
} as const;

// MARK: Derived (frames of 32 ms, never below 1)

export function tunableFrames(seconds: number): number {
  if (!Number.isFinite(seconds)) return 1;
  return Math.max(1, roundHalfAway(seconds / TurnAudioFormat.frameDuration));
}

export const minSpeechFrames = (t: TurnTunables): number => tunableFrames(t.minSpeech);
export const echoMinSpeechFrames = (t: TurnTunables): number => tunableFrames(t.echoMinSpeech);
export const stopFrames = (t: TurnTunables): number => tunableFrames(t.stopSecs);

/** The onset threshold, boosted while the echo rule applies. */
export function tunableThreshold(t: TurnTunables, echo: boolean): number {
  return echo ? Math.min(t.vadThreshold + t.echoThresholdBoost, 0.95) : t.vadThreshold;
}

/** Values clamped to the Tune ranges (a hand-edited or stale store can't wedge detection). */
export function clampedTunables(src: TurnTunables): TurnTunables {
  const c = (v: number, lo: number, hi: number, d: number): number =>
    Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d;
  const d = TurnTunablesStatics.defaults;
  return {
    vadThreshold: c(src.vadThreshold, 0.3, 0.9, d.vadThreshold),
    minSpeech: c(src.minSpeech, 0.032, 0.256, d.minSpeech),
    echoThresholdBoost: c(src.echoThresholdBoost, 0, 0.35, d.echoThresholdBoost),
    echoMinSpeech: c(src.echoMinSpeech, 0.032, 0.32, d.echoMinSpeech),
    echoTail: c(src.echoTail, 0, 1, d.echoTail),
    stopSecs: c(src.stopSecs, 0.1, 0.6, d.stopSecs),
    completionThreshold: c(src.completionThreshold, 0.3, 0.9, d.completionThreshold),
    fallbackSilence: c(src.fallbackSilence, 1, 6, d.fallbackSilence),
    preRoll: d.preRoll,
    smartTurnTimeout: d.smartTurnTimeout,
  };
}

/** Until when the microphone may hear Yanni (design §7): the remote playout's last loud buffer plus output latency,
 *  and the local chirps / greeting, each plus the echo tail. */
export const EchoWindow = {
  until(lastLoudHostTime: number, outputLatency: number, localAudibleUntil: number, tail: number): number {
    const remote = Number.isFinite(lastLoudHostTime) ? lastLoudHostTime + Math.max(outputLatency, 0) : -Infinity;
    const local = Number.isFinite(localAudibleUntil) ? localAudibleUntil : -Infinity;
    const m = Math.max(remote, local);
    return Number.isFinite(m) ? m + Math.max(tail, 0) : -Infinity;
  },
};
