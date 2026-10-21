// Port of YanniKioskTests/LaunchGuardTests.swift (the directory is an in-memory Storage).
import { describe, expect, test } from 'vitest';
import type { KeyValue } from '../../src/app/OwnerAccess';
import { LaunchGuard, LaunchRecord } from '../../src/kiosk/LaunchGuard';
import { memoryStore } from './support';

const launch = (store: KeyValue, at: Date, boot = 1000, debugged = false) =>
  new LaunchGuard(store, { now: at, uptime: 50, bootTime: boot, app: '1.0 (1)', os: 'test', debugged });
const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

describe('LaunchGuard', () => {
  test('exit kind classification', () => {
    const r = LaunchRecord.make({ start: new Date().toISOString(), bootTime: 1000 });
    expect(LaunchGuard.classify(r, 1000)).toBe('crash');
    expect(LaunchGuard.classify(r, 5000)).toBe('reboot');
    r.breadcrumbs = ['hang'];
    expect(LaunchGuard.classify(r, 1000)).toBe('hang');
    r.breadcrumbs = ['selfRestart'];
    expect(LaunchGuard.classify(r, 1000)).toBe('selfRestart');
    r.breadcrumbs = ['crashTest'];
    expect(LaunchGuard.classify(r, 1000)).toBe('crashTest');
    r.cleanExit = true;
    expect(LaunchGuard.classify(r, 1000)).toBe('clean');
  });

  test('debugger stops never count as crashes', () => {
    const s = memoryStore();
    const t = new Date();
    for (let i = 0; i < 4; i++) launch(s, plus(t, i * 30), 1000, true);
    const g = launch(s, plus(t, 150));
    expect(g.decision.mode).toEqual({ kind: 'normal' });
    expect(g.decision.previousExit).toBe('clean');
    const old = LaunchRecord.make({ start: t.toISOString(), bootTime: 1000 });
    delete old.debugged;   // a record written before the field existed still classifies
    expect(LaunchGuard.classify(old, 1000)).toBe('crash');
  });

  test('suspect from breadcrumbs', () => {
    const r = LaunchRecord.make({ start: new Date().toISOString() });
    r.breadcrumbs = ['starting:render', 'started:render', 'starting:audio', 'started:audio', 'starting:perception'];
    expect(LaunchRecord.openStart(r)).toBe('perception');
    r.breadcrumbs.push('started:perception');
    expect(LaunchRecord.openStart(r)).toBeNull();
  });

  test('clean runs stay normal', () => {
    const s = memoryStore();
    let t = new Date(1_000_000_000);
    for (let i = 0; i < 5; i++) {
      const g = launch(s, t);
      expect(g.decision.mode).toEqual({ kind: 'normal' });
      g.markCleanExit(10);
      t = plus(t, 30);
    }
    expect(launch(s, t).decision.previousExit).toBe('clean');
  });

  test('two quick crashes → careful start, three → safe mode', () => {
    const s = memoryStore();
    let t = new Date(2_000_000_000);
    let g = launch(s, t);
    g.starting('perception');
    t = plus(t, 20);
    g = launch(s, t);                      // 1 crash
    expect(g.decision.mode).toEqual({ kind: 'normal' });
    expect(g.decision.previousExit).toBe('crash');
    expect(g.history[0].suspect).toBe('perception');
    g.starting('perception');
    t = plus(t, 20);
    g = launch(s, t);                      // 2 → careful, skipping the suspect
    expect(g.decision.mode).toEqual({ kind: 'careful', skip: ['perception'] });
    t = plus(t, 20);
    g = launch(s, t);                      // 3 → safe mode
    expect(g.decision.mode).toEqual({ kind: 'safe', suspects: ['perception'] });
    expect(g.current?.breadcrumbs.includes('safeMode')).toBe(true);
  });

  test('long runs, reboots and crash tests break the loop', () => {
    const s = memoryStore();
    let t = new Date(3_000_000_000);
    let g = launch(s, t);
    t = plus(t, 20); g = launch(s, t);
    g.noteAlive(600);                      // this run lives 10 min: a slow crash isn't a loop
    t = plus(t, 20); g = launch(s, t);
    expect(g.decision.uncleanStreak).toBe(0);
    t = plus(t, 20); g = launch(s, t, 9999);
    expect(g.decision.previousExit).toBe('reboot');
    expect(g.decision.mode).toEqual({ kind: 'normal' });
    for (let i = 0; i < 3; i++) {
      g.breadcrumb('crashTest');
      t = plus(t, 10); g = launch(s, t, 9999);
      expect(g.decision.mode).toEqual({ kind: 'normal' });
    }
  });

  test('old crashes outside the window don\'t count', () => {
    const s = memoryStore();
    let t = new Date(4_000_000_000);
    launch(s, t);
    t = plus(t, 20); launch(s, t);
    t = plus(t, 20); launch(s, t);
    t = plus(t, 3600);
    expect(launch(s, t).decision.mode).toEqual({ kind: 'normal' });
  });

  test('hang breadcrumb counts as unclean', () => {
    const s = memoryStore();
    let t = new Date(5_000_000_000);
    let g = launch(s, t);
    for (let i = 0; i < 3; i++) { g.breadcrumb('hang'); g.flushNow(); t = plus(t, 30); g = launch(s, t); }
    expect(g.decision.mode).toEqual({ kind: 'safe', suspects: [] });
    expect(g.history[0].exit).toBe('hang');
  });

  test('keeps the last twenty', () => {
    const s = memoryStore();
    let t = new Date(6_000_000_000);
    let g = launch(s, t);
    for (let i = 0; i < 30; i++) { g.markCleanExit(1); t = plus(t, 5); g = launch(s, t); }
    expect(g.history.length).toBe(20);
  });

  test('probation order', () => {
    expect(LaunchGuard.probationAllowed(100, [])).toEqual([]);
    expect(LaunchGuard.probationAllowed(1800, [])).toEqual(['audio']);
    expect(LaunchGuard.probationAllowed(2400, [])).toEqual(['audio', 'mqtt']);
    const all = LaunchGuard.probationAllowed(1800 + 600 * 10, ['audio']);
    expect(all[all.length - 1]).toBe('audio');
    expect(all.length).toBe(LaunchGuard.probationOrder.length);
  });

  test('the session stamp survives a reload, not a new session', () => {
    const session = memoryStore();
    const a = LaunchGuard.sessionStamp(session, 100);
    expect(LaunchGuard.sessionStamp(session, 200)).toBe(a);
    expect(LaunchGuard.sessionStamp(memoryStore(), 200)).toBe(200);
  });

  test('a corrupt history starts fresh', () => {
    const s = memoryStore();
    s.setItem(LaunchGuard.key, '{nope');
    expect(launch(s, new Date()).decision.previousExit).toBeNull();
  });
});
