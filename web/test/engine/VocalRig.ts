// Swift VocalRig (VocalSyncTests.swift): a FaceEngine running VocalSync alone on a simulated display-link clock.
import { Canvas, ParamLayout, VocalContour } from '../../src/model';
import { FaceCommand, FaceEngine, type FaceState, type OneShotKind, type VocalCueKind } from '../../src/engine';
import { VocalSync } from '../../src/engine/modifiers/VocalSync';

export class VocalRig {
  readonly vs = new VocalSync();
  readonly engine: FaceEngine;
  host = 5000;
  constructor(readonly fps = 60) {
    this.engine = new FaceEngine({ modifiers: [this.vs] });
    this.frame();
  }
  get dt(): number { return 1 / this.fps; }
  get s(): FaceState { return this.engine.state; }
  frame(dt?: number): void {
    const d = dt ?? this.dt;
    this.host += d;
    this.engine.tick(d, this.host);
  }
  run(seconds: number, each?: () => void): void {
    const n = Math.round(seconds * this.fps);
    for (let i = 0; i < n; i++) { this.frame(); each?.(); }
  }
  cue(delay: number, o: { duration?: number; contour?: VocalContour; intensity?: number; articulation?: number;
    valence?: number; kind?: VocalCueKind; accent?: boolean; paired?: OneShotKind } = {}): void {
    this.engine.send(FaceCommand.vocalCue({
      hostTime: this.host + delay, duration: o.duration ?? 0.15, contour: o.contour ?? VocalContour.flat(0),
      intensity: o.intensity ?? 0.7, articulation: o.articulation ?? 0.6, valence: o.valence ?? 0, kind: o.kind ?? 'plain',
      accent: o.accent ?? false, pairedOneShot: o.paired,
    }));
  }
  get faceYCanvas(): number { return this.s.delta.raw[ParamLayout.index('centerY')] * Canvas.yFactor; }
  get faceXCanvas(): number { return this.s.delta.raw[ParamLayout.index('centerX')] * Canvas.xFactor; }
}
