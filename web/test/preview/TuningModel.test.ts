import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowLook, TuningModel, settingsPort } from '../../src/preview/TuningModel';
import { EventCollector } from '../../src/preview/EventCollector';
import { makeContext } from './support';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('TuningModel', () => {
  test('expression override: A, B, blend and intensity; clear', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.exprA = 'Happiness'; m.exprB = 'Surprise'; m.blend = 0.25; m.intensity = 1.2;
    m.applyOverride();
    const o = ctx.engine.state.expressionOverride!;
    expect(o.entries).toEqual([{ name: 'Happiness', weight: 0.75 }, { name: 'Surprise', weight: 0.25 }]);
    expect(o.intensity).toBe(1.2);
    m.clearOverride();
    expect(ctx.engine.state.expressionOverride).toBeNull();
  });

  test('brow looks show their expression; the blend goes toward the partner', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.showBrowLook('mockAnnoyed');
    expect(ctx.engine.state.expressionOverride!.entries[0]!.name).toBe(BrowLook.expression('mockAnnoyed'));
    m.browBlendTo = 'surprised'; m.browBlend = 0.4;
    m.applyBrowBlend();
    expect(ctx.engine.state.expressionOverride!.entries.map((e) => e.name)).toEqual(['MockAnnoyed', 'Surprise']);
  });

  test('thinking hold: thinking for the hold, then speaking, then the follow-up 2 s later', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.thinkingHold = 2;
    m.previewThinking();
    expect(ctx.engine.state.agentState).toBe('thinking');
    vi.advanceTimersByTime(2000);
    expect(ctx.engine.state.agentState).toBe('speaking');
    vi.advanceTimersByTime(2000);
    expect(ctx.engine.state.agentState).toBe('followUp');
  });

  test('a thinking beat enters thinking first and plays', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.playThinkingBeat('lightbulb');
    expect(ctx.engine.state.agentState).toBe('thinking');
    ctx.step(3);
    const tb = ctx.engine.director.modifier('ThinkingBeats') as unknown as { current: string | null };
    expect(tb.current).toBe('lightbulb');
  });

  test('noticing preview: arrive, face, closer, leave drive the virtual person', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.noticingArrive();
    const p = () => ctx.engine.state.people.find((q) => q.id === TuningModel.virtualPersonID);
    expect(ctx.engine.state.agentState).toBe('noticing');
    expect(p()).toMatchObject({ distance: 1.6, facing: 0 });
    expect(ctx.engine.state.engagedPersonID).toBeNull();
    m.noticingFace();
    expect(p()!.facing).toBe(0.9);
    vi.advanceTimersByTime(3000);
    expect(p()!.facing).toBe(0);
    m.noticingCloser();
    vi.advanceTimersByTime(1000);
    expect(p()!.distance).toBeCloseTo(0.9, 6);
    m.noticingLeave();
    expect(p()).toBeUndefined();
  });

  test('gaze pad: drag engages the virtual person unless a passer-by; two people', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.simulateTwoPeople = true;
    m.dragGaze({ x: 0.2, y: -0.1 });
    expect(ctx.engine.state.people.map((q) => q.id)).toEqual([999, 998]);
    expect(ctx.engine.state.engagedPersonID).toBe(999);
    m.passerBy = true;
    m.pushPeople();
    expect(ctx.engine.state.primaryPersonID).toBe(999);
    expect(ctx.engine.state.engagedPersonID).toBeNull();
    m.releaseGaze();
    expect(ctx.engine.state.people.map((q) => q.id)).toEqual([998]);
  });

  test('time scale clamps to the preview range', () => {
    const m = new TuningModel(makeContext());
    m.timeScale = 0.01;
    expect(m.engine.timeScale).toBe(0.05);
    m.timeScale = 3;
    expect(m.engine.timeScale).toBe(1);
  });

  test('parameter editor: edits a copy, pushes it, revert restores', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.editingName = 'Happiness';
    const before = m.value(0);
    m.setValue(0, before + 0.1);
    expect(m.isEditedExpressionDirty).toBe(true);
    expect(ctx.engine.state.library.get('Happiness')!.pose.raw[0]).toBeCloseTo(before + 0.1);
    expect(ctx.engine.state.expressionOverride!.entries[0]!.name).toBe('Happiness');
    m.revertEditedExpression();
    expect(m.isEditedExpressionDirty).toBe(false);
    expect(ctx.engine.state.library.get('Happiness')!.pose.raw[0]).toBe(before);
  });

  test('persisted tunables go through the hub when attached, else straight in', () => {
    const ctx = makeContext();
    const changes: unknown[] = [];
    const hub = settingsPort({ get: () => ({}), change: (v: unknown) => changes.push(v) });
    expect(hub).not.toBeNull();
    let direct = 0;
    new TuningModel(ctx, hub).persist({ screen_antics: false }, () => { direct++; });
    expect(changes).toEqual([{ screen_antics: false }]);
    new TuningModel(ctx).persist({ screen_antics: false }, () => { direct++; });
    expect(direct).toBe(1);
    expect(settingsPort({ get: 1 })).toBeNull();
  });

  test('dispose stops scripted checks', () => {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    m.checkSleepCycle();
    m.dispose();
    vi.advanceTimersByTime(20_000);
    expect(ctx.engine.state.agentState).toBe('idle');
  });
});

describe('EventCollector', () => {
  test('frame events (state, one-shot) and diffs are formatted at the drain', () => {
    const ctx = makeContext();
    const lines: [string, string][] = [];
    const c = new EventCollector(ctx, { log: (cat, t) => lines.push([cat, t]) });
    ctx.clock.addAfterFrame(() => c.afterFrame());
    ctx.engine.setAgentState('noticing');
    ctx.engine.send({ kind: 'playOneShot', oneShot: 'perkUp' });
    ctx.step(3);
    ctx.engine.setPeople([{ id: 7, position: { x: 0, y: 0 }, distance: 1.2, salience: 1, facing: 1, lookingAtMe: 0 }], 7);
    c.drain();
    const text = lines.map(([k, t]) => `${k}: ${t}`);
    expect(text).toContain('Face: state → noticing');
    expect(text).toContain('Face: one-shot perkUp');
    expect(text.some((t) => t.startsWith('People: person 7 entered'))).toBe(true);
    expect(text).toContain('People: engaged: none → 7');
  });
});
