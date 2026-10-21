// Port of Tests/FaceVoiceTests/ReactionTests.swift.
import { expect, test } from 'vitest';
import { AgentState, type OneShotKind } from '../../src/engine';
import {
  Phrase, PhraseGenerator, VoiceAffect, VoiceFingerprint, VoiceReactionTables, allVoiceReactions,
  type Note, type VoiceReaction,
} from '../../src/voice';
import { last, notesOf, padGrid, peakDB, pitchAt, tonal } from './voiceTestSupport';

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function phrases(r: VoiceReaction, perAffect = 6): [VoiceAffect, Note[]][] {
  const out: [VoiceAffect, Note[]][] = [];
  padGrid.forEach((a, i) => {
    const g = new PhraseGenerator(VoiceFingerprint.default, BigInt(1000 + i));
    for (let k = 0; k < perAffect; k++) out.push([a, notesOf(g.make(r, a))]);
  });
  return out;
}

const phraseOf = (ns: Note[]): Phrase => { const p = new Phrase(); for (const n of ns) p.notes.push(n); return p; };

test('curiousEndsRisingWithLongLastNote', () => {
  for (const [, ns] of phrases('curious')) {
    expect(ns.length >= 2 && ns.length <= 3).toBe(true);
    const l = last(ns);
    expect(l.contour.end - l.contour.start >= 2.5).toBe(true);
    expect(Math.abs(l.contour.glideOnset - 0.35) < 1e-5).toBe(true);
    const others = sum(ns.slice(0, -1).map((n) => n.duration)) / (ns.length - 1);
    expect(l.duration >= 1.35 * others, `last ${l.duration} vs ${others}`).toBe(true);
  }
});

test('delightedRunRisesWithOneDip', () => {
  for (const [, ns] of phrases('delighted')) {
    expect(ns.length >= 4 && ns.length <= 7).toBe(true);
    expect(last(ns).contour.start > ns[0].contour.start).toBe(true);
    let downs = 0;
    for (let i = 1; i < ns.length; i++) if (ns[i].contour.start < ns[i - 1].contour.start) downs += 1;
    expect(downs, `dips: ${downs}`).toBe(1);
    expect(last(ns).contour.end > last(ns).contour.start, 'final flick').toBe(true);
    const m = sum(ns.slice(0, -1).map((n) => n.duration)) / (ns.length - 1);
    expect(last(ns).duration > 1.25 * m).toBe(true);
    for (const n of ns.slice(0, -1)) expect(n.duration <= 0.12).toBe(true);
  }
});

test('embarrassedFallsTrillsQuietly', () => {
  for (const [a, ns] of phrases('embarrassed', 3)) {
    expect(ns.length).toBe(1);
    const n = ns[0];
    expect(n.duration >= 0.35 - 1e-4 && n.duration <= 0.55 + 1e-4).toBe(true);
    expect(n.contour.end < n.contour.start - 3.5).toBe(true);
    expect(n.contour.trillDepth > 0.9 && n.contour.trillRate >= 11 && n.contour.trillRate <= 14).toBe(true);
    expect(n.modulation.tremoloDepth > 0.2).toBe(true);
    const g = new PhraseGenerator(VoiceFingerprint.default, 77n);
    const curious = g.make('curious', a);
    expect(peakDB(phraseOf([n])) < peakDB(curious)).toBe(true);
  }
});

test('startledStartsHighOvershootsAndIsLoudest', () => {
  for (const [a, ns] of phrases('startled', 3)) {
    const eep = ns[0];
    expect(eep.contour.start >= 5).toBe(true);
    expect(eep.contour.scoop < 0, 'overshoot').toBe(true);
    expect(eep.envelope.attackTau <= 0.0021).toBe(true);
    expect(eep.timbre.noiseBurst >= 6).toBe(true);
    for (const n of ns.slice(1)) expect(Math.max(n.contour.start, n.contour.end) < eep.contour.start).toBe(true);
    const p = phraseOf(ns);
    const g = new PhraseGenerator(VoiceFingerprint.default, 31n);
    for (const r of allVoiceReactions) {
      if (r === 'startled') continue;
      expect(peakDB(p) > peakDB(g.make(r, a)), `startled vs ${r}`).toBe(true);
    }
  }
});

test('engagedIsTwoSlurredRisingNotes', () => {
  for (const [, ns] of phrases('engaged')) {
    expect(ns.length).toBe(2);
    expect(ns[1].slur && !ns[0].slur).toBe(true);
    expect(ns[1].contour.start - ns[0].contour.start >= 3).toBe(true);
    expect(ns[0].duration >= 0.05 - 1e-4 && ns[0].duration <= 0.07 + 1e-4).toBe(true);
    expect(ns[1].duration >= 0.08 - 1e-4 && ns[1].duration <= 0.11 + 1e-4).toBe(true);
  }
});

test('sleepyInhalesThenFallsSlowly', () => {
  for (const [, ns] of phrases('sleepy')) {
    expect(ns.length).toBe(2);
    expect(!tonal(ns[0]) && ns[0].timbre.noiseBandPass).toBe(true);
    expect(ns[0].contour.end > ns[0].contour.start).toBe(true);
    const sigh = ns[1];
    expect(pitchAt(sigh, 0) - pitchAt(sigh, 1) >= 3).toBe(true);
    expect(pitchAt(sigh, 1) < 0).toBe(true);
    const total = sigh.start + sigh.duration;
    expect(total >= 0.45 - 0.01 && total <= 0.85).toBe(true);
    expect(sigh.timbre.vowelStart < sigh.timbre.vowelEnd).toBe(true);
    expect(sigh.timbre.cutoff < 0.75).toBe(true);
  }
});

test('sheepishTwoFallingNotesWithWobbleAndHardGap', () => {
  for (const [, ns] of phrases('sheepish')) {
    expect(ns.length).toBe(2);
    expect(ns[1].slur).toBe(false);
    expect(ns[1].start - (ns[0].start + ns[0].duration) >= 0.04).toBe(true);
    expect(ns[0].contour.end > ns[0].contour.start).toBe(true);
    expect(ns[1].contour.start < ns[0].contour.end - 2).toBe(true);
    expect(ns[1].contour.wobbleDepth >= 0.4 && Math.abs(ns[1].contour.wobbleRate - 4) < 1e-5).toBe(true);
    expect(pitchAt(ns[1], 1) < ns[1].contour.start, 'second note droops below its target').toBe(true);
  }
});

test('hmphLowHighLow', () => {
  for (const [, ns] of phrases('hmph')) {
    expect(ns.length).toBe(3);
    expect(ns[1].contour.start > ns[0].contour.start && ns[1].contour.start > ns[2].contour.start).toBe(true);
    expect(ns[0].timbre.noiseDB > -26).toBe(true);
  }
});

test('doubleTakeTwoPartsSecondHigherSharper', () => {
  for (const [, ns] of phrases('doubleTake')) {
    expect(ns.length).toBe(2);
    expect(ns[1].start - (ns[0].start + ns[0].duration) >= 0.15).toBe(true);
    expect(ns[1].contour.start > ns[0].contour.start + 2).toBe(true);
    expect(ns[1].envelope.attackTau < ns[0].envelope.attackTau).toBe(true);
  }
});

test('confusedEndsRisingWithWobble', () => {
  for (const [, ns] of phrases('confused')) {
    const l = last(ns);
    expect(l.contour.end > l.contour.start + 2).toBe(true);
    expect(l.contour.wobbleDepth >= 0.5).toBe(true);
  }
});

test('giggleAndDanceTiming', () => {
  const bounces = VoiceReactionTables.giggleBounceTimes;
  for (const [, ns] of phrases('giggle')) {
    expect(ns.length).toBe(3);
    for (let i = 0; i < 3; i++) expect(Math.abs(ns[i].start - (bounces[i] - bounces[0])) <= 0.0045).toBe(true);
  }
  for (const [, ns] of phrases('danceBeat')) {
    expect(ns.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(Math.abs(ns[i].start - i * VoiceReactionTables.danceBeatPeriod) <= 0.0045).toBe(true);
  }
});

/// A simple feature classifier (starts at its peak + very fast attack) separates engaged vs startled.
test('classifierSeparatesEngagedAndStartled', () => {
  const isStartled = (ns: Note[]): boolean => {
    const rest = ns.slice(1).reduce((m, n) => Math.max(m, Math.max(n.contour.start, n.contour.end)), -Infinity);
    return ns[0].contour.start > rest && ns[0].envelope.attackTau <= 0.0025;
  };
  let correct = 0, total = 0;
  for (const [, ns] of phrases('startled')) { total += 1; if (isStartled(ns)) correct += 1; }
  for (const [, ns] of phrases('engaged')) { total += 1; if (!isStartled(ns)) correct += 1; }
  expect(correct / total >= 0.98).toBe(true);
});

test('loudnessSpreadWithinSixDB', () => {
  padGrid.forEach((a, i) => {
    const g = new PhraseGenerator(VoiceFingerprint.default, BigInt(i));
    for (let k = 0; k < 5; k++) {
      const dbs = allVoiceReactions.map((r) => peakDB(g.make(r, a)));
      const spread = Math.max(...dbs) - Math.min(...dbs);
      expect(spread <= 6, `spread ${spread}`).toBe(true);
    }
  });
});

test('tablesCoverMappings', () => {
  const expected: Partial<Record<OneShotKind, VoiceReaction>> = {
    laugh: 'giggle', dance: 'danceBeat', mockOffense: 'hmph', doubleTake: 'doubleTake',
    confusedShake: 'confused', bigSurprise: 'startled', perkUp: 'engaged', delightedSquint: 'delighted',
    curiousTilt: 'curious', yawn: 'sleepy', nodOff: 'sleepy', wake: 'sleepy', lookAway: 'embarrassed',
    sorryBlink: 'sheepish', popUp: 'delighted', shyPeek: 'curious', sleepySink: 'sleepy',
    // Pupil transformations reuse existing chirps (one each; the exclamation's squint stays silent).
    starEyes: 'delighted', heartEyes: 'curious', noteEyes: 'giggle', questionEyes: 'curious', exclaimEyes: 'engaged',
  };
  for (const [k, v] of Object.entries(expected)) expect(VoiceReactionTables.forOneShot(k as OneShotKind), k).toBe(v);
  expect(VoiceReactionTables.forOneShot('sideEye')).toBeNull();
  expect(VoiceReactionTables.forOneShot('curiousLean') === null && VoiceReactionTables.forOneShot('pretendExit') === null).toBe(true);
  const states: Partial<Record<AgentState, VoiceReaction>> = {
    engaged: 'engaged', notForMe: 'embarrassed', sheepish: 'sheepish', confused: 'confused', waking: 'sleepy',
  };
  for (const s of AgentState.allCases) expect(VoiceReactionTables.forAgentStateEntry(s), s).toBe(states[s] ?? null);
});

test('alignNoteIndices', () => {
  const g = new PhraseGenerator(VoiceFingerprint.default, 2n);
  for (const r of allVoiceReactions) {
    const p = g.make(r, VoiceAffect.neutral);
    const ai = PhraseGenerator.alignNoteIndex(p);
    expect(ai >= 0 && ai < p.notes.length).toBe(true);
  }
  expect(PhraseGenerator.alignNoteIndexFor('engaged', 2)).toBe(1);
  expect(PhraseGenerator.alignNoteIndexFor('startled', 2)).toBe(0);
  expect(PhraseGenerator.alignNoteIndexFor('curious', 3)).toBe(2);
  expect(PhraseGenerator.alignNoteIndexFor('doubleTake', 2)).toBe(1);
});
