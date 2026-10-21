import { describe, expect, test } from 'vitest';
import { canonicalCategory, contextEventSource, EventLog, EventLogView } from '../../src/preview/EventLog';

describe('EventLog', () => {
  test('keeps the last 200 events, newest first', () => {
    let now = 0;
    const log = new EventLog(() => ++now);
    for (let i = 0; i < 250; i++) log.log('Face', `e${i}`);
    const ev = log.events();
    expect(ev).toHaveLength(EventLog.capacity);
    expect(ev[0]!.text).toBe('e249');
    expect(ev[199]!.text).toBe('e50');
    expect(log.last?.text).toBe('e249');
    expect(ev[0]!.id).toBeGreaterThan(ev[1]!.id);
  });

  test('version moves on every change; clear empties', () => {
    const log = new EventLog();
    const v0 = log.version;
    log.log('Voice', 'chirp');
    expect(log.version).not.toBe(v0);
    log.clear();
    expect(log.size).toBe(0);
    expect(log.events()).toEqual([]);
    expect(log.last).toBeNull();
  });

  test('categories are canonical (the app logs lower case)', () => {
    const log = new EventLog();
    log.log('home', 'announcement spoken');
    log.log('voice', 'output started');
    log.log('kiosk', 'governor 2');
    expect(log.events().map((e) => e.category)).toEqual(['kiosk', 'Voice', 'HA']);
    expect(canonicalCategory('talk')).toBe('Talk');
  });

  test('onEvent sees each event as it is logged', () => {
    const log = new EventLog();
    const seen: string[] = [];
    log.onEvent = (e) => seen.push(e.text);
    log.log('Life', 'awake → drowsy');
    expect(seen).toEqual(['awake → drowsy']);
  });
});

describe('EventLogView', () => {
  test('filters by category, and a pause freezes what is shown', () => {
    const log = new EventLog();
    const view = new EventLogView(log);
    log.log('Face', 'a');
    log.log('Voice', 'b');
    view.toggle('Voice');
    expect(view.visible().map((e) => e.text)).toEqual(['a']);
    view.togglePause();
    log.log('Face', 'c');
    expect(view.paused).toBe(true);
    expect(view.visible().map((e) => e.text)).toEqual(['a']);
    view.togglePause();
    expect(view.visible().map((e) => e.text)).toEqual(['c', 'a']);
    view.toggle('Voice');
    expect(view.visible()).toHaveLength(3);
  });

  test('chips: the standard categories, then others in order of appearance', () => {
    const log = new EventLog();
    log.log('kiosk', 'x');
    log.log('Diag', 'y');
    const view = new EventLogView(log);
    expect(view.categories().slice(-2)).toEqual(['kiosk', 'Diag']);
    expect(view.categories()[0]).toBe('Face');
  });

  test('clear while paused shows nothing', () => {
    const log = new EventLog();
    const view = new EventLogView(log);
    log.log('Face', 'a');
    view.togglePause();
    view.clear();
    expect(view.visible()).toEqual([]);
  });
});

describe('contextEventSource', () => {
  test('reads the app events newest first; clear hides what is there', () => {
    const events: { at: number; category: string; message: string }[] = [
      { at: 1, category: 'voice', message: 'one' }, { at: 2, category: 'home', message: 'two' }];
    const src = contextEventSource({ events });
    expect(src.events().map((e) => [e.category, e.text])).toEqual([['HA', 'two'], ['Voice', 'one']]);
    const v = src.version;
    src.clear();
    expect(src.events()).toEqual([]);
    events.push({ at: 3, category: 'talk', message: 'three' });
    expect(src.version).not.toBe(v);
    expect(src.events().map((e) => e.text)).toEqual(['three']);
  });
});
