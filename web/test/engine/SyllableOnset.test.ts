// Port of Tests/FaceEngineTests/SyllableOnsetTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import { VocalContour } from '../../src/model';
import {
  FaceCommand, FaceEngine, SyllableOnsetDetector, type OneShotKind, type SyllableOnset,
} from '../../src/engine';

interface Syllable { start: number; length: number; peak: number }

/// A synthetic speech envelope (0…1 dB-scaled level, 5 ms hop): syllables with a 30 ms rise from a valley to a peak,
/// a held vowel with a little jitter, a 40 ms fall, and silent pauses.
class SyntheticSpeech {
  syllables: Syllable[] = [];
  end = 0;
  static readonly hop = 0.005;

  /// `count` syllables at `rate` Hz from `start`; every `stressEvery`-th is 6 dB louder.
  word(start: number, count: number, rate: number, peak = 0.65, stressEvery = 0): void {
    for (let i = 0; i < count; i++) {
      const stressed = stressEvery > 0 && i % stressEvery === 0;
      this.syllables.push({ start: start + i / rate, length: 0.7 / rate, peak: stressed ? peak + 0.15 : peak });
    }
    this.end = Math.max(this.end, start + count / rate);
  }

  level(t: number, jitter: number): number {
    let v = 0;
    for (const s of this.syllables) {
      const u = t - s.start;
      if (!(u >= 0 && u < s.length + 0.04)) continue;
      const valley = 0.35;
      const rise = Math.min(u / 0.03, 1);
      const fall = u > s.length ? 1 - (u - s.length) / 0.04 : 1;
      v = Math.max(v, (valley + (s.peak - valley) * rise) * fall + (u > 0.03 && u < s.length ? jitter : 0));
    }
    return v;
  }

  /// Runs the detector over the whole envelope (+ 0.5 s of silence).
  detect(seed = 1): SyllableOnset[] {
    const d = new SyllableOnsetDetector();
    const rng = new SplitMix64(seed);
    const out: SyllableOnset[] = [];
    let t = 0;
    while (t < this.end + 0.5) {
      const j = (Number(rng.next() % 1000n) / 1000 - 0.5) * 0.04;
      const o = d.push(this.level(t, j), 100 + t);
      if (o) out.push(o);
      t += SyntheticSpeech.hop;
    }
    return out;
  }
}

describe('SyllableOnset', () => {
  test.each([3.0, 4.0, 5.0, 6.0, 7.0])('syllableTrainsAreFoundWithin15ms (rate %d)', (rate) => {
    const sp = new SyntheticSpeech();
    sp.word(0.2, 12, rate);
    const found = sp.detect();
    expect(found.length).toBe(sp.syllables.length);
    for (let i = 0; i < Math.min(found.length, sp.syllables.length); i++) {
      expect(Math.abs(found[i].hostTime - (100 + sp.syllables[i].start)), `rate ${rate} #${i}`).toBeLessThanOrEqual(0.015);
    }
  });

  test('noDoubleTriggersAndPausesAreSilent', () => {
    const sp = new SyntheticSpeech();
    sp.word(0.1, 3, 5);
    sp.word(1.4, 4, 5); // a 0.7 s pause between the words
    const found = sp.detect(7);
    expect(found.length).toBe(7);
    for (let i = 1; i < found.length; i++) {
      expect(found[i].hostTime - found[i - 1].hostTime).toBeGreaterThanOrEqual(SyllableOnsetDetector.minInterOnset);
    }
    // Nothing in the pause.
    expect(found.some((o) => o.hostTime > 100.75 && o.hostTime < 101.39)).toBe(false);
    // The first syllable after the pause knows its gap (a hop, like the babble's).
    expect(found[3].gap).toBeGreaterThan(0.6);
    expect(SyllableOnsetDetector.cue(found[3]).accent).toBe(true);
  });

  test('silenceAndSteadyToneProduceNothing', () => {
    const d = new SyllableOnsetDetector();
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const level = i < 200 ? 0 : 0.6; // one rise, then steady
      if (d.push(level, i * 0.005) !== null) n += 1;
    }
    expect(n).toBe(1);
  });

  test('louderSyllablesGetBiggerAccents', () => {
    const sp = new SyntheticSpeech();
    sp.word(0.2, 12, 4, 0.65, 3);
    const found = sp.detect();
    expect(found.length).toBe(12);
    const stressed = found.filter((_, i) => i % 3 === 0 && i > 0).map((o) => o.accent);
    const plain = found.filter((_, i) => i % 3 !== 0).map((o) => o.accent);
    expect(Math.min(...stressed)).toBeGreaterThan(Math.max(...plain));
    expect(stressed.every((a) => a >= SyllableOnsetDetector.accentCue)).toBe(true);
    for (const o of found) expect(o.accent >= 0 && o.accent <= 1).toBe(true);
  });

  test('nonFiniteAndOutOfOrderSamplesAreIgnored', () => {
    const d = new SyllableOnsetDetector();
    expect(d.push(NaN, 1)).toBeNull();
    expect(d.push(0.5, Infinity)).toBeNull();
    expect(d.push(0.9, 0.5)).toBeNull(); // older than the last sample
  });
});

// TODO(WP7): VocalRig lives with the VocalSync tests; this stand-in keeps the bodies typechecking.
interface VocalSyncView { activations: number; hopCount: number }
class VocalRig {
  readonly vs: VocalSyncView = { activations: 0, hopCount: 0 }; // TODO(WP7): new VocalSync()
  readonly engine = new FaceEngine({ modifiers: [] /* TODO(WP7): [this.vs] */ });
  host = 5000;
  constructor(readonly fps = 60) { this.frame(); }
  get dt(): number { return 1 / this.fps; }
  frame(): void { this.host += this.dt; this.engine.tick(this.dt, this.host); }
  get faceYCanvas(): number { return 0; } // TODO(WP7): VocalRig.faceYCanvas
}

/// The Spoken voice's syllable cues go through VocalSync exactly like the babble's notes.
describe('TalkingBounce', () => {
  /// Feeds a synthetic sentence through the detector into VocalSync, frame by frame, as the controller does
  /// (levels audible slightly ahead of the frame), and returns the face's vertical travel per frame.
  function speak(sp: SyntheticSpeech, rig: VocalRig, paired?: OneShotKind): number[] {
    const d = new SyllableOnsetDetector();
    const t0 = rig.host + 0.05;
    let fed = 0;
    const ys: number[] = [];
    while (fed < sp.end + 0.6) {
      rig.frame();
      // Everything rendered up to 20 ms ahead of this frame (the output latency) is visible to the main actor.
      while (t0 + fed <= rig.host + 0.02) {
        const o = d.push(sp.level(fed, 0), t0 + fed);
        if (o) rig.engine.send(FaceCommand.vocalCue(SyllableOnsetDetector.cue(o, paired)));
        fed += SyntheticSpeech.hop;
      }
      ys.push(rig.faceYCanvas);
    }
    return ys;
  }
  const maxAbs = (a: number[]): number => Math.max(...a.map(Math.abs));

  // needs WP7 (VocalSync)
  test.skip('spokenSyllablesBounceTheFaceAndSettleInPauses', () => {
    const rig = new VocalRig();
    const sp = new SyntheticSpeech();
    sp.word(0, 6, 5, 0.65, 3);
    const ys = speak(sp, rig);
    expect(rig.vs.activations).toBe(6);
    expect(rig.vs.hopCount).toBeGreaterThanOrEqual(3);
    const travel = maxAbs(ys);
    expect(travel > 0.5 && travel < 2.5, `hop travel ${travel} canvas units`).toBe(true);
    // Settled 0.4 s after the last syllable.
    expect(Math.abs(ys[ys.length - 1])).toBeLessThan(0.05);
  });

  // needs WP7 (VocalSync)
  test.skip('spokenAndBabbleCuesMoveTheFaceTheSame', () => {
    // The same note train as babble cues (hand-made) and as detected syllables: same hop count, similar travel.
    const a = new VocalRig(), b = new VocalRig();
    const sp = new SyntheticSpeech();
    sp.word(0, 5, 4);
    const spoken = speak(sp, a);
    const start = b.host + 0.05;
    for (const s of sp.syllables) {
      b.engine.send(FaceCommand.vocalCue({
        hostTime: start + s.start, duration: 0.15, contour: VocalContour.flat(0), intensity: 0.7,
        articulation: 0.7, valence: 0, kind: 'plain', accent: true, // every IOI is 0.25 s ≥ the hop gap
      }));
    }
    const babble: number[] = [];
    for (let i = 0; i < spoken.length; i++) { b.frame(); babble.push(b.faceYCanvas); }
    expect(a.vs.hopCount).toBe(b.vs.hopCount);
    const pa = maxAbs(spoken), pb = maxAbs(babble);
    expect(Math.abs(pa - pb), `spoken ${pa} vs babble ${pb}`).toBeLessThan(0.5 * pb);
  });

  // needs WP7 (VocalSync)
  test.skip('answerNodDucksTheBounce', () => {
    const free = new VocalRig(), ducked = new VocalRig();
    const sp = new SyntheticSpeech();
    sp.word(0, 5, 4);
    const y0 = maxAbs(speak(sp, free));
    const y1 = maxAbs(speak(sp, ducked, 'nodYes'));
    expect(y1, `ducked ${y1} vs free ${y0}`).toBeLessThan(0.5 * y0);
  });
});
