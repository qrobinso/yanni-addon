// Director test harness (Swift DirectorTests.swift's FakeOutput / StartedInjector / Rig / near, and
// ReplyVoiceTests.swift's renderFrom / rms). Host times are seconds (port-note: mach ticks in Swift).
import {
  FaceEngine, Phase, type FaceState, type Modifier, type OneShotKind, type StartedOneShot, type VocalCue,
} from '../../src/engine';
import {
  PhraseGenerator, VoiceDirector, VoiceRenderer, type VoiceOutput, type VoiceRendererLike,
} from '../../src/voice';
import { Fx } from './RendererFixtures';

export type OutputEvent = { kind: 'readBuffer'; value: number } | { kind: 'setIdle'; value: boolean };

/// A controllable `VoiceOutput` (no audio). While idle it reports `idleBufferDuration` (when larger).
export class FakeOutput implements VoiceOutput {
  sampleRate = 48_000;
  outputLatency = 0.012;
  activeBufferDuration = 0.005;
  idleBufferDuration = 0.02;
  get ioBufferDuration(): number {
    const v = this.isIdle ? Math.max(this.activeBufferDuration, this.idleBufferDuration) : this.activeBufferDuration;
    if (this.logEvents) this.events.push({ kind: 'readBuffer', value: v });
    return v;
  }
  set ioBufferDuration(v: number) { this.activeBufferDuration = v; }
  isIdle = false;
  /// Every `setIdle` call (also the idempotent ones).
  idleCalls: boolean[] = [];
  logEvents = false;
  events: OutputEvent[] = [];
  setIdle(idle: boolean): void {
    this.idleCalls.push(idle);
    if (this.logEvents) this.events.push({ kind: 'setIdle', value: idle });
    this.isIdle = idle;
  }
  isRunning = true;
  onConfigurationChange: (() => void) | null = null;
  attached: VoiceRendererLike[] = [];
  attach(renderer: VoiceRendererLike): void { this.attached.push(renderer); }
  start(): void { this.isRunning = true; }
  stop(): void { this.isRunning = false; }
}

/// Publishes injected `StartedOneShot`s (and active kinds) on the next tick, as OneShotSampler will.
export class StartedInjector implements Modifier {
  readonly name = 'StartedInjector';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  queued: StartedOneShot[] = [];
  active: OneShotKind[] = [];
  update(s: FaceState): void {
    s.startedOneShots.length = 0;
    s.startedOneShots.push(...this.queued);
    this.queued = [];
    s.activeOneShots = [...this.active];
  }
}

/// A test engine (only the injector modifier, so the real sampler can't interfere), a fake output and a fake host
/// clock that advances with the frames.
export class Rig {
  readonly injector = new StartedInjector();
  readonly engine: FaceEngine;
  readonly output = new FakeOutput();
  readonly director: VoiceDirector;
  now = 1000;

  constructor(useOutput = true) {
    this.engine = new FaceEngine({ modifiers: [this.injector] });
    this.director = new VoiceDirector(this.engine, new VoiceRenderer(48_000), null, new PhraseGenerator(undefined, 7n));
    if (useOutput) this.director.output = this.output;
    this.director.clock = () => this.now;
    this.frame();
  }

  /// One display frame: ticks with host time (clearing last frame's commands), then runs the director.
  frame(dt = 1.0 / 60.0): void {
    this.now += dt;
    this.engine.tick(dt, this.now);
    this.director.afterFrame(this.now);
  }

  advance(seconds: number): void {
    let t = 0.0;
    while (t < seconds) { this.frame(); t += 1.0 / 60.0; }
  }

  get cues(): VocalCue[] {
    const out: VocalCue[] = [];
    for (const c of this.engine.state.commands) if (c.kind === 'vocalCue') out.push(c.cue);
    return out;
  }
  get oneShotsAt(): [OneShotKind, number][] {
    const out: [OneShotKind, number][] = [];
    for (const c of this.engine.state.commands) if (c.kind === 'playOneShotAt') out.push([c.oneShot, c.hostTime]);
    return out;
  }
  get cancels(): number[] {
    const out: number[] = [];
    for (const c of this.engine.state.commands) if (c.kind === 'cancelVocalCues') out.push(c.fromHostTime);
    return out;
  }
}

export const near = (a: number, b: number, tol = 0.001): boolean => Math.abs(a - b) <= tol;

/// A `StartedOneShot` (Swift memberwise init; `softVoice` defaults to false).
export function started(kind: OneShotKind, hostTime: number, rate = 1, accentTimes?: number[], softVoice = false): StartedOneShot {
  return { kind, engineTime: 0, hostTime, rate, accentTimes: accentTimes ?? [VoiceDirector.accentTime(kind)], softVoice };
}

/// Renders `r` from host time `from` (seconds) for `seconds`, optionally running `before(sampleIndex)` between buffers.
export function renderFrom(r: VoiceRendererLike, from: number, seconds: number, before?: (n: number) => void): Float32Array {
  return Fx.render(r as VoiceRenderer, seconds, { host0: from, before });
}

export const rms = (x: ArrayLike<number>): number => Fx.rms(x);
