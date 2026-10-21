// Port of Tests/ConversationHomeTests/ProactiveDeliveryTests.swift.
// The real announcement queue (YanniHome's ProactiveCoordinator) delivering through the real controller (review H2).
import { describe, expect, test } from 'vitest';
import {
  AnnouncementQueue, type AnnouncementResult, type ProactiveContext,
} from '../../../src/conversation/announcements/AnnouncementQueue';
import { conversationFace } from '../../../src/conversation/core/Adapters';
import { Backoff } from '../../../src/conversation/core/Backoff';
import { ConversationController } from '../../../src/conversation/core/ConversationController';
import type { ConversationLife } from '../../../src/conversation/core/Ports';
import type { ProactiveRequest } from '../../../src/conversation/events/AgentIntents';
import type { AgentState } from '../../../src/engine/AgentState';
import { makePersonTarget } from '../../../src/engine/Commands';
import { FaceEngine } from '../../../src/engine/FaceEngine';
import { LifePhase } from '../../../src/life/LifeTypes';
import { CoordinatorAnnouncements, ConversationProactiveLink } from '../../../src/conversation/home/HomeAdapters';
import { FakeConversationAudio, FakeVoiceTransport, ManualClock, testEndpoint } from '../support/Fakes';
import { FakeTurnDetection } from '../support/TurnFakes';

class HomeLife implements ConversationLife {
  isPresent = false;
  isBedtime = false;
  isForceSleepActive = false;
  constructor(readonly face: FaceEngine) {}
  get phase(): LifePhase { return LifePhase.of(this.face.state.agentState); }
  noteActivity(): void {}
}

/** port-note: Swift's ManualScheduler (wall clock + timers) becomes the queue's `now` / `wallNow` on the manual clock. */
class DeliveryRig {
  readonly clock = new ManualClock();
  readonly engine = new FaceEngine();
  readonly transport = new FakeVoiceTransport();
  readonly audio = new FakeConversationAudio();
  readonly detector = new FakeTurnDetection();
  readonly life: HomeLife;
  readonly coordinator: AnnouncementQueue;
  readonly controller: ConversationController;
  readonly link: ConversationProactiveLink;
  results: AnnouncementResult[] = [];
  settingsOpen = false;
  static readonly dt = 1.0 / 60;

  constructor() {
    this.life = new HomeLife(this.engine);
    this.engine.setAgentState('idle');
    this.controller = new ConversationController({
      face: conversationFace(this.engine), life: this.life, audio: this.audio, transport: this.transport,
      backoff: new Backoff({ random: () => 0.5 }), clock: this.clock.fn,
    });
    this.link = new ConversationProactiveLink(this.controller);
    this.coordinator = new AnnouncementQueue({
      now: () => this.clock.now, wallNow: () => 1_700_000_000_000 + this.clock.now * 1000,
      setAgentState: (s) => this.engine.setAgentState(s), conversation: this.link,
      onResult: (r) => this.results.push(r),
    });
    this.controller.announcements = new CoordinatorAnnouncements(this.coordinator);
    this.controller.turn = this.detector;
    this.transport.autoReady = true;
    this.controller.endpoint = testEndpoint();
  }

  get state(): AgentState { return this.engine.state.agentState; }

  frame(): void {
    this.clock.advance(DeliveryRig.dt);
    this.engine.tick(DeliveryRig.dt, this.clock.now);
    this.controller.afterFrame(this.clock.now);
    const ctx: ProactiveContext = {
      agentState: this.engine.state.agentState, lifePhase: this.life.phase, isBedtime: false, isForceSleep: false,
      personPresent: this.life.isPresent, eyeContact: this.engine.state.engagedPersonID !== null, quietMode: false,
      settingsOpen: this.settingsOpen,
    };
    this.coordinator.update(ctx);
  }

  run(s: number): void { for (let i = 0; i < Math.round(s / DeliveryRig.dt); i++) this.frame(); }

  runUntil(limit: number, cond: () => boolean): boolean {
    const start = this.clock.now;
    while (this.clock.now - start < limit) { this.frame(); if (cond()) return true; }
    return false;
  }

  announce(id: string, priority: 'normal' | 'high' = 'normal'): void {
    const wall = 1_700_000_000_000 + this.clock.now * 1000;
    this.coordinator.enqueue({ id, text: `text ${id}`, context: {}, priority, receivedAt: wall, expiresAt: wall + 3_600_000,
      state: 'pending', interruptions: 0, lastAttemptUnavailable: false });
  }

  arrive(engaged: boolean): void {
    this.engine.setPeople([makePersonTarget(1, { x: 0, y: 0 })], 1, engaged ? 1 : null);
    this.life.isPresent = true;
  }

  get proactives(): ProactiveRequest[] {
    return this.transport.sent.flatMap((i) => (i.kind === 'proactive' ? [i.payload] : []));
  }

  /** The transport side of a proactive turn: turn-started, audio, reply-end, proactive-done; then the reply plays. */
  agentSpeaks(turn: string, ids: string[]): void {
    this.transport.agent({ kind: 'turnStarted', payload: { turnId: turn, kind: 'proactive', ids } });
    this.frame();
    this.audio.startReply(this.clock.now);
    this.frame();
    for (let i = 0; i < 30; i++) { this.audio.play(DeliveryRig.dt, this.clock.now + DeliveryRig.dt, true); this.frame(); }
    this.transport.agent({ kind: 'replyEnd', payload: { turnId: turn, sentences: 1, audioMs: 500 } });
    this.transport.agent({ kind: 'proactiveDone', payload: { turnId: turn, ids, status: 'spoken' } });
  }
}

describe('ProactiveDeliveryTests', () => {
  test('engagementPullsTheBatchAndASpokenReplyDelivers', () => {
    const rig = new DeliveryRig();
    rig.announce('laundry');
    rig.arrive(false);
    rig.run(0.5);
    expect(rig.state).toBe('hasMessage');
    rig.arrive(true);
    expect(rig.runUntil(2, () => rig.proactives.length > 0)).toBe(true);
    expect(rig.state, 'the proactive turn opens instead of waiting for speech').toBe('thinking');
    const p = rig.proactives[0];
    expect(p.ids).toEqual(['laundry']);
    expect(p.items).toEqual([{ kind: 'announcement', text: 'text laundry', context: {} }]);
    expect(p.audience).toEqual({ people: 1, engaged: true });
    expect(rig.transport.micEnabled, 'barge-in stays possible').toBe(true);
    rig.agentSpeaks('p1', ['laundry']);
    expect(rig.results, 'spoken only once the playout drains').toEqual([]);
    expect(rig.runUntil(1, () => rig.state === 'followUp')).toBe(true);
    expect(rig.results).toEqual([{ id: 'laundry', outcome: 'delivered' }]);
    expect(rig.coordinator.items).toEqual([]);
  });

  test('bargeInRequeuesOnceThenCountsAsPartial', () => {
    const rig = new DeliveryRig();
    rig.announce('door');
    rig.arrive(true);
    expect(rig.runUntil(2, () => rig.proactives.length > 0)).toBe(true);
    rig.transport.agent({ kind: 'turnStarted', payload: { turnId: 'p1', kind: 'proactive', ids: ['door'] } });
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    expect(rig.state).toBe('speaking');
    rig.detector.speechStarted(rig.clock.now - 0.08);
    expect(rig.state).toBe('interrupted');
    expect(rig.coordinator.items[0]?.interruptions).toBe(1);
    expect(rig.coordinator.items[0]?.state).toBe('pending');
    expect(rig.results).toEqual([]);
  });

  test('voiceServicesUnavailableKeepsTheMessageQueued', () => {
    const rig = new DeliveryRig();
    rig.transport.autoReady = false;
    rig.announce('door');
    rig.arrive(true);
    rig.run(3.2);
    expect(rig.state).toBe('sheepish');
    expect(rig.coordinator.items[0]?.lastAttemptUnavailable).toBe(true);
    expect(rig.coordinator.inFlight ?? null).toBeNull();
  });

  test('transportReportedUnavailableGoesSheepish', () => {
    const rig = new DeliveryRig();
    rig.announce('door');
    rig.arrive(true);
    expect(rig.runUntil(2, () => rig.proactives.length > 0)).toBe(true);
    rig.transport.agent({ kind: 'proactiveDone', payload: { turnId: null, ids: ['door'], status: 'unavailable' } });
    expect(rig.state).toBe('sheepish');
    expect(rig.coordinator.items[0]?.lastAttemptUnavailable).toBe(true);
  });

  test('followUpEndStillEngagedDeliversWhatArrivedMeanwhile', () => {
    const rig = new DeliveryRig();
    rig.arrive(true);
    expect(rig.runUntil(2, () => rig.state === 'listening')).toBe(true);
    rig.detector.speechStarted(rig.clock.now - 0.08);
    rig.detector.turnEnded(rig.clock.now - 0.2, rig.clock.now);
    rig.transport.agent({ kind: 'turnEnded', payload: { turnId: 't1', transcriptChars: 4 } });
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 200 } });
    rig.audio.play(0.2, rig.clock.now, true);
    expect(rig.runUntil(1, () => rig.state === 'followUp')).toBe(true);
    rig.announce('oven');
    rig.run(6.1);
    expect(rig.proactives.map((p) => p.ids), 'oh, and… (review H2)').toEqual([['oven']]);
    expect(rig.state).toBe('thinking');
  });

  test('highPriorityAsksForATurnWithoutEyeContact', () => {
    const rig = new DeliveryRig();
    rig.arrive(false);
    rig.run(0.5);
    rig.announce('smoke', 'high');
    expect(rig.runUntil(3, () => rig.proactives.length > 0)).toBe(true);
    expect(rig.proactives[0]?.audience).toEqual({ people: 1, engaged: false });
  });

  test('settingsOpenSuppressesLookToTalkAndDelivery', () => {
    const rig = new DeliveryRig();
    rig.announce('door');
    rig.settingsOpen = true;
    rig.frame();
    expect(rig.controller.isSuppressed, 'the coordinator pushes settings-open through the link').toBe(true);
    rig.arrive(true);
    rig.run(2);
    expect(rig.proactives).toEqual([]);
    expect(rig.controller.phase).toBe('idle');
    rig.settingsOpen = false;
    expect(rig.runUntil(2, () => rig.proactives.length > 0)).toBe(true);
  });

  test('outcomesMapOneToOne', () => {
    expect(CoordinatorAnnouncements.result('spoken')).toBe('spoken');
    expect(CoordinatorAnnouncements.result('interrupted')).toBe('interrupted');
    expect(CoordinatorAnnouncements.result('unavailable')).toBe('unavailable');
    expect(CoordinatorAnnouncements.result('cancelled')).toBe('cancelled');
  });
});
