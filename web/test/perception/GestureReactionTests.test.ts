// Port of Tests/FacePerceptionTests/GestureReactionTests.swift (GestureRowTests): every row of the reflex table
// (design §6.1) and its gating.
import { describe, expect, test } from 'vitest';
import type { AgentState, ReactionCueKind } from '../../src/engine';
import {
  GestureKind, PerceptionReflexes, ReflexBeat, makeGestureObservation, makeReflexContext, reflexImpulseEquals,
  type GestureObservation, type GesturePhase, type PerceptionEffects, type ReflexContext,
} from '../../src/perception';

describe('GestureRowTests', () => {
  const g = (kind: GestureKind, o: { person?: number | null; directed?: boolean; time?: number; phase?: GesturePhase } = {}): GestureObservation =>
    makeGestureObservation({ kind, personID: o.person === undefined ? 1 : o.person, hand: 'right', confidence: 0.9,
      directedAtYanni: o.directed ?? true, at: { x: 0.2, y: 0 }, distance: 1.2, time: o.time ?? 100, phase: o.phase ?? 'instant' });
  const ctx = (s: AgentState = 'noticing', o: { now?: number; busy?: boolean; shape?: boolean; engaged?: number | null } = {}): ReflexContext =>
    makeReflexContext({ agentState: s, primaryID: 1, now: o.now ?? 100, oneShotBusy: o.busy ?? false,
      pupilShapeShowing: o.shape ?? false, engagedID: o.engaged ?? null });
  const cueKind = (fx: PerceptionEffects): ReactionCueKind | null => fx.beat.kind === 'cue' ? fx.beat.cue.kind : null;

  test('eachGestureHasItsOwnBeat', () => {
    // A fresh table per gesture (the global budget would otherwise stop the sixth).
    const next = (k: GestureKind, t: number, s: AgentState = 'noticing'): PerceptionEffects =>
      new PerceptionReflexes().decide(g(k, { time: t }), ctx(s, { now: t }));
    expect(next(GestureKind.clap, 100).beat).toEqual(ReflexBeat.oneShot('laugh'));
    expect(cueKind(next(GestureKind.armsUp, 110))).toBe('delight');
    expect(next(GestureKind.thumbsDown, 120).beat).toEqual(ReflexBeat.oneShot('sorryBlink'));
    expect(next(GestureKind.peace, 130).beat).toEqual(ReflexBeat.oneShot('crossEyed'));
    const heart = next(GestureKind.heartHands, 140);
    expect(cueKind(heart) === 'affection' && heart.fallback === 'delightedSquint').toBe(true);
    expect(next(GestureKind.peekaboo, 150).beat).toEqual(ReflexBeat.oneShot('bigSurprise'));
    expect(next(GestureKind.byeWave(1), 160).beat).toEqual(ReflexBeat.edgeAntic('pretendExit', 1));
    expect(cueKind(next(GestureKind.thumbsUp, 170))).toBe('success');
    expect(next(GestureKind.openPalm, 180, 'idle').beat).toEqual(ReflexBeat.oneShot('perkUp'));
    expect(next(GestureKind.wave, 190).beat).toEqual(ReflexBeat.oneShot('dance'));
  });

  test('impulsesMatchTheTable', () => {
    const r = new PerceptionReflexes();
    expect(reflexImpulseEquals(r.decide(g(GestureKind.heartHands), ctx()).impulse, PerceptionReflexes.heartImpulse)).toBe(true);
    expect(reflexImpulseEquals(r.decide(g(GestureKind.thumbsDown, { time: 110 }), ctx('noticing', { now: 110 })).impulse,
      PerceptionReflexes.thumbsDownImpulse)).toBe(true);
  });

  test('overBudgetNoBeatNoImpulse', () => {
    const r = new PerceptionReflexes();
    r.decide(g(GestureKind.clap), ctx());
    const fx = r.decide(g(GestureKind.peace, { person: 2, time: 104 }), ctx('noticing', { now: 104 }));
    expect(fx.beat.kind === 'none' && fx.impulse === null && fx.reason.startsWith('peace: budget')).toBe(true);
  });

  test('busyAndShapeShowing', () => {
    const r = new PerceptionReflexes();
    expect(r.decide(g(GestureKind.clap), ctx('noticing', { busy: true })).reason).toBe('clap: busy');
    expect(r.decide(g(GestureKind.peekaboo), ctx('noticing', { shape: true })).reason).toBe('peekaboo: shape showing');
    expect(r.decide(g(GestureKind.thumbsDown), ctx('noticing', { shape: true })).reason).toBe('thumbsDown: shape showing');
    expect(r.decide(g(GestureKind.clap), ctx('noticing', { shape: true })).beat, 'a non-urgent beat may play over a showing shape')
      .toEqual(ReflexBeat.oneShot('laugh'));
  });

  test('byeEdgeAnticOnlyIdleWithNobodyEngaged', () => {
    const r = new PerceptionReflexes();
    expect(r.decide(g(GestureKind.byeWave(-1)), ctx('idle')).beat).toEqual(ReflexBeat.edgeAntic('pretendExit', -1));
    const q = new PerceptionReflexes();
    expect(q.decide(g(GestureKind.byeWave(-1)), ctx('noticing', { engaged: 2 })).beat).toEqual(ReflexBeat.oneShot('delightedSquint'));
    const e = new PerceptionReflexes();
    expect(e.decide(g(GestureKind.byeWave(1)), ctx('engaged')).beat).toEqual(ReflexBeat.oneShot('delightedSquint'));
    expect(e.decide(g(GestureKind.byeWave(1), { time: 300 }), ctx('idle', { now: 300 })).beat.kind, '10 min per person').toBe('none');
  });

  test('nodMirrorOnlyInFollowUpForTheEngagedPerson', () => {
    const r = new PerceptionReflexes();
    expect(r.decide(g(GestureKind.nod), ctx('listening', { engaged: 1 })).beat.kind, "a listener's nod is backchannel").toBe('none');
    expect(r.decide(g(GestureKind.nod), ctx('followUp', { engaged: 2 })).beat.kind, 'not the engaged person').toBe('none');
    const fx = r.decide(g(GestureKind.nod), ctx('followUp', { engaged: 1 }));
    expect(fx.beat).toEqual(ReflexBeat.oneShot('nodYes'));
    expect(fx.softVoice).toBe(true);
    expect(r.decide(g(GestureKind.nod, { time: 120 }), ctx('followUp', { now: 120, engaged: 1 })).beat.kind, '30 s').toBe('none');
    expect(r.decide(g(GestureKind.nod, { time: 140 }), ctx('followUp', { now: 140, busy: true, engaged: 1 })).reason).toBe('nod: busy');
  });

  test('dancingOneNoteCueAndOneDancePerEpisode', () => {
    const r = new PerceptionReflexes();
    const fx = r.decide(g(GestureKind.dancing, { phase: 'started' }), ctx());
    if (fx.beat.kind !== 'cue') throw new Error('music cue');
    const c = fx.beat.cue;
    expect(c.kind === 'music' && c.directedAtYanni && fx.fallback === 'dance' && fx.followUp?.kind === 'dance').toBe(true);
    expect(r.decide(g(GestureKind.dancing, { time: 120, phase: 'ended' }), ctx('noticing', { now: 120 })).beat.kind).toBe('none');
    expect(r.decide(g(GestureKind.dancing, { time: 150, phase: 'started' }), ctx('noticing', { now: 150 })).reason).toBe('dancing: same episode');
    const next = r.decide(g(GestureKind.dancing, { time: 215, phase: 'started' }), ctx('noticing', { now: 215 }));
    expect(cueKind(next), 'a new episode after 60 s without dancing').toBe('music');
  });

  test('highFiveArmsTheTouchWindowAndWinsOverTheOpenPalm', () => {
    const r = new PerceptionReflexes();
    const arm = r.decide(g(GestureKind.highFive, { phase: 'started' }), ctx());
    expect(arm.friendlyTouchUntil === 100 + 0.8 && arm.impulse === null && arm.beat.kind === 'none').toBe(true);
    expect(r.decide(g(GestureKind.openPalm, { time: 100.4 }), ctx('idle', { now: 100.4 })).reason).toBe('openPalm: high-five precedence');
    const tap = r.decide(g(GestureKind.highFive, { time: 100.5 }), ctx('noticing', { now: 100.5 }));
    expect(reflexImpulseEquals(tap.impulse, PerceptionReflexes.highFiveImpulse) && tap.activity).toBe(true);
    expect(r.decide(g(GestureKind.highFive, { time: 110, phase: 'started' }), ctx('noticing', { now: 110 })).friendlyTouchUntil, '20 s').toBeNull();
  });
});
