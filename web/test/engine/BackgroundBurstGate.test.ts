// Port of Tests/FaceEngineTests/BackgroundBurstGateTests.swift.
import { describe, expect, test } from 'vitest';
import { BackgroundBurstStyle, OneShotKind, tintEquals, type FaceEngine } from '../../src/engine';
import * as T from './BackgroundBurstHarness';

function noBurst(e: FaceEngine, note: string): void {
  e.playBackgroundBurst('laugh');
  e.playBackgroundBurst('heartEyes');
  let level = 0;
  T.run(e, 1, (_, b) => { level = Math.max(level, b.burst.level); });
  expect(level, `${note}: level`).toBe(0);
}

/// Colour bursts: the per-kind table and the gates (mood mode only, visible background, awake).
describe('BackgroundBurstGate', () => {
  // MARK: Per-kind table

  test('everyKindHasAnEntryAndTheFamiliesAreAuthored', () => {
    const S = BackgroundBurstStyle;
    expect(S.standardTable.length).toBe(OneShotKind.count);
    for (const k of OneShotKind.allCases) expect(S.standardTable[OneShotKind.ordinal(k)].equals(S.standard(k))).toBe(true);
    for (const k of ['laugh', 'nodYesBig', 'starEyes'] as const) expect(tintEquals(S.standard(k).tint, S.marigold)).toBe(true);
    expect(tintEquals(S.standard('heartEyes').tint, S.pink)).toBe(true);
    for (const k of ['bigSurprise', 'exclaimEyes'] as const) expect(tintEquals(S.standard(k).tint, S.aqua)).toBe(true);
    for (const k of ['mockOffense', 'shakeNoBig'] as const) expect(tintEquals(S.standard(k).tint, S.coral)).toBe(true);
    expect(tintEquals(S.standard('curiousTilt').tint, S.lift)).toBe(true);
    // The gentle answers are gentle tints of their big siblings' hues.
    expect(tintEquals(S.standard('nodYes').tint, S.marigold)).toBe(true);
    expect(tintEquals(S.standard('shakeNo').tint, S.coral)).toBe(true);
    expect(S.standard('nodYes').strength < 0.5 && S.standard('shakeNo').strength < 0.5).toBe(true);
  });

  test.each(['yawn', 'nodOff', 'sleepySink', 'wake'] as const)('sleepyKindsHaveNoBurst %s', (kind) => {
    expect(BackgroundBurstStyle.standard(kind).isNone).toBe(true);
    const e = T.settled();
    e.playBackgroundBurst(kind);
    T.run(e, 1);
    expect(T.bg(e).burst.lastOnsetTime).toBe(-Infinity);
  });

  test('stretchAtDrowsyHasNoBurst', () => {
    const e = T.settled();
    e.setAgentState('drowsy');
    T.run(e, 0.5);
    e.playBackgroundBurst('stretch');
    const d = T.run(e, 1);
    expect(T.maxOf(d)).toBeLessThan(1e-5);
  });

  // MARK: Gates

  test('onlyInMoodMode', () => {
    noBurst(T.settled((c) => { c.mode = 'fixed'; }), 'fixed');
    noBurst(T.settled((c) => { c.mode = 'black'; }), 'black');
    noBurst(T.settled((c) => { c.colourBursts = false; }), 'bursts off');
    noBurst(T.settled((c) => { c.burstStrength = 0; }), 'strength 0');
  });

  test('onlyWhileTheBackgroundIsVisible', () => {
    const asleep = T.settled();
    asleep.setAgentState('asleep');
    T.run(asleep, 4);
    noBurst(asleep, 'asleep');

    const suppressed = T.settled();
    suppressed.setBackgroundSuppressed(true);
    noBurst(suppressed, 'governor-suppressed (presence target 0)');

    const bedtime = T.settled();
    bedtime.setBedtime(true);
    noBurst(bedtime, 'bedtime black');

    const kept = T.settled((c) => { c.colourAtBedtime = true; });
    kept.setBedtime(true);
    kept.playBackgroundBurst('laugh');
    let level = 0;
    T.run(kept, 0.5, (_, b) => { level = Math.max(level, b.burst.level); });
    expect(level, 'colour kept at bedtime → bursts too').toBeGreaterThan(0.3);
  });

  test('aBurstScalesWithStrength', () => {
    const peak = (k: number): number => {
      const e = T.settled((c) => { c.burstStrength = k; });
      e.playBackgroundBurst('heartEyes');
      let level = 0;
      T.run(e, 0.8, (_, b) => { level = Math.max(level, b.burst.level); });
      return level;
    };
    const full = peak(1), half = peak(0.5);
    expect(full).toBeGreaterThan(0.3);
    // Strength scales the authored peak (the luminance bound may cut the full one further).
    expect(half < full && half <= 0.5 * BackgroundBurstStyle.standard('heartEyes').strength + 1e-4,
      `half ${half} vs full ${full}`).toBe(true);
  });
});
