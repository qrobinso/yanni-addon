// Port of Tests/FaceLifeTests/LifeRig.swift.
import { test } from 'vitest';
import { FaceCommand, FaceEngine, makePersonTarget, missingModifiers, type AgentState } from '../../src/engine';
import { LifeCalendar, LifeCycleController, LifeSettings, type LifePhaseChange, type LifeSettingsStore } from '../../src/life';

/// Tests that need the engine's real behaviour (TouchReactions, AgentStateBehavior, Brightness, …) run once every
/// default modifier is registered (WP5–7); until then they are skipped.
export const fullStackTest = missingModifiers().length === 0 ? test : test.skip;

/// Fake monotonic + wall clock.
export class FakeClock {
  mono = 1000;
  constructor(public date: Date) {}
  get lifeClock() { return { monotonic: () => this.mono, now: () => this.date }; }
  advance(dt: number): void { this.mono += dt; this.date = new Date(this.date.getTime() + dt * 1000); }
}

export const utcCalendar = (tz = 'UTC'): LifeCalendar => new LifeCalendar(tz);

export function makeDate(y: number, mo: number, d: number, h: number, mi: number, tz = 'UTC', s = 0): Date {
  return utcCalendar(tz).date(y, mo, d, h, mi, s);
}

export const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);

/// Swift's `Int((seconds / dt).rounded())`.
const roundSchool = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/// A real engine (default modifiers) driven frame by frame with a life-cycle controller on a fake clock.
export class LifeRig {
  readonly engine: FaceEngine;
  readonly clock: FakeClock;
  readonly life: LifeCycleController;
  changes: LifePhaseChange[] = [];
  /// (isBedtime, agent state at the moment of the call).
  bedtimeCalls: [boolean, AgentState][] = [];
  states: AgentState[] = [];
  sawNonFinite = false;

  constructor(o: { settings?: LifeSettings; date?: Date; calendar?: LifeCalendar; seed?: number; store?: LifeSettingsStore } = {}) {
    this.engine = new FaceEngine({ seed: o.seed ?? 7 });
    this.engine.setAgentState('idle');
    this.clock = new FakeClock(o.date ?? makeDate(2026, 10, 10, 12, 0));
    this.life = new LifeCycleController(this.engine, {
      settings: o.settings ?? new LifeSettings(), store: o.store ?? null, clock: this.clock.lifeClock,
      calendar: o.calendar ?? utcCalendar(),
    });
    this.life.onPhaseChange = (c) => { this.changes.push(c); };
    this.life.onBedtimeChange = (on) => { this.bedtimeCalls.push([on, this.engine.state.agentState]); };
    this.frame();
  }

  get state(): AgentState { return this.engine.state.agentState; }
  get touch(): { tapsToWake: number } { return this.engine.director.modifier('TouchReactions') as unknown as { tapsToWake: number }; }
  get brightnessLevel(): number { return (this.engine.director.modifier('Brightness') as unknown as { level: number }).level; }

  /// One display frame: clock, engine, controller.
  frame(dt = 1 / 30): void {
    this.clock.advance(dt);
    const f = this.engine.tick(dt);
    if (f.pose.hasNonFinite || !Number.isFinite(f.brightness)) this.sawNonFinite = true;
    this.life.afterFrame(this.clock.mono);
    if (this.states[this.states.length - 1] !== this.state) this.states.push(this.state);
  }

  run(seconds: number, dt = 1 / 30, each: () => void = () => {}): void {
    const n = roundSchool(seconds / dt);
    for (let i = 0; i < n; i++) { this.frame(dt); each(); }
  }

  /// Runs until `cond` holds (returns elapsed seconds) or `limit` seconds pass (returns null).
  runUntil(limit: number, cond: () => boolean, dt = 1 / 30): number | null {
    let t = 0;
    while (t < limit) {
      this.frame(dt);
      t += dt;
      if (cond()) return t;
    }
    return null;
  }

  /// One person in view (id 1). `facing`: the eyes follow them (primary); `engaged`: looking at the face.
  person(present: boolean, o: { engaged?: boolean; facing?: boolean; facingAmount?: number } = {}): void {
    const { engaged = false, facing = false, facingAmount = 1 } = o;
    if (present) {
      this.engine.setPeople([makePersonTarget(1, { x: 0.2, y: 0 }, 1.5, 0.5, facingAmount)],
        facing || engaged ? 1 : null, engaged ? 1 : null);
    } else {
      this.engine.setPeople([], null, null);
    }
  }

  tap(): void { this.engine.send(FaceCommand.tap({ x: 0.1, y: 0 })); }

  /// Sleeps quickly: drowsy and asleep timers at minimal settings, time warp.
  fallAsleep(): void {
    const saved = this.life.timeWarp;
    this.life.timeWarp = 600;
    this.runUntil(60, () => this.state === 'asleep');
    this.life.timeWarp = saved;
  }
}

/// `try #require(x)`.
export function req<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('required value was null');
  return v;
}
