// Port of ConversationCore/TurnDetection.swift: voice activity and end of turn as the controller sees them (design
// §8.1). `TurnDetectionRuntime` (audio/) conforms; with no backend the facade reports `notInstalled`.
import { makeTurnDetectionStatus, type TurnDetectionStatus } from '../turn/TurnDetectionStatus';
import type { TurnSignal } from '../turn/TurnSignal';
import { clampedTunables, makeTurnTunables, type TurnTunables } from '../turn/TurnTunables';

export interface ConversationTurnDetection {
  /** Every signal, as soon as it is produced. */
  onSignal: ((s: TurnSignal) => void) | null;
  /** Mic open (listening through speaking): run. Closed: stop, and drop any turn in progress (no turn end). */
  setListening(on: boolean): void;
  /** Conversation mode started (Noticing): load and warm the models. */
  prepare(): void;
  /** Until when (host seconds) Yanni's chirps or greeting may be audible (the echo rule). */
  setLocalSoundAudibleUntil(hostTime: number): void;
  setTunables(t: TurnTunables): void;
  /** Status snapshot (never blocks). */
  readonly status: TurnDetectionStatus;
  /** The live microphone level 0…1 (smoothed, noise-gated) while listening, 0 otherwise. */
  readonly inputLevel: number;
}

/** The app's one turn detector: the controller always talks to this facade; the runtime plugs in as `backend`. */
export class TurnDetector implements ConversationTurnDetection {
  onSignal: ((s: TurnSignal) => void) | null = null;
  tunables: TurnTunables;
  private listening = false;
  private prepared = false;
  private localAudibleUntil = -Infinity;
  private _backend: ConversationTurnDetection | null = null;

  constructor(tunables: TurnTunables = makeTurnTunables()) {
    this.tunables = clampedTunables(tunables);
  }

  get backend(): ConversationTurnDetection | null {
    return this._backend;
  }
  set backend(b: ConversationTurnDetection | null) {
    const old = this._backend;
    if (b === old) return;
    this._backend = b;
    if (old) { old.onSignal = null; old.setListening(false); }
    if (!b) return;
    b.onSignal = (s) => this.onSignal?.(s);
    b.setTunables(this.tunables);
    b.setLocalSoundAudibleUntil(this.localAudibleUntil);
    if (this.prepared) b.prepare();
    if (this.listening) b.setListening(true);
  }

  setListening(on: boolean): void { this.listening = on; this._backend?.setListening(on); }
  prepare(): void { this.prepared = true; this._backend?.prepare(); }
  setLocalSoundAudibleUntil(t: number): void { this.localAudibleUntil = t; this._backend?.setLocalSoundAudibleUntil(t); }
  setTunables(t: TurnTunables): void { this.tunables = clampedTunables(t); this._backend?.setTunables(this.tunables); }
  get inputLevel(): number { return this._backend?.inputLevel ?? 0; }
  get status(): TurnDetectionStatus {
    return this._backend?.status ?? makeTurnDetectionStatus({ availability: { kind: 'notInstalled' }, threshold: this.tunables.vadThreshold });
  }
}
