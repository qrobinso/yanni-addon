// Port of Tests/FaceEngineTests/TickleTests.swift.
import { describe, expect, test } from 'vitest';
import type { V2 } from '../../src/core/vec';
import { ExpressionLibrary, ParamLayout } from '../../src/model';
import { Director, FaceCommand, FaceEngine, FaceState } from '../../src/engine';
import { TouchReactions } from '../../src/engine/modifiers/TouchReactions';

const iX = ParamLayout.index('centerX');
const iAngle = ParamLayout.index('angle');

const touch = (e: FaceEngine): TouchReactions => e.director.modifier('TouchReactions') as TouchReactions;

/// Runs `seconds` at 60 fps, sending a scratch stroke every `every` s while `scratching(t)` (t from the call's start).
function scratch(e: FaceEngine, seconds: number, o: { every?: number; intensity?: number; at?: V2;
  each?: (t: number) => void; scratching?: (t: number) => boolean } = {}): void {
  const every = o.every ?? 0.15, intensity = o.intensity ?? 0.8, p = o.at ?? { x: 0.3, y: 0 };
  const each = o.each ?? (() => {}), scratching = o.scratching ?? (() => true);
  const dt = 1.0 / 60;
  let t = 0.0, next = 0.0;
  while (t < seconds - 1e-9) {
    if (scratching(t) && t >= next - 1e-9) {
      e.send(FaceCommand.scratch(p, intensity));
      next = t + every;
    }
    e.tick(dt);
    t += dt;
    each(t);
  }
}

const laughs = (e: FaceEngine): number => e.state.startedOneShots.filter((x) => x.kind === 'laugh').length;
const never = (): boolean => false;

/// The tickle (press, hold and rub): squirm envelope, giggle bursts, wind-down, state rules, fatigue, Reduce Motion.
describe('Tickle', () => {
  test('scratchingSquirmsGigglesAndWindsDown', () => {
    const e = new FaceEngine({ seed: 4 });
    e.setAgentState('idle');
    scratch(e, 1, { scratching: never });
    let peak = 0, giggles = 0, firstGiggle: number | undefined;
    const xs: number[] = [];
    let squint = 0;
    scratch(e, 3, { each: (t) => {
      peak = Math.max(peak, touch(e).tickleLevel);
      const n = laughs(e);
      if (n > 0 && firstGiggle === undefined) firstGiggle = t;
      giggles += n;
      xs.push(e.state.delta.raw[iX]);
      squint = Math.max(squint, e.state.lidCoverage.y);
    } });
    expect(peak, `squirms up toward the stroke intensity (${peak})`).toBeGreaterThan(0.6);
    expect(firstGiggle ?? 9, 'a giggle at the first stroke').toBeLessThan(0.1);
    expect(giggles >= 2 && giggles <= 3, `bursts every ~2 s, rate-limited (${giggles})`).toBe(true);
    expect(Math.max(...xs) - Math.min(...xs), 'wiggles side to side').toBeGreaterThan(0.02);
    expect(squint, `happy squint (${squint})`).toBeGreaterThan(0.25);
    expect(e.state.agentState, 'never changes state (no mic)').toBe('idle');
    expect(touch(e).annoyance, 'strokes never annoy').toBe(0);
    // Stops: winds down over ~1–2 s, no more giggles.
    let after = 0;
    scratch(e, 0.5, { each: () => { after += laughs(e); }, scratching: never });
    const mid = touch(e).tickleLevel;
    expect(mid > 0.05 && mid < peak, `winding down, not snapped off (${mid})`).toBe(true);
    scratch(e, 2.5, { each: () => { after += laughs(e); }, scratching: never });
    expect(touch(e).tickleLevel).toBe(0);
    expect(after).toBe(0);
  });

  test('squirmStartsAndStopsWithoutPopping', () => {
    const d = new Director([new TouchReactions()]);
    const s = new FaceState(ExpressionLibrary.bundled(), 2);
    s.agentState = 'idle';
    const angles: number[] = [];
    for (let f = 0; f < 60 * 5; f++) {
      s.dt = 1 / 60; s.time += 1 / 60; s.frame += 1;
      s.resetFrameAccumulators();
      s.commands = f >= 30 && f < 180 && f % 9 === 0 ? [FaceCommand.scratch({ x: 0, y: 0 }, 1)] : [];
      d.run(s);
      angles.push(s.delta.raw[iAngle]);
    }
    const first = angles.findIndex((a) => a !== 0);
    let last = -1;
    for (let i = angles.length - 1; i >= 0; i--) if (angles[i] !== 0) { last = i; break; }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(Math.abs(angles[first]), `eases in from rest (${angles[first]}°)`).toBeLessThan(0.3);
    expect(Math.abs(angles[last]), `winds down to rest (${angles[last]}°)`).toBeLessThan(0.3);
    expect(last, 'winds down over a while, not cut at the last stroke').toBeGreaterThan(180 + 45);
    // Never faster than the wiggle itself allows (no frame-to-frame jumps).
    const bound = TouchReactions.wiggleAngle * 2 * Math.PI * TouchReactions.wiggleHz * 1.15 * 1.2 / 60;
    let maxStep = 0;
    for (let i = 1; i < angles.length; i++) maxStep = Math.max(maxStep, Math.abs(angles[i] - angles[i - 1]));
    expect(maxStep, `${maxStep}° vs ${bound}°`).toBeLessThan(bound);
  });

  test('listeningSquirmsAtHalfWithoutGiggles', () => {
    const e = new FaceEngine({ seed: 4 });
    e.setAgentState('listening');
    scratch(e, 1, { scratching: never });
    let peak = 0, giggles = 0;
    scratch(e, 3, { each: () => { peak = Math.max(peak, touch(e).tickleLevel); giggles += laughs(e); } });
    expect(peak > 0.2 && peak <= TouchReactions.conversationTickleScale + 1e-3, `${peak}`).toBe(true);
    expect(giggles, 'nothing steps on the conversation').toBe(0);
    expect(e.state.agentState).toBe('listening');
  });

  test('ignoredWhileSulkingOrSheepish', () => {
    const e = new FaceEngine({ seed: 4 });
    e.setAgentState('sheepish');
    scratch(e, 2);
    expect(touch(e).tickleLevel).toBe(0);
    const s = new FaceEngine({ seed: 4 });
    s.setAgentState('idle');
    for (let i = 0; i < 6; i++) { s.send(FaceCommand.tap({ x: 0, y: 0 })); s.tick(1.0 / 60); }
    expect(touch(s).isSulking).toBe(true);
    scratch(s, 1);
    expect(touch(s).tickleLevel).toBe(0);
  });

  test('scratchingAsleepIsOneTapPerRun', () => {
    const e = new FaceEngine({ seed: 5 });
    e.setAgentState('asleep');
    e.tick(1.0 / 60);
    touch(e).tapsToWake = 3;
    scratch(e, 1.5);
    expect(touch(e).tapCount, 'one run, one tap').toBe(1);
    expect(e.state.agentState !== 'noticing' && e.state.agentState !== 'waking', 'bedtime count not reached').toBe(true);
    const w = new FaceEngine({ seed: 5 });
    w.setAgentState('asleep');
    w.tick(1.0 / 60);
    touch(w).forceStartle = true;
    scratch(w, 0.2);
    expect(w.state.agentState, 'a run wakes like a tap').toBe('noticing');
    scratch(w, 2);
    expect(touch(w).tickleLevel, 'once awake the strokes tickle').toBeGreaterThan(0.3);
  });

  test('longScratchTiresAndRecovers', () => {
    const e = new FaceEngine({ seed: 6 });
    e.setAgentState('idle');
    let early = 0, late = 0, giggles = 0;
    scratch(e, 14, { each: (t) => {
      giggles += laughs(e);
      if (t > 1.5 && t < 3) early = Math.max(early, touch(e).tickleLevel);
      if (t > 12) late = Math.max(late, touch(e).tickleLevel);
    } });
    expect(late, `worn down (${early} → ${late})`).toBeLessThan(early * 0.6);
    expect(giggles, `bursts space out (${giggles} in 14 s)`).toBeLessThanOrEqual(6);
    scratch(e, 3, { scratching: never });
    let fresh = 0;
    scratch(e, 1.5, { each: () => { fresh = Math.max(fresh, touch(e).tickleLevel); } });
    expect(fresh, `a rest makes it fresh (${fresh})`).toBeGreaterThan(early * 0.9);
  });

  test('reduceMotionIsCalmer', () => {
    function travel(reduce: boolean): number {
      const e = new FaceEngine({ seed: 4 });
      const p = e.pupilReactionSettings;
      p.reduceMotion = reduce;
      e.pupilReactionSettings = p;
      const sampler = e.director.modifier('OneShotSampler'); // the squirm alone
      if (sampler) sampler.isEnabled = false;
      e.setAgentState('idle');
      let lo = 0, hi = 0;
      scratch(e, 3, { each: (t) => {
        if (!(t > 0.5)) return;
        lo = Math.min(lo, e.state.delta.raw[iAngle]); hi = Math.max(hi, e.state.delta.raw[iAngle]);
      } });
      return hi - lo;
    }
    const full = travel(false), calm = travel(true);
    expect(calm < 0.65 * full && calm > 0.2 * full, `${full} → ${calm}`).toBe(true);
  });

  test('deterministicForASeed', () => {
    function run(): number[] {
      const e = new FaceEngine({ seed: 11 });
      const out: number[] = [];
      scratch(e, 3, { each: () => { out.push(e.state.output.pose.raw[iX]); } });
      return out;
    }
    expect(run()).toEqual(run());
  });
});
