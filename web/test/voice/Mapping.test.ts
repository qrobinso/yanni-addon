// Port of Tests/FaceVoiceTests/MappingTests.swift.
import { expect, test } from 'vitest';
import { EmotionMapping, PhraseGenerator, VoiceAffect, VoiceFingerprint, allVoiceReactions, type Phrase } from '../../src/voice';
import { last, meanOver, notesOf, peakDB, pitchAt, tonal } from './voiceTestSupport';

const levels = [-0.8, 0, 0.8];
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function increasing(v: number[], what: string): void {
  for (let i = 1; i < v.length; i++) expect(v[i] > v[i - 1], `${what} not increasing: ${v}`).toBe(true);
}
function decreasing(v: number[], what: string): void {
  for (let i = 1; i < v.length; i++) expect(v[i] < v[i - 1], `${what} not decreasing: ${v}`).toBe(true);
}

test('pleasureRaisesSlopeBrightnessAndVowel', () => {
  const affects = levels.map((x) => VoiceAffect.make(x, 0.2, 0.2));
  increasing(affects.map((a) => meanOver('emote', a, (p) => {
    const ns = notesOf(p);
    return (last(ns).contour.end - ns[0].contour.start) + sum(ns.map((n) => n.contour.end - n.contour.start)) / ns.length;
  })), 'slope');
  for (const r of allVoiceReactions) {
    increasing(affects.map((a) => meanOver(r, a, (p) => Math.max(...notesOf(p).filter(tonal).map((n) => n.timbre.cutoff)), 40)), `${r} cutoff`);
    increasing(affects.map((a) => meanOver(r, a, (p) => sum(notesOf(p).filter(tonal).map((n) => n.timbre.vowelEnd)), 40)), `${r} vowel`);
  }
});

test('pleasureAddsSwing', () => {
  const fp = VoiceFingerprint.default;
  const m0 = EmotionMapping.parameters(VoiceAffect.make(-0.5, 0, 0), fp);
  const m1 = EmotionMapping.parameters(VoiceAffect.make(0.3, 0, 0), fp);
  const m2 = EmotionMapping.parameters(VoiceAffect.make(1, 0, 0), fp);
  expect(m0.swing).toBe(1);
  expect(m1.swing >= 1.25 && m1.swing < m2.swing).toBe(true);
  expect(Math.abs(m2.swing - 1.6) < 1e-4).toBe(true);
  expect(m0.noteDuration > m2.noteDuration).toBe(true);
});

test('arousalMoreNotesFasterHigherWider', () => {
  const affects = levels.map((x) => VoiceAffect.make(0.1, x, 0.2));
  increasing(affects.map((a) => meanOver('emote', a, (p) => p.notes.length)), 'count');
  decreasing(affects.map((a) => meanOver('emote', a, (p) => sum(notesOf(p).map((n) => n.duration)) / p.notes.length)), 'duration');
  increasing(affects.map((a) => meanOver('emote', a, (p) => sum(notesOf(p).map((n) => (n.contour.start + n.contour.end) / 2)) / p.notes.length)), 'register');
  increasing(affects.map((a) => meanOver('emote', a, (p: Phrase) => {
    const ns = notesOf(p);
    if (ns.length <= 1) return 0;
    let s = 0;
    for (let i = 1; i < ns.length; i++) s += Math.abs(ns[i].contour.start - ns[i - 1].contour.start);
    return s / (ns.length - 1);
  })), 'interval');
  increasing(affects.map((a) => meanOver('emote', a, (p) => Math.max(...notesOf(p).map((n) => n.timbre.fmIndexPeak)))), 'FM peak');
});

test('dominanceSteadierFirmerLouder', () => {
  const affects = levels.map((x) => VoiceAffect.make(0.1, 0.2, x));
  decreasing(affects.map((a) => meanOver('emote', a, (p) =>
    sum(notesOf(p).map((n) => n.contour.wobbleDepth + n.modulation.vibratoDepth)) / p.notes.length + 1e-3)), 'wobble+vibrato');
  decreasing(affects.map((a) => meanOver('emote', a, (p) => sum(notesOf(p).map((n) => n.envelope.attackTau)) / p.notes.length)), 'attack');
  for (const r of allVoiceReactions) {
    increasing(affects.map((a) => meanOver(r, a, peakDB, 40)), `${r} loudness`);
  }
});

test('lowDominanceWobbleAndNervousVibrato', () => {
  const fp = VoiceFingerprint.default;
  const unsure = EmotionMapping.parameters(VoiceAffect.make(0, 0, -1), fp);
  expect(unsure.wobbleDepth >= 1.15 && unsure.wobbleDepth <= 1.2).toBe(true);
  expect(unsure.wobbleRate >= 3 && unsure.wobbleRate <= 4.5).toBe(true);
  const nervous = EmotionMapping.parameters(VoiceAffect.make(0, 0.9, -0.8), fp);
  expect(nervous.nervous && nervous.vibratoRate >= 8 && nervous.vibratoRate <= 10).toBe(true);
  const firm = EmotionMapping.parameters(VoiceAffect.make(0, 0, 1), fp);
  expect(firm.wobbleDepth === 0 && firm.questionChance === 0).toBe(true);
  expect(firm.scoop < unsure.scoop).toBe(true);
});

/// Question endings only for curious / emote / confused (review H1).
test('questionEndingsOnlyWhereAllowed', () => {
  const lowD = VoiceAffect.make(0, 0, -1);
  let emoteQuestions = 0;
  for (let seed = 0; seed < 200; seed++) {
    const g = new PhraseGenerator(VoiceFingerprint.default, BigInt(seed));
    for (const r of allVoiceReactions) {
      const l = last(notesOf(g.make(r, lowD)));
      const rise = l.contour.end - l.contour.start;
      switch (r) {
        case 'curious': case 'confused': expect(rise >= 2, `${r} should ask`).toBe(true); break;
        case 'emote': if (rise >= 2) emoteQuestions += 1; break;
        case 'sheepish': case 'embarrassed': case 'sleepy': case 'startled':
          expect(rise <= 0.01, `${r} must not end rising`).toBe(true);
          expect(pitchAt(l, 1) < pitchAt(l, 0.5), `${r} ends falling`).toBe(true);
          break;
        default: expect(rise < 1.5, `${r} question-like ending`).toBe(true);
      }
    }
  }
  expect(emoteQuestions > 120).toBe(true);
  // High dominance: emote never asks.
  const g = new PhraseGenerator(VoiceFingerprint.default, 1n);
  for (let i = 0; i < 100; i++) {
    const l = last(notesOf(g.make('emote', VoiceAffect.make(0, 0, 0.8))));
    expect(l.contour.glideOnset).toBe(0);
  }
});
