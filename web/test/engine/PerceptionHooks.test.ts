// Port of Tests/FaceEngineTests/PerceptionHooksTests.swift.
// Perception's edge-antic beats (perception upgrade §6.6): the gates, the booking and the engine facade.
import { describe, expect, test } from 'vitest';
import { ExpressionLibrary, EdgeGeometry } from '../../src/model';
import { AgentState, EdgeAntics, FaceState, makePersonTarget, type OneShotKind } from '../../src/engine';
import { EdgeRig } from './EdgeRigs';

/// A bare state on the reference screen, idle, with every gate open.
function state(): FaceState {
  const s = new FaceState(ExpressionLibrary.bundled(), 9);
  s.edgeGeometry = EdgeGeometry.reference;
  s.time = 100;
  return s;
}

describe('PerceptionEdgeAnticTests', () => {
  test('allGatesOpenPlaysAndBooksLikeAnAutomaticTrigger', () => {
    const m = new EdgeAntics();
    const s = state();
    expect(m.canPlayPerceptionAntic('pretendExit', s)).toBe(true);
    expect(m.playPerceptionAntic('pretendExit', -0.4, s)).toBe(true);
    expect(s.oneShotRequests).toEqual(['pretendExit']);
    expect(s.edgeSideHint).toBe(-1);
    expect(s.lastEdgeAnticTime).toBe(100);
    expect(m.lastAntic === 'pretendExit' && m.lastAnticTime === 100 && m.triggerCount === 1).toBe(true);
    expect(m.nextAnticAt ?? 0).toBeGreaterThan(100);
  });

  test('onlyScreenEdgeAntics', () => {
    const m = new EdgeAntics();
    const s = state();
    for (const k of ['laugh', 'sleepySink', 'starEyes', 'nodYes'] as OneShotKind[]) expect(m.canPlayPerceptionAntic(k, s), k).toBe(false);
    for (const k of ['shyPeek', 'popUp', 'curiousLean', 'pretendExit'] as OneShotKind[]) expect(m.canPlayPerceptionAntic(k, s), k).toBe(true);
  });

  /// Each gate alone rejects, and a rejection changes nothing.
  test('eachGateRejectsWithoutSideEffects', () => {
    const cases: [string, (s: FaceState) => void][] = [
      ['no screen', (s) => { s.edgeGeometry = null; }],
      ['antics off', (s) => { s.edgeSettings.enabled = false; }],
      ['antic off', (s) => { s.edgeSettings.pretendExit.enabled = false; }],
      ['bedtime', (s) => { s.isBedtime = true; }],
      ['sulking', (s) => { s.isSulking = true; }],
      ['one-shot playing', (s) => { s.activeOneShots = ['curiousTilt']; }],
      ['antic queued', (s) => { s.oneShotRequests = ['popUp']; }],
      ['idle beat 10 s ago', (s) => { s.lastIdleBeatTime = 90; }],
      ['edge antic 10 s ago', (s) => { s.lastEdgeAnticTime = 90; }],
      ['engaged', (s) => { s.people = [makePersonTarget(3, { x: 0, y: 0 })]; s.engagedPersonID = 3; }],
    ];
    for (const st of AgentState.allCases) {
      if (st !== 'idle' && st !== 'noticing') cases.push([`state ${st}`, (s) => { s.agentState = st; }]);
    }
    for (const [label, apply] of cases) {
      const m = new EdgeAntics();
      const s = state();
      apply(s);
      const requests = [...s.oneShotRequests];
      expect(m.canPlayPerceptionAntic('pretendExit', s), label).toBe(false);
      expect(m.playPerceptionAntic('pretendExit', 1, s), label).toBe(false);
      expect(s.oneShotRequests, label).toEqual(requests);
      expect(s.edgeSideHint, label).toBe(0);
      expect(m.triggerCount === 0 && m.lastAntic === null && m.nextAnticAt === null, label).toBe(true);
    }
  });

  test('noticingAndSpacingBoundaryAllow', () => {
    const m = new EdgeAntics();
    const s = state();
    s.agentState = 'noticing';
    s.people = [makePersonTarget(1, { x: 0.5, y: 0 })];
    s.engagedPersonID = 2; // engaged person not in view: nobody engaged
    s.lastIdleBeatTime = 100 - EdgeAntics.idleActivitySpacing;
    expect(m.canPlayPerceptionAntic('curiousLean', s)).toBe(true);
  });

  test('perKindCooldown', () => {
    const m = new EdgeAntics();
    const s = state();
    expect(m.playPerceptionAntic('curiousLean', 1, s)).toBe(true);
    s.oneShotRequests.length = 0;
    s.time += 30; // spacing passed; the lean's own 60 s cooldown not
    expect(m.canPlayPerceptionAntic('curiousLean', s)).toBe(false);
    expect(m.canPlayPerceptionAntic('shyPeek', s)).toBe(true);
    s.time += 31;
    expect(m.canPlayPerceptionAntic('curiousLean', s)).toBe(true);
  });

  test('engineFacadePlaysOnTheNextFrame', () => {
    const rig = new EdgeRig({ automatic: true });
    const beats = rig.engine.director.modifier('IdleBeats');
    if (beats) beats.isEnabled = false;
    expect(rig.engine.canPlayPerceptionEdgeAntic('pretendExit')).toBe(true);
    expect(rig.engine.playPerceptionEdgeAntic('pretendExit', 1)).toBe(true);
    expect(rig.engine.canPlayPerceptionEdgeAntic('popUp'), 'queued').toBe(false);
    rig.tick();
    expect(rig.engine.state.activeOneShots).toEqual(['pretendExit']);
    expect(rig.edge.triggerCount).toBe(1);
    expect(rig.engine.playPerceptionEdgeAntic('popUp', 1), 'busy').toBe(false);
    // Off when the antics are switched off, though manual triggers still play.
    const off = new EdgeRig({ automatic: false });
    expect(off.engine.playPerceptionEdgeAntic('pretendExit', 1)).toBe(false);
  });
});
