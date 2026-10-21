// Port of Tests/FaceVoiceTests/MappingSnapTests.swift.
import { expect, test } from 'vitest';
import { PentatonicSnap, PhraseShaping, VoiceAffect, VoiceFingerprint, type Phrase } from '../../src/voice';
import { fresh, mean, noteList } from './voiceTestSupport';

test('nearestDegree', () => {
  expect(PentatonicSnap.nearest(6.2, false)).toBe(7);
  expect(PentatonicSnap.nearest(4.2, true)).toBe(5);
  expect(PentatonicSnap.nearest(1.2, true)).toBe(0);
  expect(PentatonicSnap.nearest(-1.2, false)).toBe(0);
  expect(PentatonicSnap.nearest(-2.6, false)).toBe(-3);     // 9 − 12
  expect(PentatonicSnap.nearest(13.8, false)).toBe(14);
  expect(Math.abs(PentatonicSnap.snap(6, 0.5, false) - 6.5) < 1e-5).toBe(true);
  expect(PentatonicSnap.snap(6, 0, false)).toBe(6);
  expect(PentatonicSnap.degree(5, false)).toBe(12);
  expect(PentatonicSnap.degree(-1, true)).toBe(-2);
});

/// Deviation of each note target from the scale, relative to the first note (declination removed).
function deviation(p: Phrase, minor: boolean): number[] {
  const ns = noteList(p);
  const r0 = ns[0].contour.start;
  const out: number[] = [];
  for (let i = 1; i < ns.length; i++) {
    const iv = ns[i].contour.start + PhraseShaping.declinationPerNote * i - r0;
    out.push(Math.abs(iv - PentatonicSnap.nearest(iv, minor)));
  }
  return out;
}

test('intervalsSnapToMajorOrMinorPentatonic', () => {
  const full = VoiceFingerprint.default;
  full.scaleSnap = 1;
  const none = VoiceFingerprint.default;
  none.scaleSnap = 0;
  for (const [pleasure, minor] of [[0.6, false], [-0.6, true]] as const) {
    const a = VoiceAffect.make(pleasure, -0.2, 0.3);
    const snapped: number[] = [], free: number[] = [];
    for (let seed = 0; seed < 300; seed++) {
      const ds = deviation(fresh('emote', a, seed, full), minor);
      for (const d of ds) expect(d <= 0.25, `off-scale by ${d}`).toBe(true);    // ±12 cents residual on both notes
      snapped.push(...ds);
      free.push(...deviation(fresh('emote', a, seed, none), minor));
    }
    expect(mean(snapped) < 0.15).toBe(true);
    expect(mean(free) > 2 * mean(snapped)).toBe(true);
  }
});
