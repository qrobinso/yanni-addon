// Port of Tests/ConversationCoreTests/LookToTalkEndToEndTests.swift.
// Look-to-talk end to end: synthetic camera detections → the real perception processor and coordinator → the real
// face engine and life cycle → the conversation controller, on one manual clock (60 fps display, 15 fps camera).
import { describe, expect, test } from 'vitest';
import { conversationFace, conversationLife, conversationPerception } from '../../src/conversation/core/Adapters';
import { Backoff } from '../../src/conversation/core/Backoff';
import { ConversationController, type ConversationLogEntry } from '../../src/conversation/core/ConversationController';
import { isIdleGame } from '../../src/engine/OneShots';
import { FaceEngine } from '../../src/engine/FaceEngine';
import type { NoticingAttention } from '../../src/engine/modifiers/NoticingAttention';
import { LifeCycleController } from '../../src/life/LifeCycleController';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { PerceptionCoordinator, perceptionFace } from '../../src/perception/PerceptionCoordinator';
import { PerceptionProcessor } from '../../src/perception/PerceptionProcessor';
import { PerceptionSettings } from '../../src/perception/PerceptionSettings';
import { PerceptionEvent } from '../../src/perception/PerceptionTypes';
import { LookTarget, SyntheticPerson, SyntheticScene } from '../../src/perception/SyntheticScenes';
import { FakeConversationAudio, FakeVoiceTransport, ManualClock, testEndpoint } from './support/Fakes';
import { FakeVoice } from './support/Rig';
import { FakeTurnDetection } from './support/TurnFakes';

class LookToTalkRig {
  readonly clock = new ManualClock(1000);
  readonly engine = new FaceEngine();
  readonly life: LifeCycleController;
  readonly coordinator: PerceptionCoordinator;
  readonly transport = new FakeVoiceTransport();
  readonly audio = new FakeConversationAudio();
  readonly voice = new FakeVoice();
  readonly detector = new FakeTurnDetection();
  readonly controller: ConversationController;
  processor: PerceptionProcessor;
  readonly scene: SyntheticScene;
  nextFrame = 0;
  log: ConversationLogEntry[] = [];
  perceptionLog: string[] = [];
  static readonly dt = 1.0 / 60;

  constructor(scene: SyntheticScene) {
    scene.startTime = 1000;
    this.scene = scene;
    this.engine.setAgentState('idle');
    const c = this.clock;
    this.life = new LifeCycleController(this.engine, { store: null,
      clock: { monotonic: () => c.now, now: () => new Date((1_700_000_000 + c.now) * 1000) } });
    this.coordinator = new PerceptionCoordinator(perceptionFace(this.engine), this.life, undefined, () => c.now);
    this.coordinator.source = 'replay';
    this.processor = new PerceptionProcessor(undefined, new CameraGeometry(scene.intrinsics, scene.cameraOffset));
    this.controller = new ConversationController({
      face: conversationFace(this.engine), life: conversationLife(this.life), audio: this.audio, transport: this.transport,
      voice: this.voice, backoff: new Backoff({ random: () => 0.5 }), clock: c.fn,
    });
    this.controller.perception = conversationPerception(this.coordinator);
    this.controller.turn = this.detector;
    this.controller.settings.greetingEnabled = false;
    this.controller.onLog = (e) => this.log.push(e);
    this.coordinator.onEvent = (e, note) => this.perceptionLog.push(PerceptionEvent.name(e) + (note !== null ? ` → ${note}` : ''));
    this.transport.autoReady = true;
    this.controller.endpoint = testEndpoint();
    this.coordinator.lifeChanged();
  }

  /** One display frame: the camera frames due by now (analysed ≈ 30 ms after capture, then ingested), the engine, the
   *  life cycle, the conversation (the app's order). */
  frame(): void {
    this.clock.advance(LookToTalkRig.dt);
    const s = this.scene;
    const total = Math.round(s.duration * s.fps);
    while (this.nextFrame < total && s.startTime + this.nextFrame / s.fps <= this.clock.now) {
      const det = s.frame(this.nextFrame);
      det.time = this.clock.now - 0.03;
      const pre = this.processor.apply(this.coordinator.mailbox.drain());
      const out = this.processor.process(det);
      out.events = [...pre, ...out.events];
      this.coordinator.ingest(out, 'replay');
      this.nextFrame += 1;
    }
    this.engine.tick(LookToTalkRig.dt, this.clock.now);
    this.life.afterFrame(this.clock.now);
    this.controller.afterFrame(this.clock.now);
  }

  runUntil(limit: number, cond: () => boolean): number | null {
    const start = this.clock.now;
    while (this.clock.now - start < limit) {
      this.frame();
      if (cond()) return this.clock.now - start;
    }
    return null;
  }

  get micOpen(): boolean { return this.transport.micEnabled && this.audio.captureEnabled; }

  get transcript(): string {
    return this.log.map((e) => `${e.kind}: ${e.detail}`).join('\n')
      + '\n--- perception\n' + this.perceptionLog.slice(-20).join('\n')
      + `\nface ${this.engine.state.agentState} · phase ${this.controller.phase} · present ${this.life.isPresent}`;
  }
}

const noticing = (rig: LookToTalkRig): NoticingAttention =>
  rig.engine.director.modifier('NoticingAttention') as unknown as NoticingAttention;

/** Walks in from 2.6 m, stops at 1 m in front of Yanni and looks at its eyes. */
const walkUpAndLook = (): SyntheticScene => new SyntheticScene('walk-up-and-look', 12, [
  new SyntheticPerson({ path: [[0, -35, 2.6], [3, -4, 1.0]], looks: [[0, LookTarget.passing], [3, LookTarget.eyes]] }),
]);

describe('LookToTalkEndToEndTests', () => {
  test('walkUpStopAndLookOpensTheMic', () => {
    const rig = new LookToTalkRig(walkUpAndLook());
    rig.frame();
    // The app's perception model pushes its own (persisted) settings whenever they change: here the face view's
    // layout sets the drawn face radius. The dry run stays off.
    rig.coordinator.settings = rig.coordinator.settings.with({
      lookToTalkDryRun: new PerceptionSettings().lookToTalkDryRun, faceRadius: 0.12,
    });
    const t = rig.runUntil(10, () => rig.micOpen);
    expect(t, `mic never opened:\n${rig.transcript}`).not.toBeNull();
    expect(rig.controller.engagementTrigger).toBe('gaze');
    expect(rig.log.some((e) => e.kind === 'engaged' && e.detail.startsWith('gaze'))).toBe(true);
    expect(rig.log.some((e) => e.kind === 'gaze'), 'no engagement held back').toBe(false);
    // At 1 m and looking from 3 s: the dwell (1 s), then the unmute rule.
    if (t !== null) expect(t, `mic opened after ${t} s`).toBeLessThan(5.5);
  });

  /** Someone near Yanni for two minutes without facing it turns to look: the session comes back and the mic opens. */
  test('lookingAfterALongUnengagedStayReconnectsAndOpensTheMic', () => {
    const scene = new SyntheticScene('linger-then-look', 130, [
      new SyntheticPerson({ path: [[0, 8, 1.1]], looks: [[0, LookTarget.away(60)], [120, LookTarget.eyes]] }),
    ]);
    const rig = new LookToTalkRig(scene);
    rig.runUntil(119.5, () => false);
    expect(rig.log.some((e) => e.kind === 'session' && e.detail === 'disconnect'), 'dropped while nobody faced Yanni').toBe(true);
    expect(rig.controller.session).toBe('disconnected');
    const t = rig.runUntil(5, () => rig.micOpen);
    expect(t, `mic never opened:\n${rig.transcript}`).not.toBeNull();
    if (t !== null) expect(t, `mic opened ${t} s after the look`).toBeLessThan(2.5);
  });

  /** Someone lingering without facing Yanni long enough for it to get bored, then looking at it: the eyes are back on
   *  them at once and the mic opens after exactly the same dwell as with a constant stare. */
  test('lookingAtABoredYanniOpensTheMicWithinTheSameDwell', () => {
    const scene = (): SyntheticScene => new SyntheticScene('bored-then-look', 40, [
      new SyntheticPerson({ path: [[0, 8, 1.0]], looks: [[0, LookTarget.away(60)], [30, LookTarget.eyes]] }),
    ]);
    const run = (noticingAttention: boolean) => {
      const rig = new LookToTalkRig(scene());
      const na = noticing(rig);
      na.isEnabled = noticingAttention;
      let distracted = false;
      rig.runUntil(29.95, () => {
        distracted = distracted || na.interest === 'distracted';
        return false;
      });
      const start = rig.clock.now;
      let back: number | null = null;
      const mic = rig.runUntil(5, () => {
        if (back === null && na.interest === 'watching' && !na.ownsGaze) back = rig.clock.now - start;
        return rig.micOpen;
      });
      return { distracted, back: back as number | null, mic, transcript: rig.transcript };
    };
    const bored = run(true);
    const stare = run(false);
    expect(bored.distracted, 'Yanni got bored during the 30 s').toBe(true);
    expect(bored.back, `eyes never came back:\n${bored.transcript}`).not.toBeNull();
    if (bored.back !== null) expect(bored.back, `eyes back on them ${bored.back} s after the look`).toBeLessThan(0.4);
    expect(bored.mic !== null && stare.mic !== null, `mic never opened:\n${bored.transcript}`).toBe(true);
    if (bored.mic !== null && stare.mic !== null) {
      expect(Math.abs(bored.mic - stare.mic), `same dwell: ${bored.mic} s bored vs ${stare.mic} s staring`).toBeLessThan(0.05);
      expect(bored.mic).toBeLessThan(2.5);
    }
  });

  /** Someone lingering while Yanni plays an idle game, then looking at it: the game is cancelled at once, the eyes are
   *  back on them, and the mic opens after the same dwell as with a constant stare. */
  test('lookingMidGameCancelsTheGameAndOpensTheMicWithinTheSameDwell', () => {
    const scene = (): SyntheticScene => new SyntheticScene('game-then-look', 40, [
      new SyntheticPerson({ path: [[0, 8, 1.0]], looks: [[0, LookTarget.away(60)], [30, LookTarget.eyes]] }),
    ]);
    const run = (game: boolean) => {
      const rig = new LookToTalkRig(scene());
      const st = rig.engine.idleGameSettings;
      st.enabled = false;   // only the game started here
      rig.engine.idleGameSettings = st;
      rig.runUntil(28.5, () => false);
      if (game) rig.engine.playIdleGame('basketball');
      rig.runUntil(1.45, () => false);
      const playing = rig.engine.state.activeOneShots.some(isIdleGame);
      const start = rig.clock.now;
      let cancelled: number | null = null;
      const mic = rig.runUntil(5, () => {
        if (cancelled === null && !rig.engine.state.activeOneShots.some(isIdleGame)) cancelled = rig.clock.now - start;
        return rig.micOpen;
      });
      return { playing, cancelledIn: cancelled as number | null, mic, transcript: rig.transcript };
    };
    const played = run(true);
    const stare = run(false);
    expect(played.playing, 'the game was playing when they looked').toBe(true);
    if (played.cancelledIn !== null) expect(played.cancelledIn, `game cancelled ${played.cancelledIn} s after the look`).toBeLessThan(0.4);
    expect(played.cancelledIn).not.toBeNull();
    expect(played.mic !== null && stare.mic !== null, `mic never opened:\n${played.transcript}`).toBe(true);
    if (played.mic !== null && stare.mic !== null) {
      expect(Math.abs(played.mic - stare.mic), `same dwell: ${played.mic} s mid-game vs ${stare.mic} s without`).toBeLessThan(0.05);
    }
  });
});
