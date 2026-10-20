// Port of ConversationAudio/TurnDetectionRuntime.swift: the on-device turn detector (design §5.2, §8). Capture frames
// → `TurnAudioPump` (the 10 ms tick, the meter) → `TurnDetectionEngine` (frames, Silero, the state machine, the turn
// buffer) → Smart Turn (its own worker / serial chain) → results back on the engine's chain.
// port-note: the Swift VAD DispatchQueue becomes one promise chain; every engine call goes through it in order.
import { log } from '../../core/log';
import type { ConversationTurnDetection } from '../core/TurnDetection';
import type { TurnCompletionDetecting, VoiceActivityDetecting } from '../turn/DetectorPorts';
import { TurnDetectionEngine } from '../turn/TurnDetectionEngine';
import { makeTurnDetectionStatus, type TurnDetectionAvailability, type TurnDetectionStatus } from '../turn/TurnDetectionStatus';
import type { TurnSignal } from '../turn/TurnSignal';
import { clampedTunables, EchoWindow, makeTurnTunables, type TurnTunables } from '../turn/TurnTunables';
import type { PlayoutAudibility } from './PlayoutAudibility';
import { hostNow, type PumpStats, type TurnAudioPump } from './TurnAudioPump';

export interface TurnDetectionRuntimeOptions {
  pump: TurnAudioPump;
  playout: PlayoutAudibility;
  /** Creates the voice-activity model (called once, at `prepare`; e.g. `() => SileroVADModel.create()`). */
  makeVAD: () => VoiceActivityDetecting | Promise<VoiceActivityDetecting>;
  /** The Smart Turn model (`SmartTurnWorkerClient` in the browser). */
  endOfTurn: TurnCompletionDetecting;
  /** Smart Turn's execution provider, for Status (read at publish time: it is known once loaded). */
  computeUnits?: () => string | null;
  tunables?: TurnTunables;
  now?: () => number;
}

export class TurnDetectionRuntime implements ConversationTurnDetection {
  onSignal: ((s: TurnSignal) => void) | null = null;
  readonly pump: TurnAudioPump;
  private readonly playout: PlayoutAudibility;
  private readonly makeVAD: TurnDetectionRuntimeOptions['makeVAD'];
  private readonly endOfTurn: TurnCompletionDetecting;
  private readonly computeUnits: () => string | null;
  private readonly now: () => number;
  private engine: TurnDetectionEngine | null = null;
  private tunables: TurnTunables;
  private listening = false;
  private vadLoadStarted = false;
  private loaded = new Set<'vad' | 'smartTurn'>();
  private availability: TurnDetectionAvailability = { kind: 'notLoaded' };
  private published: TurnDetectionStatus;
  private ticksSincePublish = 0;
  private gaps = 0;
  private localAudibleUntil = -Infinity;
  private chain: Promise<void> = Promise.resolve();

  constructor(o: TurnDetectionRuntimeOptions) {
    this.pump = o.pump;
    this.playout = o.playout;
    this.makeVAD = o.makeVAD;
    this.endOfTurn = o.endOfTurn;
    this.computeUnits = o.computeUnits ?? (() => null);
    this.now = o.now ?? hostNow;
    this.tunables = clampedTunables(o.tunables ?? makeTurnTunables());
    this.published = makeTurnDetectionStatus({ availability: this.availability, threshold: this.tunables.vadThreshold });
    // The pump hands over fresh frames (the worklet posts a new array per frame), so they can wait in the chain.
    this.pump.onAudio = (chunk, end) => {
      const echoUntil = this.echoUntil();
      this.enqueue(() => this.engine?.feed(chunk, end, echoUntil));
    };
    this.pump.onDiscontinuity = (_d, now) => { this.gaps += 1; this.enqueue(() => this.engine?.gap(now)); };
    this.pump.onTick = (now) => {
      this.enqueue(() => this.engine?.tick(now));
      this.ticksSincePublish += 1;
      if (this.ticksSincePublish >= 25) this.enqueue(() => this.publish()); // ≈ 4 Hz
    };
  }

  setListening(on: boolean): void { this.enqueue(() => this.applyListening(on)); }
  setLocalSoundAudibleUntil(hostTime: number): void { this.localAudibleUntil = hostTime; }
  setTunables(t: TurnTunables): void {
    const c = clampedTunables(t);
    this.enqueue(() => { this.tunables = c; if (this.engine) this.engine.tunables = c; });
  }
  get status(): TurnDetectionStatus { return this.published; }
  /** The live mic level 0…1 (the pump's meter). */
  get inputLevel(): number { return this.pump.inputLevel; }
  /** Capture counters (Status). */
  get captureStats(): PumpStats { return this.pump.stats; }
  /** The newest frame's speech probability, live (the tuning page reads it per animation frame). */
  get vadProbability(): number { return this.engine?.lastProbability ?? 0; }
  /** The engine's phase, live. */
  get phase(): TurnDetectionStatus['phase'] { return this.engine?.machine.phase ?? 'off'; }
  /** Resolves once everything queued so far has run (tests, the demo). */
  idle(): Promise<void> { return this.chain; }

  private echoUntil(): number {
    const now = this.now();
    return EchoWindow.until(this.playout.lastLoudHostTime(now), this.playout.outputLatency, this.localAudibleUntil,
      this.tunables.echoTail);
  }

  private enqueue(fn: () => void | Promise<void>): void {
    this.chain = this.chain.then(fn).catch((e) => log.error('audio', 'turn detection step failed', e));
  }

  // MARK: Loading

  prepare(): void {
    this.setAvailability({ kind: 'loading' }, ['notLoaded']);
    if (!this.vadLoadStarted) {
      this.vadLoadStarted = true;
      Promise.resolve().then(() => this.makeVAD()).then((vad) => this.enqueue(() => {
        const e = new TurnDetectionEngine(vad, this.tunables);
        e.onSignal = (s) => this.onSignal?.(s);
        e.onSmartTurnRequest = (r, w) => this.runSmartTurn(r.id, w);
        this.engine = e;
        if (this.listening) e.micOpened(this.now());
        this.finishedLoading('vad');
      }), (err) => this.fail(`voice activity model failed to load: ${err}`));
    }
    this.endOfTurn.prepare().then(() => this.finishedLoading('smartTurn'), (err) => this.fail(`Smart Turn failed to load: ${err}`));
  }

  private finishedLoading(part: 'vad' | 'smartTurn'): void {
    this.loaded.add(part);
    if (this.loaded.size === 2) this.setAvailability({ kind: 'ready' }, ['loading', 'notLoaded']);
  }

  private fail(why: string): void {
    log.error('audio', `Turn detection unavailable: ${why}`);
    this.setAvailability({ kind: 'unavailable', reason: why }, null);
    this.onSignal?.({ kind: 'unavailable', reason: why });
  }

  private setAvailability(a: TurnDetectionAvailability, onlyFrom: TurnDetectionAvailability['kind'][] | null): void {
    if (onlyFrom && !onlyFrom.includes(this.availability.kind)) return;
    this.availability = a;
    this.enqueue(() => this.publish());
  }

  // MARK: The chain

  private applyListening(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    const now = this.now();
    if (on) {
      this.engine?.micOpened(now);
      this.pump.start();
    } else {
      this.engine?.micClosed(now);
      this.pump.stop();
    }
    this.publish();
  }

  private runSmartTurn(id: number, window: Parameters<TurnCompletionDetecting['completionProbability']>[0]): void {
    const t0 = this.now();
    this.endOfTurn.completionProbability(window).then(
      (p) => { const ms = (this.now() - t0) * 1000; this.enqueue(() => this.engine?.smartTurnFinished(id, p, ms, this.now())); },
      () => this.enqueue(() => this.engine?.smartTurnFailed(id, this.now())),
    );
  }

  private publish(): void {
    this.ticksSincePublish = 0;
    const a = this.availability;
    const s = this.engine?.status(a) ?? makeTurnDetectionStatus({ availability: a, threshold: this.tunables.vadThreshold });
    s.computeUnits = this.computeUnits();
    s.gaps = this.gaps;
    s.micLevelDB = this.listening ? this.pump.inputLevelDB : null;
    this.published = s;
  }
}
