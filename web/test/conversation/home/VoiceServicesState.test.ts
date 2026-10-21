// Port of Tests/ConversationHomeTests/VoiceServicesStateTests.swift.
// The Home Assistant voice services diagnostic from the live controller status (design §13.4).
import { describe, expect, test } from 'vitest';
import { conversationFace } from '../../../src/conversation/core/Adapters';
import { Backoff } from '../../../src/conversation/core/Backoff';
import { ConversationController } from '../../../src/conversation/core/ConversationController';
import type { ConversationLife } from '../../../src/conversation/core/Ports';
import { voiceServicesState } from '../../../src/conversation/home/VoiceServicesState';
import { FaceEngine } from '../../../src/engine/FaceEngine';
import { LifePhase } from '../../../src/life/LifeTypes';
import { FakeConversationAudio, FakeVoiceTransport, ManualClock, testEndpoint } from '../support/Fakes';

class PresenceLife implements ConversationLife {
  isPresent = false;
  isBedtime = false;
  isForceSleepActive = false;
  constructor(readonly face: FaceEngine) {}
  get phase(): LifePhase { return LifePhase.of(this.face.state.agentState); }
  noteActivity(): void {}
}

describe('VoiceServicesStateTests', () => {
  test('sensorFollowsTheSession', () => {
    const clock = new ManualClock();
    const engine = new FaceEngine();
    engine.setAgentState('idle');
    const life = new PresenceLife(engine);
    const transport = new FakeVoiceTransport();
    const c = new ConversationController({ face: conversationFace(engine), life, audio: new FakeConversationAudio(), transport,
      backoff: new Backoff({ random: () => 0.5 }), clock: clock.fn });
    const frame = (): void => {
      clock.advance(1.0 / 60);
      engine.tick(1.0 / 60, clock.now);
      c.afterFrame(clock.now);
    };
    const sensor = () => voiceServicesState(c.status);

    frame();
    expect(sensor(), 'not set up: dormant').toBe('not_configured');
    expect(transport.connects, 'not set up: no connect attempts').toEqual([]);

    c.endpoint = testEndpoint();
    frame();
    expect(sensor(), 'set up, nobody around: connects when someone comes').toBe('connected');
    expect(transport.connects).toEqual([]);

    life.isPresent = true;
    frame();
    expect(sensor()).toBe('connected');
    expect(transport.connects.length).toBe(1);
    transport.becomeReady();
    frame();
    expect(sensor()).toBe('connected');

    transport.fail();
    frame();
    expect(sensor(), 'a drop while wanted is unreachable until it reconnects').toBe('unreachable');

    expect(voiceServicesState(c.status, true), 'Home Assistant up but speech recognition, the speech voice or Jev down')
      .toBe('degraded');

    c.endpoint = null;
    frame();
    expect(sensor()).toBe('not_configured');
  });
});
