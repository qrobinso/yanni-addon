// Port of Tests/FacePerceptionTests/EngagementHoldTests.swift: gestures don't steal the turn (design §7). Golden
// replay of someone at 1 m who looks at Yanni and makes heart hands, through the real processor and coordinator with
// a fake conversation controller.
import { describe, expect, test } from 'vitest';
import { EngagementManager } from '../../src/perception/Engagement';
import { PerceptionSettings } from '../../src/perception/PerceptionSettings';
import { PerceptionEvent } from '../../src/perception/PerceptionTypes';
import { LookTarget, SyntheticGesture, SyntheticPerson, SyntheticScene, SyntheticScenes } from '../../src/perception/SyntheticScenes';
import { PipelineRig } from './TestSupport';

/// Stands in for the conversation loop: engaged → listening on the next frame; on release reports "no speech".
class FakeConversation {
  listeningAt: number | null = null;
  constructor(readonly rig: PipelineRig) {}
  afterFrame(): void {
    const rig = this.rig;
    for (const { frame, event: e } of rig.events) {
      if (frame !== rig.frame - 1) continue;
      if (e.kind === 'engaged') {
        rig.face.setAgentState('engaged');
        rig.coordinator.pinTurn(e.id);
      } else if (e.kind === 'disengaged') {
        rig.coordinator.noteEngagementOutcome(e.id, false);
        rig.face.setAgentState('noticing');
      }
    }
    if (rig.face.agentState === 'engaged' && this.listeningAt === null &&
      rig.events.some((x) => PerceptionEvent.name(x.event) === 'engaged' && x.frame < rig.frame - 1)) {
      rig.face.setAgentState('listening');
      this.listeningAt = rig.frame;
    }
  }
}

function play(scene: SyntheticScene): [PipelineRig, FakeConversation] {
  const s = new PerceptionSettings({ lookToTalkDryRun: false });
  const rig = new PipelineRig({ settings: s, cameraOffset: scene.cameraOffset });
  const conv = new FakeConversation(rig);
  for (const f of scene.recording().frames) {
    rig.play(f);
    conv.afterFrame();
  }
  return [rig, conv];
}

const firstNamed = (rig: PipelineRig, name: string) => rig.events.find((e) => PerceptionEvent.name(e.event) === name);

describe('EngagementHoldTests', () => {
  test('heartHandsPlayFirstThenLookToTalkEngages', () => {
    const [rig, conv] = play(SyntheticScenes.heartHandsAtOneMetre);
    const h = firstNamed(rig, 'gesture.heartHands');
    const e = firstNamed(rig, 'engaged');
    expect(h !== undefined && e !== undefined).toBe(true);
    if (h === undefined || e === undefined) return;
    expect(h.frame, `the beat first (heart ${h.frame}, engaged ${e.frame})`).toBeLessThan(e.frame);
    expect(rig.face.cues[0]?.kind, 'heart eyes asked for').toBe('affection');
    const heldFor = (e.frame - h.frame) / 15;
    expect(heldFor, `engagement within the 1.5 s cap (${heldFor} s)`).toBeLessThanOrEqual(1.5 + 0.15);
    expect(conv.listeningAt, 'listening starts as usual').not.toBeNull();
    expect(rig.processor.engagement.isGestureStarted(1), 'a gesture-started engagement').toBe(true);
  });

  test('gestureStartedEngagementIsNeverAFalseEngagement', () => {
    const [rig] = play(SyntheticScenes.heartHandsAtOneMetre);
    rig.coordinator.noteEngagementOutcome(1, false);
    rig.coordinator.noteEngagementOutcome(1, false);
    rig.processor.apply(rig.coordinator.mailbox.drain());
    // The first "no speech" outcome belongs to the gesture-started engagement: not counted; one more alone can't damp.
    expect(rig.processor.engagement.isDamped(1)).toBe(false);
    expect(rig.processor.engagement.falseEngagements.length).toBe(1);
  });

  test('aCandidateThatBreaksOffReleasesTheHoldAtOnce', () => {
    // Heart hands for 0.3 s (shorter than the 0.4 s hold): no gesture, and engagement isn't kept waiting long.
    const s = new SyntheticScene('heart-broken', 5, [
      new SyntheticPerson({ path: [[0, 0, 1]], looks: [[0, LookTarget.away(40)], [0.5, LookTarget.eyes]],
        gestures: [[1.2, 1.75, SyntheticGesture.heartHands, 'right']] }),
    ]);
    const [rig] = play(s);
    expect(rig.events.some((e) => PerceptionEvent.name(e.event) === 'gesture.heartHands')).toBe(false);
    const [plain] = play(new SyntheticScene('look', 5, [
      new SyntheticPerson({ path: [[0, 0, 1]], looks: [[0, LookTarget.away(40)], [0.5, LookTarget.eyes]] }),
    ]));
    const held = firstNamed(rig, 'engaged')?.frame ?? 999;
    const free = firstNamed(plain, 'engaged')?.frame ?? 0;
    expect(held - free, `released when the candidate broke off (held ${held}, unheld ${free})`).toBeLessThanOrEqual(8);
  });

  test('aReleasedHoldNoLongerHolds', () => {
    const e = new EngagementManager();
    e.holdForGesture(3, 10, true);
    e.releaseGestureHold(3);
    expect(e.isHeld(3, false)).toBe(false);
  });
});
