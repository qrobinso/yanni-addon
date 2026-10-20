// Port of Tests/FaceEngineTests/OneShotAtTests.swift.
import { describe, expect, test } from 'vitest';
import { Canvas } from '../../src/model';
import {
  FaceCommand, FaceEngine, OneShotApply, OneShotLibrary, OneShotSampler, type OneShotOutput, type StartedOneShot,
} from '../../src/engine';

/// One-shot modifiers only, driven with explicit host time.
class HostOneShotRig {
  readonly engine: FaceEngine;
  host = 7000;
  constructor(readonly fps = 60, seed = 42) {
    this.engine = new FaceEngine({ seed, modifiers: [new OneShotSampler(), new OneShotApply()] });
    this.frame();
  }
  get dt(): number { return 1 / this.fps; }
  get s() { return this.engine.state; }
  frame(override?: number): void {
    const d = override ?? this.dt;
    this.host += d;
    this.engine.tick(d, this.host);
  }
}

describe('OneShotAt', () => {
  // MARK: startedOneShots

  test('startedReportsKindRateHostAndAccents', () => {
    const rig = new HostOneShotRig();
    const sentAt = rig.host;
    rig.engine.send(FaceCommand.playOneShot('bigSurprise'));
    rig.frame();
    expect(rig.s.startedOneShots.length).toBe(1);
    const st = rig.s.startedOneShots[0];
    expect(st.kind).toBe('bigSurprise');
    expect(Math.abs(st.hostTime! - sentAt)).toBeLessThan(1e-6); // starts at the beginning of the frame interval
    expect(Math.abs(st.engineTime - (rig.s.time - rig.dt))).toBeLessThan(1e-6);
    expect(st.rate >= 1 / 1.06 - 1e-4 && st.rate <= 1 / 0.94 + 1e-4).toBe(true); // speed 1 / timeMul
    expect(st.accentTimes).toEqual(OneShotLibrary.spec('bigSurprise').accentTimes);

    // The pop peaks at hostTime + accent / rate (±1 frame).
    let peakHost = rig.host, peak = 0;
    for (let i = 0; i < 60; i++) {
      rig.frame();
      expect(rig.s.startedOneShots.length).toBe(0);
      if (rig.s.oneShot.faceScaleMul.y > peak) { peak = rig.s.oneShot.faceScaleMul.y; peakHost = rig.host; }
    }
    const expected = st.hostTime! + st.accentTimes[0] / st.rate;
    expect(Math.abs(peakHost - expected)).toBeLessThanOrEqual(rig.dt + 1e-6);
  });

  test('rejectedRequestsReportNothing', () => {
    const rig = new HostOneShotRig();
    rig.engine.send(FaceCommand.playOneShot('laugh'));
    rig.frame();
    expect(rig.s.startedOneShots.length).toBe(1);
    for (let i = 0; i < 6; i++) rig.frame();
    rig.engine.send(FaceCommand.playOneShot('laugh')); // within the 0.5 s cooldown
    rig.frame();
    expect(rig.s.startedOneShots.length).toBe(0);
    rig.engine.send(FaceCommand.playOneShotAt('laugh', rig.host + 0.05)); // still in cooldown when due
    for (let i = 0; i < 6; i++) {
      rig.frame();
      expect(rig.s.startedOneShots.length).toBe(0);
    }
  });

  // MARK: playOneShotAt

  test.each([60, 120])('playOneShotAtStartsOnTheTargetFrame (fps %i)', (fps) => {
    const rig = new HostOneShotRig(fps);
    const target = rig.host + 0.3137;
    rig.engine.send(FaceCommand.playOneShotAt('perkUp', target));
    let started: StartedOneShot | undefined;
    let startFrameHost = 0;
    for (let i = 0; i < fps / 2; i++) {
      rig.frame();
      if (started === undefined && rig.s.startedOneShots.length > 0) { started = { ...rig.s.startedOneShots[0] }; startFrameHost = rig.host; }
    }
    expect(started).toBeDefined();
    expect(startFrameHost).toBeGreaterThanOrEqual(target - rig.dt / 2 - 1e-9);
    expect(startFrameHost - rig.dt).toBeLessThan(target - rig.dt / 2);
    expect(Math.abs(started!.hostTime! - target)).toBeLessThan(1e-5);
  });

  function scriptedOutputs(fps: number): OneShotOutput[] {
    const rig = new HostOneShotRig(fps, 9);
    const per = fps / 60;
    const out: OneShotOutput[] = [];
    for (let f = 0; f < 60 * 3 * per; f++) {
      if (f === 0) {
        rig.engine.send(FaceCommand.playOneShotAt('bigSurprise', rig.host + 0.2071));
        rig.engine.send(FaceCommand.playOneShotAt('laugh', rig.host + 1.3049));
      }
      rig.frame();
      if ((f + 1) % per === 0) out.push(rig.s.oneShot.copy());
    }
    return out;
  }

  test('hostTimedStartIsIdenticalAt60And120', () => {
    const a = scriptedOutputs(60), b = scriptedOutputs(120);
    expect(a.length).toBe(b.length);
    let worst = 0;
    const lanes = ['x', 'y', 'z', 'w'] as const;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      let e = Math.abs(y.delta.face('centerY') - x.delta.face('centerY')) * Canvas.yFactor;
      e = Math.max(e, Math.abs(x.faceScaleMul.y - y.faceScaleMul.y), Math.abs(x.faceScaleMul.x - y.faceScaleMul.x));
      for (const l of lanes) e = Math.max(e, Math.abs(x.lidCoverage[l] - y.lidCoverage[l]));
      worst = Math.max(worst, e);
    }
    expect(worst).toBeLessThan(1e-3);
    expect(Math.max(...a.map((o) => o.faceScaleMul.y))).toBeGreaterThan(1.1);
  });

  test('accentLandsOnTargetPlusAccentTime', () => {
    const rig = new HostOneShotRig(120);
    const target = rig.host + 0.25;
    rig.engine.send(FaceCommand.playOneShotAt('bigSurprise', target));
    let st: StartedOneShot | undefined;
    let peak = 0, peakHost = 0;
    for (let i = 0; i < 120; i++) {
      rig.frame();
      if (st === undefined && rig.s.startedOneShots.length > 0) st = { ...rig.s.startedOneShots[0] };
      if (rig.s.oneShot.faceScaleMul.y > peak) { peak = rig.s.oneShot.faceScaleMul.y; peakHost = rig.host; }
    }
    expect(st).toBeDefined();
    const accent = target + st!.accentTimes[0] / st!.rate;
    expect(Math.abs(peakHost - accent)).toBeLessThanOrEqual(rig.dt + 1e-6);
  });

  test('withoutHostTimeStartsImmediately', () => {
    const e = new FaceEngine({ modifiers: [new OneShotSampler(), new OneShotApply()] });
    e.tick(1.0 / 60);
    e.send(FaceCommand.playOneShotAt('perkUp', 1e9));
    e.tick(1.0 / 60);
    expect(e.state.startedOneShots[0]?.kind).toBe('perkUp');
    expect(e.state.startedOneShots[0]?.hostTime).toBeNull();
  });

  test('hostTimedStartSurvivesDtClampHiccup', () => {
    const rig = new HostOneShotRig(60);
    const target = rig.host + 0.4;
    rig.engine.send(FaceCommand.playOneShotAt('perkUp', target));
    rig.frame();
    rig.frame(0.1); // engine dt clamps to 0.05 s; engine time now lags host time
    let startHost: number | undefined;
    for (let i = 0; i < 40; i++) {
      rig.frame();
      if (startHost === undefined && rig.s.startedOneShots.length > 0) startHost = rig.host;
    }
    expect(startHost).toBeDefined();
    const h = startHost!;
    expect(h >= target - rig.dt / 2 - 1e-9 && h - rig.dt < target - rig.dt / 2).toBe(true);
  });
});
