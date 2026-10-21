// The Status page's card models (DevStatus.swift's snapshots): levels, the rows that matter, never text from people.
import { describe, expect, test } from 'vitest';
import { FaceCommand } from '../../src/engine/Commands';
import { DevStatusModel, decisionCard, emotionCard, engineCard, formatSeconds, homeCard, lifeCard, perceptionCard, touchCard,
  voiceCard, voiceServicesCard } from '../../src/preview/DevStatus';
import { EventLog } from '../../src/preview/EventLog';
import { makeContext } from './support';

const row = (c: { rows: { label: string; value: string }[] }, label: string) => c.rows.find((r) => r.label === label)?.value;

describe('status cards', () => {
  test('missing subsystems read as not built', () => {
    const ctx = makeContext();
    for (const c of [voiceCard(ctx), emotionCard(ctx), decisionCard(ctx), homeCard(ctx, new EventLog()), voiceServicesCard(ctx)]) {
      expect(c.level).toBe('notBuilt');
    }
    expect(perceptionCard(ctx)).toMatchObject({ level: 'degraded', detail: 'simulated' });
  });

  test('face engine: state, one-shots and the pupil shape on screen', () => {
    const ctx = makeContext();
    ctx.step(10);
    ctx.engine.playPupilShape('starEyes');
    ctx.step(30);
    const c = engineCard(ctx);
    expect(c.detail).toBe('idle');
    expect(row(c, 'one-shots')).toContain('starEyes');
    expect(row(c, 'pupil shape')).toMatch(/^stars \(L /);
    expect(row(c, 'eyebrows')).toBe('off');
    ctx.setStyle({ ...ctx.style(), browsEnabled: true });
    expect(row(engineCard(ctx), 'eyebrows')).toMatch(/^presence /);
  });

  test('face engine flags slow time', () => {
    const ctx = makeContext();
    ctx.engine.timeScale = 0.25;
    expect(engineCard(ctx).rows.find((r) => r.label === 'time scale')).toMatchObject({ value: '×0.25', tint: 'warn' });
  });

  test('touch: taps count and sulking turns the card', () => {
    const ctx = makeContext();
    ctx.step(5);
    for (let i = 0; i < 8; i++) { ctx.engine.send(FaceCommand.tap({ x: 0, y: 0 })); ctx.step(6); }
    const c = touchCard(ctx);
    expect(row(c, 'taps')).toMatch(/^8 total/);
    expect(c.rows[0]!.bar!.value).toBeGreaterThan(1);
  });

  test('life cycle: phase, bedtime and the time warp', () => {
    const ctx = makeContext();
    ctx.life.timeWarp = 10;
    const c = lifeCard(ctx);
    expect(c.detail).toBe('awake');
    expect(row(c, 'bedtime')).toBe('off');
    expect(c.rows.find((r) => r.label === 'time warp')).toMatchObject({ value: '×10', tint: 'warn' });
  });

  test('emotion and decision model with a layer; a condition degrades them', () => {
    const ctx = makeContext({ emotion: true });
    ctx.step(5);
    expect(emotionCard(ctx).level).toBe('running');
    ctx.emotion!.setCondition('decisionModelDown', true);
    expect(emotionCard(ctx).level).toBe('degraded');
    expect(decisionCard(ctx)).toMatchObject({ level: 'degraded', detail: 'unavailable' });
  });

  test('home: the socket, HA and the recent HA events', () => {
    const ctx = makeContext();
    ctx.client = { connected: true, haConnected: false, status: 'connected', attempts: 0, deviceId: 'd1', room: 'Office' } as never;
    const log = new EventLog();
    log.log('home', 'command force_sleep');
    const c = homeCard(ctx, log);
    expect(c.level).toBe('degraded');
    expect(row(c, 'room')).toBe('Office');
    expect(row(c, 'last in')).toMatch(/^command force_sleep/);
  });

  test('the model polls every card in order and measures fps from the clock', () => {
    const ctx = makeContext();
    let wall = 0;
    const m = new DevStatusModel(ctx, new EventLog(), null, () => wall);
    ctx.step(60);
    wall = 1;
    const cards = m.poll();
    expect(cards.map((c) => c.id)).toEqual(['performance', 'display', 'face', 'perception', 'life', 'voice', 'touch', 'talk',
      'emotion', 'decision', 'home']);
    expect(m.fps).toBeCloseTo(60, 5);
    expect(m.hud()).toMatchObject({ agent: 'idle', phase: 'awake', people: 0, fps: 60 });
  });

  test('a kiosk health card goes first', () => {
    const ctx = makeContext();
    const m = new DevStatusModel(ctx, new EventLog(), { healthCard: () => ({ id: 'health', title: 'Health', level: 'running', detail: 'ok', rows: [] }) });
    expect(m.poll()[0]!.id).toBe('health');
  });

  test('formatSeconds', () => {
    expect(formatSeconds(42.2)).toBe('43 s');
    expect(formatSeconds(185)).toBe('3:05');
  });
});
