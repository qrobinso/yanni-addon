// Port of Tests/FaceLifeTests/LifeTimerTests.swift: daytime timers, activity, catch-yourself, presence waking, taps.
import { describe, expect, test } from 'vitest';
import { LifePhase, LifeSettings, type CameraMode } from '../../src/life';
import { LifeRig, fullStackTest, req } from './LifeRig';

const quick = (drowsy = 0.25, asleep = 0.25): LifeSettings => new LifeSettings({ minutesToDrowsy: drowsy, minutesToAsleep: asleep });

describe('LifeTimerTests', () => {
  // MARK: Timers

  test('idleToDrowsyToAsleepAtConfiguredTimes', () => {
    const rig = new LifeRig({ settings: quick() });   // 15 s + 15 s, real time
    const toDrowsy = req(rig.runUntil(30, () => rig.state === 'drowsy'));
    expect(Math.abs(toDrowsy - 15)).toBeLessThan(0.2);
    const toAsleep = req(rig.runUntil(30, () => rig.state === 'asleep'));
    expect(Math.abs(toAsleep - 15)).toBeLessThan(0.2);
    expect(rig.changes.map((c) => c.to)).toEqual(['drowsy', 'asleep']);
    expect(rig.changes.every((c) => c.reason === 'timer')).toBe(true);
    expect(rig.sawNonFinite).toBe(false);
  });

  test('timeWarpScalesMinuteTimers', () => {
    const rig = new LifeRig();                       // defaults: 3 + 3 minutes
    rig.life.timeWarp = 60;
    const toDrowsy = req(rig.runUntil(10, () => rig.state === 'drowsy'));
    expect(Math.abs(toDrowsy - 3)).toBeLessThan(0.1);
    const toAsleep = req(rig.runUntil(10, () => rig.state === 'asleep'));
    expect(Math.abs(toAsleep - 3)).toBeLessThan(0.1);
  });

  test('warpChangeMidTimerDoesNotJump', () => {
    const rig = new LifeRig();                       // 3 minutes to drowsy
    rig.run(60);                                     // 1 minute at ×1
    rig.life.timeWarp = 60;
    rig.frame();
    expect(rig.state, 'switching warp must not jump the timer').toBe('idle');
    const rest = req(rig.runUntil(10, () => rig.state === 'drowsy'));
    expect(Math.abs(rest - 2)).toBeLessThan(0.1);
  });

  test('longGapIsClamped', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.run(5);
    rig.clock.advance(3600);                         // backgrounded for an hour
    rig.frame();
    expect(rig.state, 'a long gap advances the timers by at most one clamped step').toBe('idle');
    rig.life.noteActivity('foreground');
    rig.run(14);
    expect(rig.state, 'foreground return counts as activity').toBe('idle');
    expect(rig.runUntil(2, () => rig.state === 'drowsy')).not.toBeNull();
  });

  fullStackTest('activityResetsTheClock', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.run(10);
    rig.life.noteActivity('speech');
    rig.run(10);
    expect(rig.state).toBe('idle');
    rig.tap();
    rig.run(10);
    expect(rig.state === 'idle' || rig.state === 'noticing', `taps while awake only reset the clock (${rig.state})`).toBe(true);
    expect(rig.runUntil(8, () => rig.state === 'drowsy')).not.toBeNull();
  });

  fullStackTest('awakeTapsNeverTriggerSleepLogic', () => {
    const rig = new LifeRig({ settings: quick() });
    for (let i = 0; i < 6; i++) { rig.tap(); rig.run(2); }
    expect(LifePhase.of(rig.state)).toBe('awake');
    expect(rig.touch.tapsToWake).toBe(1);
    expect(rig.changes.some((c) => c.to !== 'awake')).toBe(false);
  });

  test('presenceHoldsYanniAwakeInTheDaytime', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.person(true);
    rig.run(40);
    expect(rig.state).toBe('noticing');
    expect(rig.life.nextTransition?.seconds ?? null).toBeNull();
  });

  // MARK: Catch yourself

  fullStackTest('drowsyCatchesItselfUncutAndStaysDim', () => {
    const rig = new LifeRig({ settings: quick(0.5, 5) });   // 30 s idle (dims after 20 s), long drowsy
    req(rig.runUntil(40, () => rig.state === 'drowsy'));
    rig.run(3);
    let completedCatch = false, sawCatch = false, maxLevel = 0;
    rig.life.noteActivity('motion');
    const back = rig.runUntil(4, () => {
      if (rig.engine.state.activeOneShots.includes('catchSelf')) {
        sawCatch = true;
        expect(rig.state, 'stays drowsy while catching itself').toBe('drowsy');
      }
      if (rig.engine.state.completedOneShots.includes('catchSelf')) completedCatch = true;
      maxLevel = Math.max(maxLevel, rig.brightnessLevel);
      return rig.state === 'idle';
    });
    expect(back !== null && back > 0.8, `idle only after the catch one-shot (${back})`).toBe(true);
    expect(sawCatch && completedCatch, 'catchSelf played to completion').toBe(true);
    rig.run(3, 1 / 30, () => { maxLevel = Math.max(maxLevel, rig.brightnessLevel); });
    expect(maxLevel, 'empty room stays dim through the catch').toBeLessThan(0.63);
    expect(rig.changes[rig.changes.length - 1]?.reason).toBe('activity');
  });

  fullStackTest('personArrivingWhileDrowsyCatchesThenNotices', () => {
    const rig = new LifeRig({ settings: quick(0.25, 5) });
    req(rig.runUntil(20, () => rig.state === 'drowsy'));
    rig.person(true);
    const t = req(rig.runUntil(4, () => rig.state === 'noticing'));
    expect(t).toBeGreaterThan(0.8);
  });

  // MARK: Waking by people (daytime)

  fullStackTest('engagedPersonWakesGently', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.fallAsleep();
    expect(rig.state).toBe('asleep');
    rig.person(true, { engaged: true });
    req(rig.runUntil(2, () => rig.state === 'halfAwake'));
    req(rig.runUntil(1, () => rig.state === 'waking'));
    req(rig.runUntil(6, () => rig.state === 'noticing'));
    expect(rig.changes.slice(-3).map((c) => c.reason)).toEqual(['person', 'person', 'external']);
  });

  test('passerByHalfWakesAndDriftsBack', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.fallAsleep();
    rig.person(true);                                // not facing, not engaged
    const t = req(rig.runUntil(2, () => rig.state === 'halfAwake'));
    expect(t, 'debounced').toBeGreaterThanOrEqual(0.69);
    rig.run(3);
    expect(rig.state).toBe('halfAwake');
    rig.person(false);
    const back = req(rig.runUntil(6, () => rig.state === 'asleep'));
    expect(Math.abs(back - 4), `back to sleep 4 s after they leave (${back})`).toBeLessThan(0.2);
  });

  test('primaryTurnedAwayIsNotFacing', () => {
    // A primary passer-by with their head turned away (facing 0.2) is not "facing Yanni": only the 8 s linger rule wakes.
    const rig = new LifeRig({ settings: quick() });
    rig.fallAsleep();
    rig.person(true, { facing: true, facingAmount: 0.2 });
    req(rig.runUntil(2, () => rig.state === 'halfAwake'));
    const t = req(rig.runUntil(10, () => rig.state === 'waking'));
    expect(t).toBeGreaterThan(6.5);
    // Turning toward Yanni (facing 0.8) counts.
    const facing = new LifeRig({ settings: quick() });
    facing.fallAsleep();
    facing.person(true, { facing: true, facingAmount: 0.8 });
    req(facing.runUntil(2, () => facing.state === 'halfAwake'));
    const tf = req(facing.runUntil(8, () => facing.state === 'waking'));
    expect(tf > 4.5 && tf < 5.6, `facing ≥ 6 s from arrival (${tf})`).toBe(true);
  });

  test('facingOrLingeringWakes', () => {
    const facing = new LifeRig({ settings: quick() });
    facing.fallAsleep();
    facing.person(true, { facing: true });
    req(facing.runUntil(2, () => facing.state === 'halfAwake'));
    const tf = req(facing.runUntil(8, () => facing.state === 'waking'));
    expect(tf > 4.5 && tf < 5.6, `facing ≥ 6 s from arrival (${tf})`).toBe(true);

    const linger = new LifeRig({ settings: quick() });
    linger.fallAsleep();
    linger.person(true);
    req(linger.runUntil(2, () => linger.state === 'halfAwake'));
    const tl = req(linger.runUntil(10, () => linger.state === 'waking'));
    expect(tl > 6.5 && tl < 7.6, `lingering ≥ 8 s from arrival (${tl})`).toBe(true);
  });

  test('oneFrameDetectionsWhileAsleepNeverHalfWake', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.fallAsleep();
    for (let i = 0; i < 10; i++) {
      rig.person(true); rig.frame();
      rig.person(false); rig.run(1);
    }
    expect(rig.state).toBe('asleep');
  });

  test('dropoutsWhileHalfAwakeDontDriftBack', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.fallAsleep();
    rig.person(true);
    req(rig.runUntil(2, () => rig.state === 'halfAwake'));
    for (let i = 0; i < 5; i++) {                    // a 1-frame dropout every second, for 5 s
      rig.person(false); rig.frame();
      rig.person(true); rig.run(1);
    }
    expect(rig.state === 'halfAwake' || rig.state === 'waking').toBe(true);
  });

  // MARK: Taps (daytime)

  fullStackTest('asleepTapWakesInTheDaytime', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.fallAsleep();
    expect(rig.touch.tapsToWake).toBe(1);
    rig.tap();
    rig.frame();
    // Gently (waking) or, by the random startle (TouchReactions.startleChance), with a big surprise straight up.
    const startled = rig.engine.state.activeOneShots.includes('bigSurprise');
    expect(rig.state === 'noticing' || rig.state === 'waking' || (startled && rig.state === 'idle')).toBe(true);
    expect(rig.changes[rig.changes.length - 1]?.reason === 'tap' || startled).toBe(true);
  });

  // MARK: Re-sync

  fullStackTest('panelAndTapMidCycleResync', () => {
    const rig = new LifeRig({ settings: quick() });
    req(rig.runUntil(20, () => rig.state === 'drowsy'));
    rig.engine.setAgentState('idle');                // the panel
    rig.frame();
    expect(rig.changes[rig.changes.length - 1]?.reason).toBe('external');
    rig.run(14);
    expect(rig.state, 'an external change counts as activity: the clock restarted').toBe('idle');
    req(rig.runUntil(3, () => rig.state === 'drowsy'));

    rig.tap();                                       // TouchReactions wakes from drowsy
    rig.frame();
    expect(LifePhase.of(rig.state)).not.toBe('drowsy');
    rig.run(10);
    expect(LifePhase.of(rig.state)).toBe('awake');

    rig.engine.setAgentState('asleep');              // panel puts it to sleep: honoured, no instant wake
    rig.run(5);
    expect(rig.state).toBe('asleep');
  });

  test('cameraLowOnlyWhenAsleep', () => {
    const rig = new LifeRig({ settings: quick() });
    const seen = new Map<LifePhase, CameraMode>();
    rig.run(40, 1 / 30, () => { seen.set(rig.life.phase, rig.life.cameraMode); });
    expect(seen.get('awake')).toBe('normal');
    expect(seen.get('drowsy')).toBe('normal');
    expect(seen.get('asleep')).toBe('low');
    rig.person(true);
    rig.runUntil(2, () => rig.state === 'halfAwake');
    expect(rig.life.cameraMode).toBe('normal');
  });

  test('countdownTracksTheTimer', () => {
    const rig = new LifeRig({ settings: quick() });
    rig.run(5);
    const c = req(rig.life.nextTransition);
    expect(c.label).toBe('drowsy');
    expect(Math.abs((c.seconds ?? 0) - 10)).toBeLessThan(0.2);
    rig.life.timeWarp = 10;
    rig.frame();
    expect(Math.abs((rig.life.nextTransition?.seconds ?? 0) - 1)).toBeLessThan(0.1);
  });
});
