// Port of Tests/FaceEngineTests/EmotionExpressionTests.swift.
import { describe, expect, test } from 'vitest';
import { AgentStateProfiles, EmotionAuthority, ExpressionTransition, FaceEngine, type AgentState } from '../../src/engine';
import { ExpressionLibrary, ExpressionMix, FacePose, ParamLayout, mixEntry as E } from '../../src/model';
import { ASTRig } from './ASTRig';

const lib = ExpressionLibrary.bundled();

function rig(): ASTRig {
  const r = new ASTRig([new ExpressionTransition()]);
  r.tick();
  return r;
}

function trajectory(fps: number): FacePose[] {
  const r = rig();
  const dt = 1 / fps;
  const per = fps / 60;
  const out: FacePose[] = [];
  for (let frame = 1; frame <= fps * 3; frame++) {
    const prior = frame - 1;
    if (prior % per === 0) {
      switch (prior / per) {
        case 10: r.state.emotionMix = new ExpressionMix([E('Happiness', 0.7), E('Surprise', 0.3)], 0.8); r.state.emotionWeight = 0.9; break;
        case 40: if (r.state.emotionMix) r.state.emotionMix.intensity = 1.05; break;
        case 70: r.state.emotionMix = ExpressionMix.single('Concerned', 0.7); break;
        case 100: r.setAgentState('thinking'); break;
        case 130: r.state.emotionMix = null; r.state.emotionWeight = 0; break;
        default: break;
      }
    }
    r.tick(dt);
    if (frame % per === 0) out.push(r.state.basePose.copy());
  }
  return out;
}

/// The emotion layer's expression input (`setEmotionExpression`, `emotionAuthority`) as ExpressionTransition blends it.
describe('EmotionExpression', () => {
  test('weightTimesAuthorityBlendsTowardTheEmotion', () => {
    const r = rig();
    r.state.emotionMix = ExpressionMix.single('Happiness');
    r.state.emotionWeight = 1;
    r.run(3);
    // idle authority 0.6: the target is 60 % of the way from Neutral to Happiness.
    const n = lib.neutral, h = lib.get('Happiness')!.pose;
    const i = ParamLayout.index('left', 'lowerLidY');
    const expected = n.raw[i] + (h.raw[i] - n.raw[i]) * EmotionAuthority.defaultValue('idle');
    expect(Math.abs(r.state.basePose.raw[i] - expected)).toBeLessThan(2e-3);
    expect(r.state.targetMix.equals(ExpressionMix.neutral)).toBe(true);
  });

  test('zeroWeightOrAuthorityIsExactlyTheStateTarget', () => {
    const a = rig(), b = rig();
    a.state.emotionMix = ExpressionMix.single('Sadness');
    a.state.emotionWeight = 0;
    a.setAgentState('sheepish'); b.setAgentState('sheepish');
    a.state.targetMix = AgentStateProfiles.profile('sheepish').mix;
    b.state.targetMix = a.state.targetMix;
    a.run(1); b.run(1);
    expect(a.state.basePose.equals(b.state.basePose)).toBe(true);
    a.state.emotionWeight = 1; // authority 0 in sheepish
    a.run(1); b.run(1);
    expect(a.state.basePose.equals(b.state.basePose)).toBe(true);
  });

  test('weightEasesInAndOutWithoutSnapping', () => {
    const r = rig();
    const et = r.director.modifier('ExpressionTransition') as ExpressionTransition;
    r.state.emotionMix = ExpressionMix.single('Excitement');
    r.state.emotionWeight = 1;
    let last = 0;
    r.run(1.5, undefined, () => {
      expect(et.shownEmotionWeight - last).toBeLessThan(0.06);
      expect(et.shownEmotionWeight).toBeGreaterThanOrEqual(last - 1e-6);
      last = et.shownEmotionWeight;
    });
    expect(Math.abs(last - 0.6)).toBeLessThan(0.01);
    // Cleared: the last mix fades out on the same spring.
    r.state.emotionMix = null;
    r.state.emotionWeight = 0;
    r.run(1.5, undefined, () => {
      expect(last - et.shownEmotionWeight).toBeLessThan(0.06);
      last = et.shownEmotionWeight;
    });
    expect(et.shownEmotionWeight).toBe(0);
  });

  test('overrideIgnoresTheEmotion', () => {
    const a = rig(), b = rig();
    a.state.emotionMix = ExpressionMix.single('Happiness');
    a.state.emotionWeight = 1;
    a.state.expressionOverride = ExpressionMix.single('Anger');
    b.state.expressionOverride = ExpressionMix.single('Anger');
    a.run(1); b.run(1);
    expect(a.state.basePose.equals(b.state.basePose)).toBe(true);
  });

  test('frameRateIndependent', () => {
    const a = trajectory(60), b = trajectory(120);
    let worst = 0;
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      for (let i = 0; i < ParamLayout.count; i++) {
        const rr = ParamLayout.ranges[i];
        worst = Math.max(worst, Math.abs(a[k].get(i) - b[k].get(i)) / Math.min(rr.upperBound - rr.lowerBound, 3));
      }
    }
    expect(worst, `worst relative deviation ${worst}`).toBeLessThanOrEqual(1e-3);
  });

  test('authorityTableValidatesAndCodes', () => {
    const t = new EmotionAuthority();
    t.set('idle', 5);
    t.set('speaking', NaN);
    const v = t.validated();
    expect(v.get('idle') === 1 && v.get('speaking') === EmotionAuthority.defaultValue('speaking')).toBe(true);
    const data = JSON.stringify(v);
    expect(EmotionAuthority.fromJSON(JSON.parse(data)).equals(v)).toBe(true);
    const partial = EmotionAuthority.fromJSON(JSON.parse('{"thinking": 0.2}'));
    expect(partial.get('thinking') === 0.2 && partial.get('idle') === 0.6).toBe(true);
    for (const s of ['interrupted', 'notForMe', 'confused', 'sheepish', 'drowsy', 'asleep', 'halfAwake', 'waking'] as AgentState[]) {
      expect(new EmotionAuthority().get(s)).toBe(0);
    }
  });

  test('facadeClampsTheWeight', () => {
    const e = new FaceEngine();
    e.setEmotionExpression(ExpressionMix.single('Happiness'), 3);
    expect(e.state.emotionWeight).toBe(1);
    e.setEmotionExpression(ExpressionMix.single('Happiness'), NaN);
    expect(e.state.emotionWeight).toBe(0);
    e.setEmotionExpression(null, 1);
    expect(e.state.emotionWeight).toBe(0);
  });
});
