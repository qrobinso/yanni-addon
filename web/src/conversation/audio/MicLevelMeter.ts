// Port of ConversationAudio/MicLevelMeter.swift: the live microphone level (design §5.4; listening glow §5.3), one
// block of the 16 kHz turn-detection audio at a time, as a perceptual 0…1 and a dBFS reading. Numbers only.
//
// - dB mapping: the block's RMS in dBFS, mapped linearly from the gate (0) to `ceilingDB` (1).
// - Noise gate: a minimum tracker follows the room's noise (falls fast, rises slowly, capped so speech can't become
//   "noise"); the gate sits `gateAboveNoise` over it and never below `floorDB`.
// - Smoothing: a one-pole follower, fast attack and slower release, dt-exact.

export class MicLevelMeter {
  /** Never quieter than this counts as voice (dBFS). */
  static readonly floorDB = -58;
  /** Level 1 (dBFS): close, raised voice. */
  static readonly ceilingDB = -20;
  /** The gate sits this far over the tracked room noise (dB). */
  static readonly gateAboveNoise = 8;
  /** The noise tracker never rises above this (dBFS). */
  static readonly noiseCeilingDB = -42;
  /** Noise tracker time constants: down fast (gaps between words), up slowly. */
  static readonly noiseFall = 0.3;
  static readonly noiseRise = 4.0;
  /** Level follower time constants (s). */
  static readonly attack = 0.03;
  static readonly release = 0.2;
  /** The quietest block reading (dBFS); digital silence reads as this. */
  static readonly silenceDB = -120;

  /** Smoothed level 0…1. */
  level = 0;
  /** The block level, dBFS, on the same attack and release (Status). */
  db = MicLevelMeter.silenceDB;
  /** The tracked room noise, dBFS. */
  noiseDB = MicLevelMeter.floorDB - MicLevelMeter.gateAboveNoise;

  reset(): void {
    this.level = 0;
    this.db = MicLevelMeter.silenceDB;
    this.noiseDB = MicLevelMeter.floorDB - MicLevelMeter.gateAboveNoise;
  }

  /** The gate (dBFS) for the current noise estimate. */
  get gateDB(): number {
    return Math.max(MicLevelMeter.floorDB, this.noiseDB + MicLevelMeter.gateAboveNoise);
  }

  /** The target level 0…1 of a block at `blockDB` against `gate`. */
  static perceptual(blockDB: number, gate: number): number {
    const span = Math.max(MicLevelMeter.ceilingDB - gate, 1);
    return Math.min(Math.max((blockDB - gate) / span, 0), 1);
  }

  /** One block: its mean square (linear, full scale 1) and its duration in seconds. */
  update(meanSquare: number, dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const M = MicLevelMeter;
    const ms = Number.isFinite(meanSquare) ? Math.max(meanSquare, 0) : 0;
    const d = Math.max(10 * Math.log10(Math.max(ms, 1e-12)), M.silenceDB);
    this.noiseDB += (d - this.noiseDB) * M.alpha(dt, d < this.noiseDB ? M.noiseFall : M.noiseRise);
    this.noiseDB = Math.min(Math.max(this.noiseDB, M.silenceDB), M.noiseCeilingDB);
    const target = M.perceptual(d, this.gateDB);
    this.level += (target - this.level) * M.alpha(dt, target > this.level ? M.attack : M.release);
    this.level = Number.isFinite(this.level) ? Math.min(Math.max(this.level, 0), 1) : 0;
    this.db += (d - this.db) * M.alpha(dt, d > this.db ? M.attack : M.release);
    if (!Number.isFinite(this.db)) this.db = M.silenceDB;
  }

  static alpha(dt: number, tau: number): number {
    return 1 - Math.exp(-dt / tau);
  }
}
