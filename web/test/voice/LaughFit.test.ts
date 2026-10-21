// Port of Tests/FaceVoiceTests/LaughFitTests.swift.
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FaceEngine, FaceState, Phase, type AgentState, type Modifier, type OneShotKind, type StartedOneShot } from '../../src/engine';
import {
  LaughFitTunables, Novelty, PhraseGenerator, VoiceDirector, VoiceRenderer,
  type Phrase, type ScheduledPhrase, type VoiceOutput, type VoiceRendererLike,
} from '../../src/voice';
import { Fx } from './voiceTestSupport';

/// Writes `FaceState.tickleLaugh` as TouchReactions would (the drive is scripted per test).
class TickleDrive implements Modifier {
  readonly name = 'TickleDrive';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  drive = 0;
  state: AgentState | null = null;
  update(s: FaceState): void {
    s.tickleLaugh = this.drive;
    if (this.state !== null) s.agentState = this.state;
  }
}

/// Publishes injected `StartedOneShot`s (and active kinds) on the next tick (DirectorTests.swift's StartedInjector).
class StartedInjector implements Modifier {
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

/// A controllable `VoiceOutput` (no audio), as DirectorTests.swift's FakeOutput (only what these tests need).
class FakeOutput implements VoiceOutput {
  sampleRate = 48_000;
  outputLatency = 0.012;
  activeBufferDuration = 0.005;
  idleBufferDuration = 0.02;
  isIdle = false;
  get ioBufferDuration(): number { return this.isIdle ? Math.max(this.activeBufferDuration, this.idleBufferDuration) : this.activeBufferDuration; }
  setIdle(idle: boolean): void { this.isIdle = idle; }
  isRunning = true;
  onConfigurationChange: (() => void) | null = null;
  attached: VoiceRendererLike[] = [];
  attach(r: VoiceRendererLike): void { this.attached.push(r); }
  start(): void { this.isRunning = true; }
  stop(): void { this.isRunning = false; }
}

/// A director on an engine whose only modifiers inject started one-shots and the tickle drive; records every phrase.
class LaughRig {
  readonly injector = new StartedInjector();
  readonly tickle = new TickleDrive();
  readonly engine: FaceEngine;
  readonly output = new FakeOutput();
  readonly director: VoiceDirector;
  now = 1000;
  phrases: ScheduledPhrase[] = [];

  constructor(seed = 7n) {
    this.engine = new FaceEngine({ modifiers: [this.injector, this.tickle] });
    this.engine.setMood({ pleasure: 0.7, arousal: 0.6, dominance: 0.3 });
    this.director = new VoiceDirector(this.engine, new VoiceRenderer(48_000), this.output, new PhraseGenerator(undefined, seed));
    this.director.clock = () => this.now;
    this.frame();
  }

  frame(): void {
    this.now += 1.0 / 60.0;
    this.engine.tick(1.0 / 60.0, this.now);
    this.director.afterFrame(this.now);
    const s = this.director.lastScheduled;
    if (s && s.phrase.id !== this.phrases[this.phrases.length - 1]?.phrase.id) this.phrases.push(s);
  }

  run(seconds: number, drive: (t: number) => number = () => 0): void {
    const t0 = this.now;
    while (this.now - t0 < seconds) { this.tickle.drive = drive(this.now - t0); this.frame(); }
  }
}

const laughGap = { lowerBound: LaughFitTunables.laughGap[0], upperBound: LaughFitTunables.laughGap[1] };

/// Silence (s) between a phrase's end (release included) and the next one's start.
function gaps(p: readonly ScheduledPhrase[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < p.length; i++) out.push(p[i].startHostTime - (p[i - 1].startHostTime + p[i - 1].phrase.duration * p[i - 1].timeStretch));
  return out;
}

function peakGain(p: Phrase): number {
  let g = 0;
  for (const n of p.notes) g = Math.max(g, n.gain);
  return g;
}

const meanOf = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

test('scratchingLaughsContinuouslyThenTrailsOff', () => {
  const rig = new LaughRig();
  rig.run(4, () => 0.8);
  const laughing = [...rig.phrases];
  expect(laughing.length >= 6, `a chain of laughs (${laughing.length})`).toBe(true);
  expect(laughing.every((s) => s.phrase.reaction === 'giggle' && s.pairedOneShot === null && s.audible)).toBe(true);
  for (const g of gaps(laughing)) {
    expect(g >= laughGap.lowerBound - 0.001 && g <= laughGap.upperBound + 0.001, `breath gap ${g}`).toBe(true);
  }
  // Never the same phrase twice in a row.
  for (let i = 1; i < laughing.length; i++) {
    expect(Novelty.distance(Novelty.signature(laughing[i - 1].phrase), Novelty.signature(laughing[i].phrase)) > 0.1).toBe(true);
  }
  // Builds up: the first laugh is softer than the peak.
  const rest = laughing.slice(2).map((s) => peakGain(s.phrase));
  const peak = rest.length ? Math.max(...rest) : 0;
  expect(peakGain(laughing[0].phrase) < peak).toBe(true);

  rig.run(3);
  const trail = rig.phrases.slice(laughing.length);
  expect(trail.length >= 2 && trail.length <= 3, `one or two hehes and a sigh (${trail.length})`).toBe(true);
  const sigh = trail[trail.length - 1]?.phrase!;
  expect(sigh).toBeDefined();
  expect(sigh.notes.length === 2 && sigh.notes[1].duration >= 0.2, 'ends on the settle sigh').toBe(true);
  for (const t of trail) expect(peakGain(t.phrase) < peak).toBe(true);
  expect(rig.director.laughFit.active).toBe(false);
  const n = rig.phrases.length;
  rig.run(2);
  expect(rig.phrases.length, 'silent once settled').toBe(n);
});

test('fatigueMakesItSofterNotSilent', () => {
  const rig = new LaughRig();
  rig.run(8, (t) => (t < 3 ? 1 : 0.4));
  const fresh = rig.phrases.filter((s) => s.startHostTime < 1000 + 3).slice(2);
  const tired = rig.phrases.filter((s) => s.startHostTime > 1000 + 4);
  expect(tired.length).toBeGreaterThan(0);
  const gainF = meanOf(fresh.map((s) => peakGain(s.phrase)));
  const gainT = meanOf(tired.map((s) => peakGain(s.phrase)));
  expect(gainT < gainF * 0.8, `tired laughs are softer (${gainT} vs ${gainF})`).toBe(true);
  for (const g of gaps(tired)) expect(g <= laughGap.upperBound + 0.001).toBe(true);
});

test('laughBurstsStaySilentDuringTheFit', () => {
  const rig = new LaughRig();
  rig.run(0.5, () => 0.8);
  rig.injector.queued = [{ kind: 'laugh', engineTime: 0, hostTime: rig.now, rate: 1,
    accentTimes: [VoiceDirector.accentTime('laugh')], softVoice: false }];
  rig.run(1, () => 0.8);
  expect(rig.phrases.every((s) => s.pairedOneShot === null)).toBe(true);
});

test('noLaughWhileListeningMutedOrAtABedtimeWithoutSounds', () => {
  for (let setup = 0; setup < 4; setup++) {
    const rig = new LaughRig();
    switch (setup) {
      case 0: rig.tickle.state = 'listening'; break;
      case 1: rig.tickle.state = 'thinking'; break;
      case 2: rig.director.settings.muted = true; break;
      default: rig.director.isBedtime = true;   // bedtime sounds default to off
    }
    rig.run(2, () => 0.8);
    expect(rig.phrases.length, `setup ${setup}`).toBe(0);
  }
});

test('quietBedtimeLaughsAtTheNightVolume', () => {
  const rig = new LaughRig();
  rig.director.settings.bedtimeSounds = 'quiet';
  rig.director.isBedtime = true;
  rig.run(2, () => 0.8 * 0.6);
  expect(rig.phrases.length > 0 && rig.phrases.every((s) => s.audible)).toBe(true);
  expect(rig.director.rendererVolume < rig.director.settings.volume).toBe(true);
});

test('listeningStopsTheTrailOff', () => {
  const rig = new LaughRig();
  rig.run(2, () => 0.8);
  const n = rig.phrases.length;
  rig.tickle.state = 'listening';
  rig.run(2);
  expect(rig.phrases.length).toBe(n);
});

test('deterministicForASeed', () => {
  const notes = (seed: bigint): Phrase[] => {
    const rig = new LaughRig(seed);
    rig.run(3, () => 0.9);
    rig.run(2);
    return rig.phrases.map((s) => s.phrase);
  };
  const eq = (a: Phrase[], b: Phrase[]): boolean => a.length === b.length && a.every((p, i) => p.equals(b[i]));
  expect(eq(notes(11n), notes(11n))).toBe(true);
  expect(eq(notes(11n), notes(12n))).toBe(false);
});

/// A ~6 s tickle through the real director and renderer: it builds up, peaks, tires (fatigue compressed into the
/// demo) and trails off. Written to `$YANNI_TICKLE_RENDERS/tickle-laugh-fit.wav` (or `$TMPDIR/YanniVoiceDemo-laughfit/`);
/// the envelope has no silence over 300 ms while scratching.
test('writeLaughFitDemo', () => {
  const rig = new LaughRig(21n);
  const t0 = rig.now;
  const stop = 4.6;
  rig.run(stop, (t) => {
    const intensity = 0.55 + 0.45 * Math.min(t / 1.5, 1);
    const worn = Math.min(Math.max((t - 2.6) / 1.6, 0), 1);
    return intensity * (1 - 0.55 * worn * worn * (3 - 2 * worn));
  });
  rig.run(1.8);
  // Enqueued a moment ahead, as the director does live (the ring holds a few phrases).
  const r = Fx.renderer();
  const fs = 48_000;
  let qi = 0;
  const queue = rig.phrases;
  const audio = Fx.render(r, 6.6, (n) => {
    while (qi < queue.length && queue[qi].startHostTime - t0 < n / fs + 0.2) {
      const p = queue[qi];
      expect(r.enqueue(p.phrase, Fx.host0 + (p.startHostTime - t0), 1)).toBe(true);
      qi += 1;
    }
  });
  expect(audio.every((x) => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);

  // Envelope: 10 ms RMS windows; "silent" is 40 dB under the loudest window.
  const w = Math.trunc(fs / 100);
  const env: number[] = [];
  for (let i = 0; i < audio.length - w; i += w) env.push(Fx.rms(audio.subarray(i, i + w)));
  const floor = (env.length ? Math.max(...env) : 0) * 0.01;
  const first = env.findIndex((x) => x > floor);
  expect(first).toBeGreaterThanOrEqual(0);
  let longest = 0, run = 0;
  for (let k = first; k < Math.trunc(stop * 100); k++) { run = env[k] > floor ? 0 : run + 1; longest = Math.max(longest, run); }
  expect(longest * 10 < 300, `longest silence while scratching ${longest * 10} ms`).toBe(true);
  const counts = new Set(rig.phrases.map((s) => s.phrase.notes.length));
  expect(counts.size >= 3, `phrase lengths vary ${[...counts]}`).toBe(true);

  const dir = Fx.outDir('YANNI_TICKLE_RENDERS', 'YanniVoiceDemo-laughfit');
  Fx.writeWAV(audio, fs, join(dir, 'tickle-laugh-fit.wav'));
  for (const p of rig.phrases) {
    console.log(`  ${(p.startHostTime - t0).toFixed(2)} s  ${p.phrase.notes.length} notes  ${p.phrase.duration.toFixed(2)} s  gain ${peakGain(p.phrase).toFixed(2)}`);
  }
  console.log(`Laugh fit: ${rig.phrases.length} phrases, longest silence while scratching ${longest * 10} ms, note counts ${[...counts].sort((a, b) => a - b)}`);
});
