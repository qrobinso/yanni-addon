// Port of FacePerceptionTests/GestureEventLayerTests.swift: the shared firing rules (design §6.5): onset, hysteresis,
// the aimed-at gate, precedence, the beat budget and habituation.
import { describe, expect, test } from 'vitest';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { GestureBeatBudget } from '../../src/perception/GestureBeatBudget';
import { DecisionRing, GestureEventLayer } from '../../src/perception/GestureEventLayer';
import { GestureRecognizer } from '../../src/perception/GestureRecognizer';
import { makeGesturePerson } from '../../src/perception/Gestures';
import { PerceptionProcessor } from '../../src/perception/PerceptionProcessor';
import {
  GestureKind, type Chirality, type GestureDecision, type GestureObservation,
} from '../../src/perception/PerceptionTypes';
import {
  LookTarget, SyntheticGesture, SyntheticPerson, SyntheticScene, SyntheticScenes,
} from '../../src/perception/SyntheticScenes';

function run(s: SyntheticScene): { gestures: GestureObservation[]; decisions: GestureDecision[] } {
  const p = new PerceptionProcessor(undefined, new CameraGeometry(undefined, s.cameraOffset), 3);
  const g: GestureObservation[] = [], d: GestureDecision[] = [];
  for (const f of s.recording().frames) {
    const o = p.process(f);
    g.push(...o.snapshot.gestures);
    d.push(...o.snapshot.gestureDecisions);
  }
  return { gestures: g, decisions: d };
}

const person = (looks: [number, LookTarget][], gestures: [number, number, SyntheticGesture, Chirality][], distance = 1.2,
  duration = 6): SyntheticScene =>
  new SyntheticScene('layer', duration, [new SyntheticPerson({ path: [[0, 0, distance]], looks, gestures })]);

const L = LookTarget, G = SyntheticGesture;
const thumbs = (g: GestureObservation[]): GestureObservation[] => g.filter((x) => x.kind.kind === 'thumbsUp');

describe('GestureEventLayerTests', () => {
  test('aHeldPoseWithoutOnsetNeverFires', () => {
    // A fist resting at chest height for 3 s, then the thumb comes up without the hand moving.
    const r = run(person([[0, L.eyes]], [[0, 3, G.fist, 'right'], [3, 6, G.thumbsUp, 'right']]));
    expect(thumbs(r.gestures)).toEqual([]);
    expect(r.decisions.some((d) => d.kind === 'thumbsUp' && d.reason.startsWith('no onset'))).toBe(true);
  });

  test('hysteresisNeedsTheShapeGoneFor0_5s', () => {
    const brief = run(person([[0, L.eyes]], [[1.5, 3, G.thumbsUp, 'right'], [3.2, 5, G.thumbsUp, 'right']]));
    expect(thumbs(brief.gestures).length, "a 0.2 s break doesn't re-arm").toBe(1);
    const long = run(person([[0, L.eyes]], [[1, 2.3, G.thumbsUp, 'right'], [3.5, 5.5, G.thumbsUp, 'right']], 1.2, 7));
    expect(thumbs(long.gestures).length, '1.2 s gone: a new gesture').toBe(2);
  });

  test('aimedGateNearNeedsALookWithin1_5s', () => {
    const away = run(person([[0, L.away(45)]], [[1.5, 3, G.thumbsUp, 'right']]));
    expect(thumbs(away.gestures)[0]?.directedAtYanni).toBe(false);
    const justLooked = run(person([[0, L.eyes], [1.2, L.away(45)]], [[1.5, 3, G.thumbsUp, 'right']]));
    expect(thumbs(justLooked.gestures)[0]?.directedAtYanni).toBe(true);
    const longAgo = run(person([[0, L.eyes], [0.3, L.away(45)]], [[1.5, 3.5, G.thumbsUp, 'right']]));
    expect(thumbs(longAgo.gestures)[0]?.directedAtYanni).toBe(false);
  });

  test('aimedGateFarNeedsFacing', () => {
    const facing = run(person([[0, L.eyes]], [[1.5, 3, G.thumbsUp, 'right']], 2.3));
    expect(thumbs(facing.gestures)[0]?.directedAtYanni).toBe(true);
    const tv = run(person([[0, L.away(45)]], [[1.5, 3, G.thumbsUp, 'right']], 2.3));
    expect(thumbs(tv.gestures)[0]?.directedAtYanni, 'watching TV past the iPad').toBe(false);
  });

  test('precedenceOneGesturePerPersonPer0_8s', () => {
    const r = new GestureRecognizer();
    const p = makeGesturePerson({ id: 1, headCentre: { x: 0.5, y: 0.4 }, distance: 1.2, position: { x: 0, y: 0 }, facing: 1, lastLook: 99.9 });
    const si = r.slotIndex(1, 100);
    const z = { x: 0, y: 0 };
    const heart = r.fire(GestureKind.heartHands, si, p, { conf: 0.9, hand: null, at: z, now: 100, others: false });
    const thumb = r.fire(GestureKind.thumbsUp, si, p, { conf: 0.9, hand: 'right', at: z, now: 100.3, others: false });
    expect(heart && !thumb, 'a two-hand gesture beats the one-hand shapes it contains').toBe(true);
    expect(r.decisions[r.decisions.length - 1]?.reason).toBe('precedence');
    const later = r.fire(GestureKind.thumbsUp, si, p, { conf: 0.9, hand: 'right', at: z, now: 101, others: false });
    const nod = r.fire(GestureKind.nod, si, p, { conf: 0.9, hand: null, at: z, now: 101.1, others: false });
    expect(later && nod, 'after 0.8 s; nod is its own channel').toBe(true);
  });

  test('directedScore', () => {
    const p = makeGesturePerson({ id: 1, headCentre: { x: 0, y: 0 }, distance: 1.2, position: { x: 0, y: 0 }, facing: 1 });
    expect(GestureEventLayer.directedScore(p, true, true, false)).toBeGreaterThan(0.9);
    const q = { ...p, facing: 0.2 };
    expect(GestureEventLayer.directedScore(q, false, true, true), 'turned toward someone else, hands down').toBeLessThan(0.5);
  });

  test('beatBudget', () => {
    const b = new GestureBeatBudget();
    expect(b.refusal(0)).toBeNull();
    b.record(1, 0, 0);
    expect(b.refusal(7), '1 per 8 s').not.toBeNull();
    expect(b.refusal(8)).toBeNull();
    for (let i = 1; i < 5; i++) b.record(i + 1, 2, i * 10);
    expect(b.refusal(100)?.includes('10 min'), '5 per 10 min').toBe(true);
    expect(b.refusal(601)).toBeNull();
  });

  test('habituationFadesThenGoesQuiet', () => {
    const b = new GestureBeatBudget();
    expect(b.intensity(1, 6, 0)).toBe(1);
    b.record(1, 6, 0);
    expect(b.intensity(1, 6, 30)).toBe(0.6);
    b.record(1, 6, 30);
    expect(b.intensity(1, 6, 60)).toBe(0.3);
    b.record(1, 6, 60);
    expect(b.intensity(1, 6, 90), 'events only').toBeNull();
    expect(b.intensity(1, 6, 350), 'for 5 min').toBeNull();
    expect(b.intensity(1, 6, 361)).toBe(1);
    expect(b.intensity(2, 6, 90), 'another person is fresh').toBe(1);
    expect(b.intensity(1, 7, 90), 'another gesture is fresh').toBe(1);
  });

  test('memoryStaysBoundedWithPeopleComingAndGoing', () => {
    const p = new PerceptionProcessor(undefined, new CameraGeometry(undefined, { x: 0, y: -0.11 }), 3);
    const scenes = [SyntheticScenes.simulatorDemo, SyntheticScenes.busyNone, SyntheticScenes.twoPeopleEngage];
    let t = 1000;
    let n = 0;
    while (n < 10_000) {
      for (const s of scenes) {
        for (const f of s.recording().frames) {
          f.time = t; t += 1 / 15;
          p.process(f);
          n += 1;
        }
      }
    }
    expect(p.gestures.slots.length).toBe(GestureRecognizer.slotCount);
    expect(p.gestures.log.items.length).toBeLessThanOrEqual(DecisionRing.capacity);
    expect(p.tracker.tracks.length).toBeLessThanOrEqual(p.tracker.params.maxTracks * 2);
  }, 120_000);
});
