// A placeholder face until the engine lands (main.ts swaps it for `new FaceEngine()`): a slow gaze drift, a blink
// every few seconds, and a blink plus a look toward a tap.
import type { V2 } from '../core/vec';
import { BrowPose } from '../model/BrowPose';
import { makeFaceFrame, type FaceFrame, type FaceFrameSource } from '../model/FaceFrame';
import { FacePose } from '../model/FacePose';

export class StubFaceSource implements FaceFrameSource {
  private readonly out = makeFaceFrame(FacePose.defaults, { brows: BrowPose.restNeutral });
  private nextBlink = 2;
  private blinkAt = -1;
  private look: { at: V2; until: number } | undefined;
  private t = 0;

  /** The engine's `send(FaceCommand)` subset the shell uses. */
  send(c: { kind: string; at?: V2 }): void {
    if (c.kind !== 'tap' || !c.at) return;
    this.blinkAt = this.t;
    this.look = { at: { ...c.at }, until: this.t + 1.2 };
  }

  frame(presentationTime: number): FaceFrame {
    const t = (this.t = presentationTime);
    if (t >= this.nextBlink) { this.blinkAt = t; this.nextBlink = t + 2.5 + 3 * Math.random(); }
    const b = t - this.blinkAt, blink = b >= 0 && b < 0.18 ? Math.sin((b / 0.18) * Math.PI) : 0;
    const look = this.look && t < this.look.until ? this.look.at : undefined;
    const x = look ? look.x * 0.5 : 0.25 * Math.sin(t * 0.31) * Math.sin(t * 0.13);
    const y = look ? look.y * 0.4 : 0.12 * Math.sin(t * 0.23 + 1);
    const pose = this.out.pose;
    for (const s of ['left', 'right'] as const) {
      pose.setEye(s, 'x', x);
      pose.setEye(s, 'y', y);
      pose.setEye(s, 'upperLidY', 0.5 * blink);
      pose.setEye(s, 'lowerLidY', 0.5 * blink);
    }
    this.out.closureScale.y = 1 - 0.7 * blink;
    return this.out;
  }
}
