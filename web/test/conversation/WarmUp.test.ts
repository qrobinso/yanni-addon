// Port of Tests/ConversationCoreTests/WarmUpTests.swift.
// Getting ready to listen without a wait: the touch-down warm-up, the asynchronous audio switch, the mic opening as
// soon as everything is ready, the glow rising meanwhile, the gaze warm-up, and "Start listening when I make eye
// contact".
import { describe, expect, test } from 'vitest';
import { makePersonTarget } from '../../src/engine/Commands';
import { dryRun } from './support/Fakes';
import { Rig } from './support/Rig';

describe('WarmUpTests', () => {
  test('touchDownStartsTheConnectAndTheAudioSwitchAtOnce', () => {
    const rig = new Rig({ autoReady: false });
    rig.run(1);   // nobody here: cold
    expect(rig.controller.session).toBe('disconnected');
    expect(rig.audio.conversationMode).toBe(false);
    rig.controller.warmUp();
    // No frame needed: both start inside the call.
    expect(rig.transport.connects.length).toBe(1);
    expect(rig.audio.conversationMode).toBe(true);
    expect(rig.audio.modeChanges[rig.audio.modeChanges.length - 1]).toBe(true);
    expect(rig.phase === 'idle' && rig.state === 'idle', 'a press alone never engages').toBe(true);
  });

  test('aTapAfterTheWarmUpDoesntEngageAndTheWarmUpIdlesOut', () => {
    const rig = new Rig();
    rig.run(rig.controller.timings.absentDisconnect + 1);   // nobody around for a while
    rig.controller.warmUp();   // touch-down…
    rig.run(0.15);             // …and up: a tap (the face pokes; the controller does nothing)
    expect(rig.controller.session).toBe('ready');
    expect(rig.phase).toBe('idle');
    expect(rig.engages).toEqual([]);
    expect(rig.transport.micEnabled).toBe(false);
    rig.run(rig.controller.timings.warmUpLinger - 1);
    expect(rig.controller.session, "pokes in a row don't churn the session or the audio").toBe('ready');
    rig.run(1.5);
    expect(rig.controller.session).toBe('disconnected');
    expect(rig.audio.conversationMode, 'the audio mode holds a while, so the next press finds it ready').toBe(true);
    rig.run(rig.controller.timings.audioModeHold);
    expect(rig.audio.conversationMode).toBe(false);
    expect(rig.audio.modeChanges.filter((m) => m).length).toBe(1);
  });

  test('aHoldAfterTheWarmUpOpensTheMicByTheChirpRuleAlone', () => {
    const rig = new Rig({ autoReady: false });
    rig.controller.settings.greetingEnabled = false;
    rig.run(1);
    rig.controller.warmUp();
    rig.run(0.2);
    rig.transport.becomeReady();   // the connect finished during the hold
    rig.run(0.3);                  // the hold is recognised at 0.5 s
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    const engagedAt = rig.clock.now;
    rig.voice.audibleUntilHostTime = engagedAt + 0.3;   // the engaged chirp
    const opened = rig.runUntil(2, () => rig.transport.micEnabled);
    expect(opened).not.toBeNull();
    expect(rig.clock.now).toBeGreaterThanOrEqual(engagedAt + 0.3 + rig.controller.timings.unmuteAfterAudible - 1e-9);
    expect(opened!, `nothing else to wait for (${opened} s)`).toBeLessThan(0.45);
  });

  test('theAudioSwitchIsAsynchronousAndTheMicWaitsOnlyForIt', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.audio.switchesLater = true;
    rig.run(1);
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.state, 'the face acknowledges at once, whatever the audio is doing').toBe('engaged');
    expect(rig.audio.conversationMode && !rig.audio.isAudioReady).toBe(true);
    rig.run(1);
    expect(rig.controller.session).toBe('ready');
    expect(rig.transport.micEnabled || rig.audio.captureEnabled, 'never before the audio is live').toBe(false);
    expect(rig.phase).toBe('engaged');
    rig.audio.finishSwitch();
    rig.frame();
    expect(rig.transport.micEnabled && rig.audio.captureEnabled, 'the next frame once everything is ready').toBe(true);
    expect(rig.phase).toBe('listening');
  });

  test('anAudioSwitchThatNeverFinishesEndsSheepish', () => {
    const rig = new Rig();
    rig.audio.switchesLater = true;
    rig.run(1);
    rig.controller.engageManually();
    rig.run(rig.controller.timings.engagedConnectTimeout + 0.1);
    expect(rig.log.some((e) => e.kind === 'engaged' && e.detail === 'audio not ready')).toBe(true);
    expect(rig.log.some((e) => e.kind === 'state' && e.detail === 'sheepish')).toBe(true);
    expect(rig.transport.micEnabled || rig.audio.captureEnabled).toBe(false);
    expect(rig.engine.state.glowTarget).toBe(0);
  });

  test('theGlowRisesAtEngagementAndIsFullWhenTheMicOpens', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.audio.switchesLater = true;
    rig.run(1);
    rig.controller.engageManually();
    expect(rig.engine.state.glowTarget).toBe(rig.controller.timings.getReadyGlow);
    rig.run(0.5);
    expect(rig.engine.state.glowTarget, 'getting ready to listen').toBe(rig.controller.timings.getReadyGlow);
    rig.audio.finishSwitch();
    expect(rig.runUntil(1, () => rig.controller.micOpen)).not.toBeNull();
    expect(rig.engine.state.glowTarget).toBe(1);
  });

  test('facingWarmsUpBeforePresenceIsConfirmed', () => {
    const rig = new Rig({ autoReady: false });
    rig.run(1);
    rig.engine.setPeople([makePersonTarget(1, { x: 0, y: 0 })], 1, null);
    rig.frame();   // presence not yet debounced (life.isPresent false)
    expect(rig.transport.connects.length).toBe(1);
    expect(rig.audio.conversationMode).toBe(true);
  });

  test('eyeContactOffNeverEngagesByGazeButHoldToTalkStillDoes', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.controller.settings.listenOnEyeContact = false;
    rig.person(1, { engaged: true });
    rig.run(2);
    expect(rig.phase).toBe('idle');
    expect(rig.engages).toEqual([]);
    expect(rig.transport.micEnabled).toBe(false);
    const calls = rig.perception.calls;
    expect(calls[calls.length - 1], 'the engaged look without the mic').toEqual(dryRun(true));
    expect(rig.log.some((e) => e.detail.includes("eye contact doesn't start listening"))).toBe(true);
    rig.engine.setAgentState('engaged');   // the dry run's look
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    const after = rig.perception.calls;
    expect(after[after.length - 1], 'handed over before the engaged state is written').toEqual(dryRun(false));
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.transport.micEnabled).toBe(true);
  });

  test('eyeContactOnEngagesByGaze', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    expect(rig.controller.settings.listenOnEyeContact).toBe(true);
    rig.person(1);
    rig.run(0.3);
    const before = rig.perception.calls.length;
    rig.person(1, { engaged: true });
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.controller.engagementTrigger).toBe('gaze');
    expect(rig.perception.calls.slice(before)).not.toContainEqual(dryRun(true));
  });
});
