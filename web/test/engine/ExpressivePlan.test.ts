// Port of Tests/FaceEngineTests/ExpressivePlanTests.swift.
import { describe, expect, test } from 'vitest';
import { BrowLayout, ExpressionMix } from '../../src/model';
import {
  ExpressivePlan, FaceCommand, FaceEngine, OneShotRequest, makeReactionCue, type AgentState, missingModifiers,
} from '../../src/engine';

const sceptical = (): ExpressivePlan => new ExpressivePlan({
  expression: 'Skepticism', intensity: 0.8, hold: 1, brow: 'sceptical', gaze: 'glanceAround', move: 'curiousTilt',
  cue: makeReactionCue('curiosity', 0.8, {
    source: 'perception', directedAtYanni: true, valence: 0.1, key: 'curiosity:test',
  }),
});

function engine(state: AgentState = 'noticing'): FaceEngine {
  const e = new FaceEngine({ seed: 7 });
  const ib = e.director.modifier('IdleBeats'); if (ib) ib.isEnabled = false;
  const ea = e.director.modifier('EdgeAntics'); if (ea) ea.isEnabled = false;
  e.setAgentState(state);
  for (let i = 0; i < 120; i++) e.tick(1.0 / 60);
  return e;
}

// TODO(WP5): import ExpressiveOverlay and drop the cast.
interface OverlayView { overlayWeight: number; browLevels: { x: number; y: number }; plan: ExpressivePlan | null }
const overlay = (e: FaceEngine): OverlayView => e.director.modifier('ExpressiveOverlay') as unknown as OverlayView;
const touchYield = 0.02; // TODO(WP5): ExpressiveOverlay.touchYield

/// Expressive plans (expressive decisions design §7): the envelope, the gating, blending and bounds in the full engine.
describe('ExpressivePlan', () => {
  test('envelopeRisesHoldsAndEndsAtZero', () => {
    const p = new ExpressivePlan({ onset: 0.2, hold: 1, release: 0.5 });
    expect(p.envelope(-0.1)).toBe(0);
    expect(p.envelope(0)).toBe(0);
    expect(Math.abs(p.envelope(0.1) - 0.5)).toBeLessThan(1e-5);
    expect(p.envelope(0.7)).toBe(1);
    expect(p.envelope(1.7)).toBe(0);
    expect(p.envelope(5)).toBe(0);
    let last = 1;
    for (let i = 0; i <= 50; i++) {
      const v = p.envelope(1.2 + i * 0.01);
      expect(v).toBeLessThanOrEqual(last + 1e-6);
      last = v;
    }
  });

  test('turnStatesKeepOnlyASubtleOverlayAndBrows', () => {
    for (const st of ExpressivePlan.turnStates) {
      const g = sceptical().gated(st, false, false);
      expect(g).not.toBeNull();
      expect(g!.move === null && g!.cue === null && g!.gaze === 'none').toBe(true);
      expect(Math.abs(g!.intensity - ExpressivePlan.cueMaxOverlay * 0.5)).toBeLessThan(1e-5);
      expect(Math.abs(g!.browAmount - ExpressivePlan.turnBrowScale)).toBeLessThan(1e-5);
      expect(g!.hold).toBeLessThanOrEqual(ExpressivePlan.turnMaxHold);
    }
  });

  test('sleepyDropsBedtimeCalmsReduceMotionStillsGovernorDropsMoves', () => {
    for (const st of ExpressivePlan.sleepyStates) expect(sceptical().gated(st, false, false)).toBeNull();
    const bed = sceptical().gated('noticing', true, false);
    expect(bed).not.toBeNull();
    expect(bed!.move === null && bed!.cue === null && bed!.intensity < sceptical().intensity).toBe(true);
    const rm = sceptical().gated('noticing', false, true);
    expect(rm).not.toBeNull();
    expect(rm!.move === null && rm!.gaze === 'none' && rm!.onset > sceptical().onset).toBe(true);
    const hot = sceptical().gated('noticing', false, false, 0.2);
    expect(hot).not.toBeNull();
    expect(hot!.move === null && hot!.cue !== null).toBe(true);
    expect(new ExpressivePlan({ gaze: 'lookAt' }).gated('thinking', false, false)).toBeNull();
  });

  test('validatedClampsNonFinite', () => {
    const p = new ExpressivePlan({
      intensity: NaN, onset: -1, hold: Infinity, release: 100, browAmount: 4, moveIntensity: 9,
    }).validated();
    expect(p.intensity === 0 && p.onset === 0.05 && p.hold === 1 && p.release === 6 && p.browAmount === 1).toBe(true);
    expect(p.moveIntensity).toBe(OneShotRequest.amplitudeIntensityRange[1]);
  });

  // needs the full default stack (lights up once WP6/WP7 register every modifier, ExpressiveOverlay)
  test.skipIf(missingModifiers().length > 0)('playSendsMoveCueAndGlanceThenBlendsAndReleases', () => {
    const e = engine();
    const neutralBrows = e.state.output.brows.copy();
    const played = e.playExpressive(sceptical());
    expect(played).not.toBeNull();
    expect(played!.move).toBe('curiousTilt');
    expect(e.state.commands.some((c) => c.kind === 'play' && c.request.kind === 'curiousTilt')).toBe(true);
    expect(e.state.commands.some((c) => c.kind === 'reactionCue')).toBe(true);
    expect(e.state.commands.some((c) => c.kind === 'glance')).toBe(true);
    let peakWeight = 0, peakLift = 0;
    for (let i = 0; i < Math.trunc(1.4 * 60); i++) {
      const f = e.tick(1.0 / 60);
      peakWeight = Math.max(peakWeight, overlay(e).overlayWeight);
      peakLift = Math.max(peakLift, f.brows.lane('right', 'y') - neutralBrows.lane('right', 'y'));
      for (const j of BrowLayout.usedIndices) {
        expect(Number.isFinite(f.brows.raw[j])).toBe(true);
        expect(f.brows.raw[j] >= BrowLayout.lowerBounds[j] - 1e-4 && f.brows.raw[j] <= BrowLayout.upperBounds[j] + 1e-4)
          .toBe(true);
      }
    }
    expect(peakWeight > 0.35 && peakWeight <= ExpressivePlan.cueMaxOverlay + 1e-3).toBe(true);
    expect(peakLift).toBeGreaterThan(0.08); // the lead (right) brow is up
    for (let i = 0; i < 3 * 60; i++) e.tick(1.0 / 60);
    expect(overlay(e).overlayWeight).toBe(0);
    expect(Math.abs(overlay(e).browLevels.x) < 1e-3 && Math.abs(overlay(e).browLevels.y) < 1e-3).toBe(true);
    expect(overlay(e).plan).toBeNull();
  });

  // needs the full default stack (lights up once WP6/WP7 register every modifier)
  test.skipIf(missingModifiers().length > 0)('busyOneShotDropsTheMoveButKeepsTheRest', () => {
    const e = engine();
    e.send(FaceCommand.playOneShot('laugh'));
    e.tick(1.0 / 60);
    const played = e.playExpressive(sceptical());
    expect(played).not.toBeNull();
    expect(played!.move === null && played!.brow === 'sceptical').toBe(true);
    expect(e.state.commands.some((c) => c.kind === 'play')).toBe(false);
  });

  // needs the full default stack (lights up once WP6/WP7 register every modifier, ExpressiveOverlay)
  test.skipIf(missingModifiers().length > 0)('speakingPlaysQuietly', () => {
    const e = engine('speaking');
    const played = e.playExpressive(sceptical());
    expect(played).not.toBeNull();
    expect(played!.move === null && played!.cue === null && played!.gaze === 'none').toBe(true);
    expect(e.state.commands.length).toBe(0);
    let peak = 0;
    for (let i = 0; i < 90; i++) { e.tick(1.0 / 60); peak = Math.max(peak, overlay(e).overlayWeight); }
    expect(peak > 0.12 && peak <= 0.225 + 1e-3).toBe(true);
  });

  // needs the full default stack (lights up once WP6/WP7 register every modifier)
  test.skipIf(missingModifiers().length > 0)('asleepPlaysNothing', () => {
    const e = engine('asleep');
    expect(e.playExpressive(sceptical())).toBeNull();
    expect(e.state.commands.length).toBe(0);
  });

  // needs the full default stack (lights up once WP6/WP7 register every modifier, ExpressiveOverlay)
  test.skipIf(missingModifiers().length > 0)('aReplacedPlanNeverSnaps', () => {
    const e = engine();
    e.playExpressive(new ExpressivePlan({ expression: 'Happiness', intensity: 0.9, hold: 2, brow: 'raise' }));
    for (let i = 0; i < 40; i++) e.tick(1.0 / 60);
    let last = overlay(e).overlayWeight;
    e.playExpressive(new ExpressivePlan({ expression: 'Concerned', intensity: 0.9, hold: 2, brow: 'worried' }));
    for (let i = 0; i < 60; i++) {
      e.tick(1.0 / 60);
      const w = overlay(e).overlayWeight;
      expect(Math.abs(w - last)).toBeLessThan(0.12);
      last = w;
    }
  });

  // needs the full default stack (lights up once WP6/WP7 register every modifier, ExpressiveOverlay, TouchReactions)
  test.skipIf(missingModifiers().length > 0)('overrideIgnoresTheOverlayAndTouchOverlayWins', () => {
    const e = engine();
    e.playExpressive(new ExpressivePlan({ expression: 'Happiness', intensity: 1, hold: 3 }));
    for (let i = 0; i < 30; i++) e.tick(1.0 / 60);
    expect(e.state.reactionOverlay?.equals(ExpressionMix.single('Happiness', 1))).toBe(true);
    // Annoyed pokes: TouchReactions' overlay takes over and the plan never stomps on it.
    for (let i = 0; i < 6; i++) {
      e.send(FaceCommand.tap({ x: 0.1, y: 0 }));
      for (let j = 0; j < 12; j++) e.tick(1.0 / 60);
    }
    for (let i = 0; i < 240; i++) e.tick(1.0 / 60);
    if (e.state.reactionOverlayWeight >= touchYield) {
      expect(e.state.reactionOverlay?.equals(ExpressionMix.single('Happiness', 1)) ?? false).toBe(false);
    }
  });
});
