// Port of Tests/FaceEngineTests/PupilReactionsTests.swift.
// The pupil reaction arbiter: cue gates, interrupts, cooldowns, habituation and the settings.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import { EdgeGeometry, FaceFrame, PupilShape } from '../../src/model';
import {
  FaceCommand, FaceEngine, PupilReactions, PupilReactionSettings, ReactionCueKind, isPupilShape, makeReactionCue,
  type AgentState, type OneShotKind,
} from '../../src/engine';
import { TouchReactions } from '../../src/engine/modifiers/TouchReactions';
import * as Shape from '../../src/engine/PupilShapeCurves';
import { ShapeRig, allShapes, cue, hasDefaultPupils, rig as makeRig, send } from './ShapeRig';
import { VocalRig } from './VocalRig';

/// A full default engine on a screen (EdgeAnticTests.swift's EdgeRig, the parts used here).
class EdgeRig {
  readonly engine = new FaceEngine({ seed: 42 });
  constructor() {
    this.engine.setEdgeGeometry(EdgeGeometry.reference);
    const st = this.engine.edgeAnticSettings;
    st.enabled = false;
    this.engine.edgeAnticSettings = st;
    this.engine.setAgentState('idle');
    for (let i = 0; i < 60; i++) this.engine.tick(1 / 60);
  }
  tick(dt = 1 / 120): FaceFrame { return this.engine.tick(dt); }
  /// Plays a screen-edge antic and returns once it has started.
  play(kind: OneShotKind, side = 1): void {
    this.engine.playEdgeAntic(kind, side);
    this.tick();
    expect(this.engine.state.activeOneShots.includes(kind), `${kind} did not start`).toBe(true);
  }
}

const shapeOf = (f: FaceFrame, side: 'left' | 'right'): PupilShape => FaceFrame.shape(f, side);

describe('PupilReactionsTests', () => {
  // MARK: Gates

  test('acceptedCuePlaysTheMappedShape', () => {
    const pairs: [ReactionCueKind, PupilShape][] = [['delight', PupilShape.star], ['affection', PupilShape.heart],
      ['reveal', PupilShape.exclaim], ['curiosity', PupilShape.question], ['success', PupilShape.exclaim],
      ['music', PupilShape.note]];
    for (const [kind, shape] of pairs) {
      const rig = makeRig();
      expect(send(rig, cue(kind)), kind).toBe('accepted');
      rig.run(0.8);   // inside every hold (exclamation marks: 0.3 + 0.6 s)
      expect(shapeOf(rig.frame, 'left') === shape || shapeOf(rig.frame, 'right') === shape, kind).toBe(true);
    }
  });

  test('confidenceThreshold', () => {
    const rig = makeRig();
    expect(send(rig, cue('delight', { confidence: 0.69 }))).toBe('lowConfidence');
    expect(send(rig, cue('delight', { confidence: NaN }))).toBe('lowConfidence');
    expect(send(rig, cue('delight', { confidence: 0.7 }))).toBe('accepted');
  });

  test('affectionAndMusicMustBeDirected', () => {
    const rig = makeRig();
    expect(send(rig, cue('affection', { directed: false }))).toBe('notDirected');
    expect(send(rig, cue('music', { directed: false }))).toBe('notDirected');
    expect(send(rig, cue('delight', { directed: false }))).toBe('accepted');
  });

  test('staleCuesAreIgnoredAndFutureOnesWaitForTheirMoment', () => {
    let rig = makeRig();
    expect(send(rig, cue('delight', { hostTime: rig.host - 1.6 }))).toBe('stale');
    expect(send(rig, cue('delight', { hostTime: rig.host - 1.2 }))).toBe('accepted');
    // A Pass B cue stamped with its sentence's audio start, 0.5 s ahead: held, then played at that moment.
    rig = makeRig('speaking');
    const at = rig.host + 0.5;
    expect(send(rig, cue('affection', { hostTime: at }))).toBe('waiting');
    let started: number | undefined;
    const r = rig;
    rig.run(1, undefined, () => {
      if (started === undefined && r.shapeActive) started = r.host;
    });
    expect(Math.abs((started ?? 0) - at), `started at ${started ?? -1}, audio at ${at}`).toBeLessThan(0.02);
    expect(rig.arbiter.lastDecision?.accepted).toBe(true);
  });

  test('passACueWhileThinkingIsNotCutBySpeaking', () => {
    const rig = makeRig('thinking');
    expect(send(rig, cue('delight'))).toBe('accepted');
    rig.run(0.6);
    rig.engine.setAgentState('speaking');
    rig.run(0.4);
    expect(shapeOf(rig.frame, 'left') === PupilShape.star && FaceFrame.morph(rig.frame, 'left') === 1).toBe(true);
  });

  test('listeningOnlyForConversationCuesAboutYanni', () => {
    const rig = makeRig('listening');
    // Past the perception window (a directed gesture early in listening is PerceptionPupilTests' case).
    rig.run(PupilReactions.perceptionListeningWindow);
    expect(send(rig, cue('delight', { source: 'perception' }))).toBe('notAboutYanni');
    expect(send(rig, cue('delight', { directed: false }))).toBe('notAboutYanni');
    expect(send(rig, cue('delight'))).toBe('accepted');
  });

  test('ownAudioNeverYieldsNotes', () => {
    let rig = makeRig('idle');
    rig.engine.setSpeechLevel(0.5);
    expect(send(rig, cue('music', { source: 'perception' }))).toBe('ownAudio');
    rig = makeRig('speaking');
    expect(send(rig, cue('music', { source: 'perception' }))).toBe('ownAudio');
  });

  test('emotionalContextWins', () => {
    // "My dog is sick": concern, never stars or hearts.
    let rig = makeRig();
    expect(send(rig, cue('delight', { valence: -0.15 }))).toBe('negativeContext');
    // A clearly negative appraisal opens the somber window for 60 s.
    rig = makeRig();
    expect(send(rig, cue('affection', { valence: -0.5 }))).toBe('negativeContext');
    expect(send(rig, cue('delight'))).toBe('somber');
    rig.run(59);
    expect(send(rig, cue('delight'))).toBe('somber');
    rig.run(1.2);
    expect(send(rig, cue('delight'))).toBe('accepted');
    // A sad mood suppresses playful shapes.
    rig = makeRig();
    rig.engine.setMood({ pleasure: -0.7, arousal: -0.2, dominance: -0.2 });
    rig.run(0.3);
    expect(send(rig, cue('music'))).toBe('negativeContext');
    // The emotion layer's bad news.
    rig = makeRig();
    rig.engine.markSomber();
    expect(send(rig, cue('curiosity'))).toBe('somber');
  });

  test('heartsBlockedWhileAnnoyed', () => {
    const rig = makeRig('idle');
    let taps = 0;
    while (rig.state.tapAnnoyance < TouchReactions.hmphThreshold && taps < 10) {
      rig.engine.send(FaceCommand.tap({ x: 0.2, y: 0 }));
      rig.run(0.1);
      taps += 1;
    }
    expect(rig.state.tapAnnoyance).toBeGreaterThanOrEqual(TouchReactions.hmphThreshold);
    expect(send(rig, cue('affection'))).toBe('annoyed');
  });

  test('slidingRepeatWindowByTopicKey', () => {
    const rig = makeRig('engaged', (s) => { s.globalCooldown = 10; s.star.cooldown = 0; });
    expect(send(rig, cue('delight', { key: 'delight:kid' }))).toBe('accepted');
    rig.run(50);
    expect(send(rig, cue('delight', { key: 'delight:kid' }))).toBe('repeatKey');
    rig.run(50);   // 100 s after the first sighting but only 50 s after the last: still a repeat
    expect(send(rig, cue('delight', { key: 'delight:kid' }))).toBe('repeatKey');
    rig.run(61);
    expect(['accepted', 'habituated']).toContain(send(rig, cue('delight', { key: 'delight:kid' })));
    expect(send(rig, cue('curiosity', { key: 'curiosity:other' }))).not.toBe('repeatKey');
  });

  test('cooldownsStackingAndRestartBlock', () => {
    const rig = makeRig();
    expect(send(rig, cue('delight'))).toBe('accepted');
    // No stacking.
    expect(send(rig, cue('curiosity'))).toBe('busy');
    rig.run(3);
    expect(send(rig, cue('curiosity'))).toBe('globalCooldown');
    rig.run(48);
    expect(send(rig, cue('delight'))).toBe('shapeCooldown');
    expect(['accepted', 'habituated']).toContain(send(rig, cue('curiosity')));
  });

  test('earlyEndBlocksRestartAndRefundsTheShapeCooldown', () => {
    const rig = makeRig('engaged', (s) => { s.globalCooldown = 10; });
    expect(send(rig, cue('delight'))).toBe('accepted');
    rig.run(0.6);
    rig.engine.send(FaceCommand.playOneShot('bigSurprise'));   // an urgent startle interrupts
    rig.run(0.3);
    expect(hasDefaultPupils(rig.frame)).toBe(true);
    expect(rig.arbiter.events.at(-1)?.what.kind, 'no interrupt logged').toBe('interrupted');
    rig.run(2);
    expect(send(rig, cue('delight'))).toBe('recentCancel');
    rig.run(9);
    // The global cooldown still applies (from the accept); the star's own 90 s was refunded.
    expect(['accepted', 'habituated']).toContain(send(rig, cue('delight')));
  });

  test('blockedStates', () => {
    let rig = makeRig();
    rig.engine.setBedtime(true);
    expect(send(rig, cue('delight'))).toBe('bedtime');
    for (const state of ['drowsy', 'asleep', 'notForMe', 'interrupted', 'sheepish', 'confused'] as AgentState[]) {
      rig = makeRig(state);
      expect(send(rig, cue('delight')), state).toBe('blockedState');
    }
    rig = makeRig('idle');
    let sulked = false;
    for (let i = 0; i < 12 && !sulked; i++) {
      rig.engine.send(FaceCommand.tap({ x: 0, y: 0 }));
      rig.run(0.05);
      sulked = rig.state.isSulking;
    }
    expect(sulked).toBe(true);
    expect(send(rig, cue('delight'))).toBe('sulking');
  });

  test('intensityZeroDisablesAndLowIntensityIsRarerAndShorter', () => {
    let rig = makeRig('engaged', (s) => { s.intensity = 0; });
    expect(send(rig, cue('delight'))).toBe('disabled');
    rig = makeRig('engaged', (s) => { s.enabled = false; });
    expect(send(rig, cue('delight'))).toBe('disabled');
    rig = makeRig('engaged', (s) => { s.star.enabled = false; });
    expect(send(rig, cue('delight'))).toBe('shapeDisabled');
    // Low intensity: longer cooldowns, shorter hold, no bounce, full size.
    const st = new PupilReactionSettings();
    st.intensity = 0.25;
    expect(st.cooldownScale > 2 && st.holdScale < 0.75 && st.acceptanceScale < 0.6).toBe(true);
    let accepted = false;
    for (let seed = 0; seed < 20 && !accepted; seed++) {
      rig = new ShapeRig(seed);
      const s = rig.engine.pupilReactionSettings;
      s.intensity = 0.25;
      rig.engine.pupilReactionSettings = s;
      accepted = send(rig, cue('delight')) === 'accepted';
    }
    expect(accepted).toBe(true);
    let t = 0, end: number | undefined;
    const r = rig;
    rig.run(3, undefined, () => {
      t += 1 / 120;
      if (end === undefined && !r.shapeActive) end = t;
    });
    const full = Shape.shapeDuration('starEyes', new PupilReactionSettings().star.hold);
    expect(end ?? 99, `low intensity hold not shorter: ${end ?? -1} vs ${full}`).toBeLessThan(full - 0.2);
  });

  test('habituationMakesRepeatsRarer', () => {
    const rig = makeRig('engaged', (s) => { s.globalCooldown = 10; s.star.cooldown = 0; s.repeatWindow = 0; });
    let accepted = 0, habituated = 0;
    for (let i = 0; i < 50; i++) {
      const r = send(rig, cue('delight'));
      if (r === 'accepted') accepted += 1;
      else if (r === 'habituated') habituated += 1;
      rig.run(11);
    }
    expect(habituated).toBeGreaterThan(0);
    expect(accepted >= 3 && accepted <= 14, `accepted ${accepted} of 50 in ~9 minutes`).toBe(true);
  });

  test('neverOverAnEdgeAnticOrIdleBeat', () => {
    const rig = new EdgeRig();
    rig.play('curiousLean');
    rig.engine.send(FaceCommand.reactionCue(cue('delight')));
    rig.tick();
    const arbiter = rig.engine.director.modifier('PupilReactions') as unknown as PupilReactions;
    const w = arbiter.events.at(-1)?.what;
    expect(w?.kind, 'no decision').toBe('decision');
    expect(w?.kind === 'decision' ? w.reason : undefined).toBe('otherActivity');
  });

  // MARK: Interrupts

  test('engagementAndListeningInterruptButThinkingToSpeakingDoesNot', () => {
    let rig = makeRig('idle');
    expect(send(rig, cue('delight'))).toBe('accepted');
    rig.run(0.8);
    rig.engine.setAgentState('engaged');
    rig.run(0.25);
    expect(hasDefaultPupils(rig.frame)).toBe(true);
    rig = makeRig('thinking');
    expect(send(rig, cue('affection'))).toBe('accepted');
    rig.run(1.0);
    rig.engine.setAgentState('speaking');
    rig.run(0.25);
    expect(shapeOf(rig.frame, 'left')).toBe(PupilShape.heart);
  });

  /// Random cue spam with random interrupts for ten simulated minutes: one transformation at a time, always back to
  /// the default pupils, never stuck, no non-finite values.
  test('randomCueSpamSoak', () => {
    const rig = new ShapeRig(99, 'idle');
    const rng = new SplitMix64(5);
    let shownFor = 0, maxShown = 0;
    const states: AgentState[] = ['idle', 'noticing', 'engaged', 'listening', 'thinking', 'speaking', 'followUp', 'notForMe'];
    let bad = 0, multiple = 0;
    for (let i = 0; i < 10 * 60 * 60; i++) {
      if (rng.chance(0.02)) {
        // Draws in Swift's argument order.
        const kind = ReactionCueKind.allCases[Math.floor(rng.unit() * 6) % 6];
        const confidence = rng.uniform(0.5, 1);
        const directedAtYanni = rng.chance(0.8);
        const valence = rng.uniform(-0.3, 0.9);
        const hostTime = rig.host - rng.uniform(0, 2);
        const key = `k${Math.floor(rng.unit() * 8)}`;
        rig.engine.send(FaceCommand.reactionCue(makeReactionCue(kind, confidence, { directedAtYanni, valence, hostTime, key })));
      }
      if (rng.chance(0.003)) rig.engine.setAgentState(states[Math.floor(rng.unit() * states.length) % states.length]);
      if (rng.chance(0.001)) rig.engine.playPupilShape(allShapes[Math.floor(rng.unit() * 5) % 5]);
      if (rng.chance(0.0005)) rig.engine.send(FaceCommand.tap({ x: 0, y: 0 }));
      const f = rig.tick(1 / 60);
      // Counted rather than expected per frame (36 000 frames).
      if (rig.state.activeOneShots.filter(isPupilShape).length > 1) multiple += 1;
      if (!Number.isFinite(f.pupilMorph.x) || !Number.isFinite(f.pupilShapeScale.x)) bad += 1;
      if (hasDefaultPupils(f)) shownFor = 0; else { shownFor += 1 / 60; maxShown = Math.max(maxShown, shownFor); }
    }
    expect(multiple).toBe(0);
    expect(bad).toBe(0);
    // The longest transformation (hold 1.5 s) plus a deferred retrigger and switch backs stays well under 8 s.
    expect(maxShown, `a transformation stayed for ${maxShown} s`).toBeLessThan(8);
    expect(rig.sampler.shapeWatchdogCount).toBe(0);
  });

  // MARK: Voice sync and settings

  test('vocalSyncLeavesTransformationPupilsAlone', () => {
    const pupilMin = (paired: OneShotKind | undefined): [number, number] => {
      const rig = new VocalRig(60);
      rig.cue(0.02, { duration: 0.3, kind: 'startle', paired });
      let m = 1, sc = 1;
      rig.run(0.8, () => { m = Math.min(m, rig.s.pupilSizeMul.x); sc = Math.max(sc, rig.s.eyeScaleMul.x); });
      return [m, sc];
    };
    expect(pupilMin(undefined)[0]).toBeLessThan(0.95);
    for (const k of allShapes) {
      const [m, sc] = pupilMin(k);
      expect(Math.abs(m - 1) < 1e-4 && Math.abs(sc - 1) < 1e-4, k).toBe(true);
    }
  });

  test('settingsRoundTripTolerantDecodingAndValidation', () => {
    const s = new PupilReactionSettings();
    s.intensity = 0.4;
    s.heart.hold = 1.1;
    s.question.enabled = false;
    s.moodAccent = false;
    s.reduceMotion = true;
    const data = JSON.stringify(s);
    const back = PupilReactionSettings.fromJSON(JSON.parse(data));
    expect(back.reduceMotion, 'Reduce Motion follows the system and is not persisted').toBe(false);
    back.reduceMotion = true;
    expect(back.equals(s)).toBe(true);
    // Older / partial saves keep defaults for missing keys; garbage values are ignored.
    const partial = '{"intensity": 0.5, "star": {"hold": 1.2}, "heart": "nonsense", "future": 3}';
    const p = PupilReactionSettings.fromJSON(JSON.parse(partial));
    expect(p.intensity === 0.5 && p.star.hold === 1.2 && p.star.cooldown === 90).toBe(true);
    expect(p.heart).toEqual(new PupilReactionSettings().heart);
    // Validation clamps.
    const bad = new PupilReactionSettings();
    bad.intensity = 3; bad.minConfidence = 0; bad.globalCooldown = NaN; bad.star.hold = 9;
    const v = bad.validated();
    expect(v.intensity === 1 && v.minConfidence === 0.3 && v.globalCooldown === 50 && v.star.hold === 1.5).toBe(true);
    const engine = new FaceEngine();
    engine.pupilReactionSettings = bad;
    expect(engine.pupilReactionSettings.equals(v)).toBe(true);
  });
});
