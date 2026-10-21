// Port of Tests/ConversationCoreTests/ExpressiveDecisionsTests.swift.
// The perception → decision bridge (expressive decisions design §3–§5, §9) with a fake clock and a fake Jev.
import { describe, expect, test } from 'vitest';
import {
  ExpressiveDecisions, makeExpressiveContext, makeExpressivePerson, type ExpressiveContext, type ExpressivePerson,
} from '../../src/conversation/core/ExpressiveDecisions';
import {
  normalizedFeatures, type ExpressiveAskResult, type ExpressiveFeatures,
} from '../../src/conversation/events/ExpressiveEvents';
import { GestureKind, makeGestureObservation } from '../../src/perception/PerceptionTypes';

class FakeJev {
  hold = false;
  answer: ExpressiveAskResult = { kind: 'answered', answers: { react: { delight: 0.8 } }, roundTripMs: 300 };
  received: ExpressiveFeatures[] = [];
  private waiting: ((r: ExpressiveAskResult) => void)[] = [];
  handle(f: ExpressiveFeatures): Promise<ExpressiveAskResult> {
    this.received.push(f);
    if (!this.hold) return Promise.resolve(this.answer);
    return new Promise((r) => this.waiting.push(r));
  }
  release(r: ExpressiveAskResult | null = null): void { for (const w of this.waiting) w(r ?? this.answer); this.waiting = []; }
}

const people: ExpressivePerson[] = [makeExpressivePerson(3, { distance: 0.8, facing: 0.9, lookingAtMe: 0.7, dwell: 12 })];

class Rig {
  now = 1000;
  ctx: ExpressiveContext = makeExpressiveContext({ agentState: 'noticing' });
  readonly jev = new FakeJev();
  readonly bridge: ExpressiveDecisions;
  applied: string[] = [];
  plays = true;
  constructor() {
    this.bridge = new ExpressiveDecisions(() => this.now);
    this.bridge.ask = (f) => this.jev.handle(f);
    this.bridge.context = () => this.ctx;
    this.bridge.onAnswer = (key) => {
      this.applied.push(key);
      return this.plays ? 'delight 0.80' : null;
    };
  }
  async settle(): Promise<void> { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  gesture(k: GestureKind, o: { person?: number; note?: string | null; directed?: boolean } = {}): void {
    const g = makeGestureObservation({ kind: k, personID: o.person ?? 3, hand: null, confidence: 0.876,
      directedAtYanni: o.directed ?? true, at: { x: 0, y: 0 }, distance: 0.8, time: this.now });
    this.bridge.note({ kind: 'gesture', gesture: g }, o.note ?? null, people);
  }
}

const G = GestureKind;

describe('ExpressiveDecisionsTests', () => {
  test('aTimelyAnswerPlaysWithOnlyTheDocumentedFeatures', async () => {
    const r = new Rig();
    r.gesture(G.wave);
    await r.settle();
    expect(r.applied).toEqual(['gesture:wave']);
    expect(r.bridge.counts.asked).toBe(1);
    expect(r.bridge.counts.applied).toBe(1);
    expect(r.bridge.lastDecision).toBe('gesture:wave · 300 ms · delight 0.80');
    const f = r.jev.received[0];
    expect(f).toBeDefined();
    expect(f.event).toBe('gesture');
    expect(f.gesture).toBe('wave');
    expect(Math.abs((f.confidence ?? 0) - 0.876)).toBeLessThan(1e-6);
    expect([f.distance, f.facing, f.eyeContact, f.people]).toEqual(['near', true, true, 1]);
    expect([f.state, f.timeOfDay, f.bedtime]).toEqual(['noticing', 'afternoon', false]);
    expect(normalizedFeatures(f).confidence).toBe(0.88);
  });

  test('aLateAnswerIsDropped', async () => {
    const r = new Rig();
    r.jev.hold = true;
    r.gesture(G.heartHands);
    await r.settle();
    r.now += 1.0;
    r.jev.release();
    await r.settle();
    expect(r.applied).toEqual([]);
    expect(r.bridge.counts.late).toBe(1);
    expect(r.bridge.counts.applied).toBe(0);
  });

  test('anAnswerJustInsideTheDeadlinePlays', async () => {
    const r = new Rig();
    r.jev.hold = true;
    r.gesture(G.clap);
    await r.settle();
    r.now += 0.85;
    r.jev.release();
    await r.settle();
    expect(r.applied).toEqual(['gesture:clap']);
  });

  test('thePersonLeavingCancels', async () => {
    const r = new Rig();
    r.jev.hold = true;
    r.gesture(G.thumbsUp);
    await r.settle();
    expect(r.bridge.isAsking).toBe(true);
    r.bridge.note({ kind: 'personOutOfView', id: 3, lastPosition: { x: 0, y: 0 }, distance: 1, exitEdge: null }, null, []);
    expect(r.bridge.isAsking).toBe(false);
    expect(r.bridge.counts.cancelled).toBe(1);
    r.jev.release();
    await r.settle();
    expect(r.applied).toEqual([]);
  });

  test('aTurnOpeningCancelsButNotTheDeliveryFace', async () => {
    const r = new Rig();
    r.jev.hold = true;
    r.gesture(G.peace);
    await r.settle();
    r.ctx.agentState = 'listening';
    r.bridge.tick(people);
    expect(r.bridge.counts.cancelled).toBe(1);
    r.jev.release();
    await r.settle();
    r.now += 10;
    r.ctx.agentState = 'speaking';
    r.bridge.noteAnnouncement('high');
    await r.settle();
    r.bridge.tick([]);
    expect(r.bridge.counts.cancelled).toBe(1);
    expect(r.bridge.isAsking).toBe(true);
    const last = r.jev.received[r.jev.received.length - 1];
    expect(last?.priority).toBe('high');
    expect(last?.event).toBe('announcement');
  });

  test('rateLimitsAndBurst', async () => {
    const r = new Rig();
    r.gesture(G.clap); await r.settle();               // t 0: asked
    r.now += 1; r.gesture(G.wave); await r.settle();   // spacing
    expect(r.bridge.counts.rateLimited).toBe(1);
    r.now += 4; r.gesture(G.thumbsUp); await r.settle();   // t 5
    r.now += 5; r.gesture(G.peace); await r.settle();      // t 10
    r.now += 5; r.gesture(G.heartHands); await r.settle(); // t 15: 3 within 20 s
    expect(r.bridge.counts.asked).toBe(3);
    expect(r.bridge.counts.rateLimited).toBe(2);
    r.now += 10; r.gesture(G.armsUp); await r.settle();    // t 25
    expect(r.bridge.counts.asked).toBe(4);
  });

  test('perMinuteLimit', async () => {
    const r = new Rig();
    r.bridge.budget.minSpacing = 0;
    r.bridge.budget.burst = 100;
    for (let i = 0; i < 10; i++) { r.now += 5; r.gesture(i % 2 === 0 ? G.clap : G.wave); await r.settle(); }
    // 0…45 s: 8 asks in the minute, then rate-limited (the same key within 6 s never repeats here).
    expect(r.bridge.counts.asked).toBe(8);
    expect(r.bridge.counts.rateLimited).toBe(2);
  });

  test('repeatsCoalesce', async () => {
    const r = new Rig();
    r.gesture(G.wave); await r.settle();
    r.now += 4.5; r.gesture(G.wave); await r.settle();   // past the spacing, inside the coalesce window
    expect(r.bridge.counts.coalesced).toBe(1);
    r.jev.hold = true;
    r.now += 10; r.gesture(G.clap); await r.settle();
    r.now += 0.1; r.gesture(G.peace); await r.settle();   // one in flight
    expect(r.bridge.counts.coalesced).toBe(2);
    expect(r.bridge.counts.asked).toBe(2);
    r.jev.release();
    await r.settle();
  });

  test('hourlyBudgetAndDailyCap', async () => {
    const r = new Rig();
    r.bridge.budget.perHour = 2;
    for (const k of [G.clap, G.wave, G.peace]) { r.now += 30; r.gesture(k); await r.settle(); }
    expect(r.bridge.counts.asked).toBe(2);
    expect(r.bridge.counts.capped).toBe(1);
    const d = new Rig();
    d.bridge.budget.dailyCap = 2;
    for (const k of [G.clap, G.wave, G.peace]) { d.now += 30; d.gesture(k); await d.settle(); }
    expect(d.bridge.counts.asked).toBe(2);
    expect(d.bridge.counts.capped).toBe(1);
    const off = new Rig();
    off.bridge.budget.perHour = 0;
    off.gesture(G.clap);
    expect(off.jev.received).toEqual([]);
    expect(off.bridge.counts.skipped).toBe(1);
  });

  test('noJevOrBreakerMeansReflexOnly', async () => {
    const r = new Rig();
    r.ctx.jevAvailable = false;
    r.gesture(G.wave);
    r.bridge.ask = null;
    r.now += 10; r.ctx.jevAvailable = true; r.gesture(G.clap);
    await r.settle();
    expect(r.jev.received).toEqual([]);
    expect(r.bridge.counts.skipped).toBe(2);
    const b = new Rig();
    b.jev.answer = { kind: 'breakerOpen' };
    b.gesture(G.wave);
    await b.settle();
    expect(b.applied).toEqual([]);
    expect(b.bridge.counts.skipped).toBe(1);
    b.jev.answer = { kind: 'failed' };
    b.now += 10; b.gesture(G.clap);
    await b.settle();
    expect(b.applied).toEqual([]);
    expect(b.bridge.counts.failed).toBe(1);
    b.bridge.budget.enabled = false;
    b.now += 10; b.gesture(G.peace);
    expect(b.jev.received.length).toBe(2);
  });

  test('refusedReflexesStatesAndUndirectedGesturesDoNotAsk', async () => {
    const r = new Rig();
    r.gesture(G.wave, { note: 'wave: budget (1 per 8 s)' });
    r.now += 10; r.gesture(G.clap, { note: 'clap: habituated (events only)' });
    r.now += 10; r.gesture(G.peace, { directed: false });
    r.now += 10; r.ctx.bedtime = true; r.gesture(G.thumbsUp);
    r.now += 10; r.ctx.bedtime = false; r.ctx.agentState = 'thinking'; r.gesture(G.armsUp);
    r.now += 10; r.ctx.agentState = 'noticing'; r.ctx.awake = false; r.gesture(G.heartHands);
    await r.settle();
    expect(r.jev.received).toEqual([]);
    r.ctx.awake = true;
    r.now += 10; r.gesture(G.wave, { note: 'wave → perk up' });
    await r.settle();
    expect(r.jev.received.length).toBe(1);
  });

  test('otherTriggers', async () => {
    const r = new Rig();
    r.bridge.budget.minSpacing = 0;
    r.bridge.budget.burst = 100;
    r.bridge.budget.perMinute = 100;
    const o = { x: 0, y: 0 };
    r.bridge.note({ kind: 'personEntered', id: 3, at: o, distance: 0.8 }, null, people); await r.settle();
    r.now += 1;
    const group = [...people, makeExpressivePerson(4), makeExpressivePerson(5)];
    r.bridge.note({ kind: 'personEntered', id: 5, at: o, distance: 2 }, null, group); await r.settle();
    r.now += 1; r.bridge.note({ kind: 'lookingAtMe', id: 3, seconds: 1 }, null, people);
    r.bridge.note({ kind: 'lookingAtMe', id: 3, seconds: 2 }, null, people); await r.settle();
    r.now += 1; r.bridge.note({ kind: 'engaged', id: 3 }, null, people); await r.settle();
    r.now += 1; r.bridge.noteTap(); r.bridge.noteTap(); r.bridge.noteTap(); await r.settle();
    r.now += 1; r.bridge.noteTickle(); await r.settle();
    r.now += 1; r.bridge.note({ kind: 'personLeft', id: 4, lastPosition: o, exitEdge: null }, null, people); await r.settle();
    expect(r.jev.received.map((f) => f.event))
      .toEqual(['arrival', 'group', 'eyeContact', 'approach', 'pokeStreak', 'tickle', 'leaving']);
    expect(r.jev.received[2].presentSeconds).toBe(2);
    // Ignored: someone here 90 s+ with no attention, once per 5 min.
    r.now += 95;
    const lingering = [makeExpressivePerson(3, { dwell: 120 })];
    r.bridge.tick(lingering); await r.settle();
    r.now += 30; r.bridge.tick(lingering); await r.settle();
    expect(r.jev.received[r.jev.received.length - 1]?.event).toBe('ignored');
    expect(r.jev.received.filter((f) => f.event === 'ignored').length).toBe(1);
  });

  test('recentLabelsAreTheLastFourTriggers', async () => {
    const r = new Rig();
    r.bridge.budget.minSpacing = 0;
    r.bridge.budget.burst = 100;
    r.bridge.budget.perMinute = 100;
    for (const k of [G.clap, G.wave, G.peace, G.armsUp, G.thumbsUp]) { r.now += 1; r.gesture(k); await r.settle(); }
    const last = r.jev.received[r.jev.received.length - 1];
    expect(last.recent).toEqual(['gesture:clap', 'gesture:wave', 'gesture:peace', 'gesture:armsUp']);
  });
});
