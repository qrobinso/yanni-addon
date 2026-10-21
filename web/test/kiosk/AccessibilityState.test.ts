// Port of YanniKioskTests/AccessibilityStateTests.swift.
import { describe, expect, test } from 'vitest';
import { FaceAccessibility, FaceSpokenState, LoadDot, SpokenStateThrottle } from '../../src/kiosk/FaceSpokenState';

describe('AccessibilityState', () => {
  test('spoken state mapping', () => {
    expect(FaceSpokenState.of('asleep', true)).toBe('asleep');
    expect(FaceSpokenState.of('idle', false)).toBe('awake');
    expect(FaceSpokenState.of('engaged', true)).toBe('lookingAtYou');
    expect(FaceSpokenState.of('followUp', true)).toBe('listening');
    expect(FaceSpokenState.of('hasMessage', false)).toBe('hasMessage');
    expect(FaceSpokenState.of('waking', false)).toBe('wakingUp');
  });

  test('first state publishes at once', () => {
    const t = new SpokenStateThrottle();
    expect(t.update('awake', 0)).toBe('awake');
    expect(t.update('awake', 0.25)).toBeNull();
  });

  test('flicker never reaches the screen reader', () => {
    const t = new SpokenStateThrottle();
    t.update('awake', 0);
    let published = 0;
    for (let i = 1; i <= 400; i++) if (t.update(i % 2 === 0 ? 'lookingAtYou' : 'awake', i * 0.25) !== null) published += 1;
    expect(published).toBe(0);
    expect(t.published).toBe('awake');
  });

  test('changes are settled and rate limited', () => {
    const t = new SpokenStateThrottle();
    t.update('awake', 0);
    const times: number[] = [];
    const states: FaceSpokenState[] = ['lookingAtYou', 'listening', 'thinking', 'speaking'];
    let now = 0;
    while (now < 60) {
      now += 0.25;
      if (t.update(states[Math.trunc(now / 1.5) % states.length], now) !== null) times.push(now);
    }
    expect(times.length).toBeGreaterThan(0);
    expect(times[0]).toBeGreaterThanOrEqual(SpokenStateThrottle.settle);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(SpokenStateThrottle.minInterval - 1e-9);
    expect(times.length).toBeLessThanOrEqual(Math.trunc(60 / SpokenStateThrottle.minInterval) + 1);
  });

  test('load dot', () => {
    expect(LoadDot.of(0, 'ok')).toBe('green');
    expect(LoadDot.of(1, 'ok')).toBe('yellow');
    expect(LoadDot.of(2, 'ok')).toBe('yellow');
    expect(LoadDot.of(3, 'ok')).toBe('orange');
    expect(LoadDot.of(4, 'ok')).toBe('red');
    expect(LoadDot.of(0, 'degraded')).toBe('orange');
    expect(LoadDot.of(4, 'degraded')).toBe('red');
    expect(LoadDot.of(0, 'safe_mode')).toBe('red');
  });

  test('FaceAccessibility words, throttled, and the asleep flag', () => {
    const a = new FaceAccessibility();
    expect(a.poll('engaged', true, 'awake', 0)).toBe(true);
    expect(a.value).toBe('awake and looking at you');
    expect(a.poll('asleep', false, 'asleep', 0.25)).toBe(false);   // not settled yet
    expect(a.isAsleep).toBe(true);
    for (let t = 0.5; t <= 4; t += 0.25) a.poll('asleep', false, 'asleep', t);
    expect(a.value).toBe('asleep');
  });
});
