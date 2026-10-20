// Port of Tests/FaceEngineTests/AnswerTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import { BrowLayout, FacePose, BrowPose, ParamLayout, Units, type BrowLane } from '../../src/model';
import { OneShotLibrary, OneShotParams, answerTitle, gentleAnswer, type OneShotKind } from '../../src/engine';
import { AnswerAccents, answerReducedMotion } from '../../src/engine/AnswerCurves';

/// The answers: yes (nodYes), absolutely yes (nodYesBig), no (shakeNo), absolutely not (shakeNoBig).
const answers: OneShotKind[] = ['nodYes', 'nodYesBig', 'shakeNo', 'shakeNoBig'];

/// Peaks of an answer's curves over its whole duration (canvas units, degrees, fractions).
class Peaks {
  x = 0; y = 0; angle = 0; scale = 0; lids = 0; pupilX = 0; pupilY = 0;
  browUp = 0; browRotation = 0; browInner = 0;
  browLane = new Array<number>(32).fill(0);
  tX = 0; tY = 0; tPupilX = 0; tPupilY = 0;

  constructor(kind: OneShotKind, p: OneShotParams = new OneShotParams(), until?: number) {
    const d = until ?? OneShotLibrary.duration(kind, p);
    let t = 0;
    while (t <= d) {
      const o = OneShotLibrary.sample(kind, t, p);
      const cx = Math.abs(Units.canvasX(o.delta.face('centerX'))), cy = Math.abs(Units.canvasY(o.delta.face('centerY')));
      if (cx > this.x) { this.x = cx; this.tX = t; }
      if (cy > this.y) { this.y = cy; this.tY = t; }
      this.angle = Math.max(this.angle, Math.abs(o.delta.face('angle')));
      this.scale = Math.max(this.scale, Math.abs(o.faceScaleMul.y - 1), Math.abs(o.delta.eye('left', 'scaleX')),
        Math.abs(o.delta.eye('right', 'scaleX')));
      for (const v of [o.lidCoverage.x, o.lidCoverage.y, o.lidCoverage.z, o.lidCoverage.w]) this.lids = Math.max(this.lids, Math.abs(v));
      if (Math.abs(o.delta.eye('left', 'x')) > this.pupilX) { this.pupilX = Math.abs(o.delta.eye('left', 'x')); this.tPupilX = t; }
      if (Math.abs(o.delta.eye('left', 'y')) > this.pupilY) { this.pupilY = Math.abs(o.delta.eye('left', 'y')); this.tPupilY = t; }
      for (const side of ParamLayout.Side.allCases) {
        this.browUp = Math.max(this.browUp, o.browDelta.lane(side, 'y'));
        this.browRotation = Math.min(this.browRotation, o.browDelta.lane(side, 'rotation'));
        this.browInner = Math.min(this.browInner, o.browDelta.lane(side, 'inner'));
      }
      for (const i of BrowLayout.usedIndices) this.browLane[i] = Math.max(this.browLane[i], Math.abs(o.browDelta.get(i)));
      t = Math.fround(t + 0.0025); // f32: Swift's Float playhead
    }
  }

  get travel(): number { return Math.max(this.x, this.y); }
}

const withParams = (f: (p: OneShotParams) => void): OneShotParams => { const p = new OneShotParams(); f(p); return p; };

describe('AnswerCurveTests', () => {
  test.each(answers)('startsAndEndsAtRest(%s)', (kind) => {
    const rng = new SplitMix64(21);
    for (let i = 0; i < 6; i++) {
      const p = OneShotLibrary.makeParams(kind, rng, { x: 0, y: 0 });
      const d = OneShotLibrary.duration(kind, p);
      for (const t of [0, d, d + 0.1]) {
        const o = OneShotLibrary.sample(kind, t, p);
        expect(o.delta.equals(FacePose.zero) && o.browDelta.equals(BrowPose.zero)
          && o.lidCoverage.x === 0 && o.lidCoverage.y === 0 && o.lidCoverage.z === 0 && o.lidCoverage.w === 0
          && o.blink === 0, `${kind} at ${t}`).toBe(true);
        expect(o.faceScaleMul).toEqual({ x: 1, y: 1 });
        expect(o.pupilSizeMul).toEqual({ x: 1, y: 1 });
      }
    }
  });

  test.each(answers)('amplitudesStayInBounds(%s)', (kind) => {
    const k = new Peaks(kind, withParams((p) => { p.amp = 1.1; }));
    expect(k.travel >= 3 && k.travel <= 6, `${kind} travel ${k.travel}`).toBe(true);
    expect(k.angle >= 0.5 && k.angle <= 4, `${kind} angle ${k.angle}`).toBe(true);
    expect(k.scale, `${kind} scale`).toBeLessThanOrEqual(0.2);
    expect(k.lids, `${kind} lids`).toBeLessThanOrEqual(0.5);
    expect(k.pupilX <= 0.55 && k.pupilY <= 0.3, `${kind} pupils ${k.pupilX}, ${k.pupilY}`).toBe(true);
  });

  test('nodsAreVerticalAndShakesHorizontal', () => {
    for (const kind of ['nodYes', 'nodYesBig'] as const) {
      const k = new Peaks(kind);
      expect(k.x < 1e-4 && k.y > 3.5, `${kind}: x ${k.x} y ${k.y}`).toBe(true);
      expect(k.pupilY > 0.15 && k.pupilX < 1e-4).toBe(true);
    }
    for (const kind of ['shakeNo', 'shakeNoBig'] as const) {
      const k = new Peaks(kind);
      expect(k.x, `${kind}: x ${k.x} y ${k.y}`).toBeGreaterThan(2.5 * k.y);
      expect(k.pupilX).toBeGreaterThan(0.3);
    }
  });

  test('emphaticAnswersAreBiggerThanGentleOnes', () => {
    const yes = new Peaks('nodYes'), yesBig = new Peaks('nodYesBig'), no = new Peaks('shakeNo'), noBig = new Peaks('shakeNoBig');
    expect(yesBig.y).toBeGreaterThan(1.15 * yes.y);
    expect(yesBig.lids, 'delighted squint').toBeGreaterThan(1.4 * yes.lids);
    expect(yesBig.browUp, 'brows pop').toBeGreaterThan(1.5 * yes.browUp);
    expect(noBig.x).toBeGreaterThan(1.2 * no.x);
    expect(noBig.angle).toBeGreaterThan(no.angle);
    expect(noBig.browRotation < 3 * no.browRotation && noBig.browInner < 1.5 * no.browInner, 'the mock-annoyed V').toBe(true);
    expect(noBig.lids, 'flat upper lids').toBeGreaterThan(2 * no.lids);
    // Durations: yes ≈ 0.7 s, no ≈ 0.8 s, the emphatic ones ≈ 1 s.
    expect(Math.abs(OneShotLibrary.spec('nodYes').duration - 0.7)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(OneShotLibrary.spec('shakeNo').duration - 0.8)).toBeLessThanOrEqual(0.07);
    expect(Math.abs(OneShotLibrary.spec('nodYesBig').duration - 1.0)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(OneShotLibrary.spec('shakeNoBig').duration - 1.0)).toBeLessThanOrEqual(0.12);
  });

  /// The pupils lead the head: their first big excursion peaks before the face's.
  test.each(answers)('pupilsLeadTheHead(%s)', (kind) => {
    const first = OneShotLibrary.spec(kind).accentTimes[0];
    const k = new Peaks(kind, new OneShotParams(), first + 0.06);
    if (kind.startsWith('nod')) {
      expect(k.tPupilY, `${kind}: pupils ${k.tPupilY} head ${k.tY}`).toBeLessThan(k.tY - 0.015);
    } else {
      expect(k.tPupilX, `${kind}: pupils ${k.tPupilX} head ${k.tX}`).toBeLessThan(k.tX - 0.015);
    }
  });

  /// Brows move only on the lanes each answer authors.
  test('browsMoveOnlyWhereAuthored', () => {
    const lanes = (kind: OneShotKind): BrowLane[] => {
      const k = new Peaks(kind, withParams((p) => { p.v2 = 0.2; }));
      return BrowLayout.Lane.allCases.filter((l) => k.browLane[BrowLayout.index('left', l)] > 1e-5);
    };
    expect(lanes('nodYes')).toEqual(['y', 'curvature']);
    expect(lanes('nodYesBig')).toEqual(['y', 'curvature', 'peak']);
    expect(lanes('shakeNo')).toEqual(['y', 'rotation', 'curvature', 'inner']);
    expect(lanes('shakeNoBig')).toEqual(['y', 'rotation', 'curvature', 'inner', 'outer', 'peak']);
    // Yes lifts the brows; no lowers them.
    expect(new Peaks('nodYes').browUp).toBeGreaterThan(0.04);
    expect(new Peaks('shakeNo').browRotation < -2 && new Peaks('shakeNo').browUp < 0.02).toBe(true);
  });

  test.each(answers)('reduceMotionShrinksTheMoveButKeepsTheMeaning(%s)', (kind) => {
    const p = new OneShotParams(); const rm = p.copy(); rm.reduceMotion = true;
    const full = new Peaks(kind, p), small = new Peaks(kind, rm);
    expect(Math.abs(small.travel - answerReducedMotion * full.travel), kind).toBeLessThan(0.05);
    expect(small.angle).toBeLessThan(0.45 * full.angle);
    expect(small.lids, 'lids keep their meaning').toBe(full.lids);
    // No squash or stretch of the face.
    let t = 0;
    while (t < OneShotLibrary.duration(kind, rm)) {
      expect(OneShotLibrary.sample(kind, t, rm).faceScaleMul.y).toBe(1);
      t = Math.fround(t + 0.01);
    }
    p.intensity = 0.5;
    expect(Math.abs(new Peaks(kind, p).travel - 0.5 * full.travel)).toBeLessThan(0.05);
  });

  test('accentTimesMatchTheTables', () => {
    expect(OneShotLibrary.spec('nodYes').accentTimes).toEqual([...AnswerAccents.nodYes]);
    expect(OneShotLibrary.spec('nodYesBig').accentTimes).toEqual([...AnswerAccents.nodYesBig]);
    expect(OneShotLibrary.spec('shakeNo').accentTimes).toEqual([...AnswerAccents.shakeNo]);
    expect(OneShotLibrary.spec('shakeNoBig').accentTimes).toEqual([...AnswerAccents.shakeNoBig]);
    expect(gentleAnswer('nodYesBig') === 'nodYes' && gentleAnswer('shakeNoBig') === 'shakeNo').toBe(true);
    expect(answerTitle('laugh') === null && answerTitle('shakeNoBig') === 'absolutely not').toBe(true);
  });
});
