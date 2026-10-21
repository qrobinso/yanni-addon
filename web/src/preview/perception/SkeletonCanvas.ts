// Port of yanni/Perception/SkeletonCanvas.swift: one recorded frame as stick figures (viewer frame: the room as seen
// from in front of the screen). Boxes, joints, hands and head-pose arrows only; there is no image to show.
import type { FeatureFrame } from '../../perception/FeatureFrameCodec';
import type { Joint, NRect } from '../../perception/PerceptionTypes';

/** Body bones by joint name (joints added later draw when present). */
export const BONES: readonly [string, string][] = [
  ['nose', 'neck'], ['neck', 'leftShoulder'], ['neck', 'rightShoulder'], ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'], ['neck', 'root'],
  ['root', 'leftHip'], ['root', 'rightHip'], ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'],
];
export const FINGERS: readonly string[][] = ['thumbCMC thumbMP thumbIP thumbTip', 'indexMCP indexPIP indexDIP indexTip',
  'middleMCP middlePIP middleDIP middleTip', 'ringMCP ringPIP ringDIP ringTip', 'littleMCP littlePIP littleDIP littleTip']
  .map((s) => ['wrist', ...s.split(' ')]);

/** Draws `frame` (null: black) filling the canvas. */
export function drawSkeleton(canvas: HTMLCanvasElement, frame: FeatureFrame | null): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const w = canvas.width, hh = canvas.height;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, hh);
  if (!frame) return;
  const P = (p: { x: number; y: number }): [number, number] => [p.x * w, p.y * hh];
  const rect = (r: NRect): [number, number, number, number] => [r.x * w, r.y * hh, r.w * w, r.h * hh];
  const line = (a: [number, number], b: [number, number], c: string, lw = 2) => {
    g.strokeStyle = c; g.lineWidth = lw; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
  };
  const det = frame.detections;
  for (const b of det.bodies) {
    g.strokeStyle = 'rgba(128,128,128,0.6)'; g.lineWidth = 1; g.strokeRect(...rect(b.box));
    const joints = b.joints as Record<string, Joint | undefined>;
    for (const [a, z] of BONES) {
      const ja = joints[a], jz = joints[z];
      if (!ja || !jz || ja.c < 0.3 || jz.c < 0.3) continue;
      line(P(ja.p), P(jz.p), `rgba(255,255,255,${Math.min(ja.c, jz.c)})`);
    }
  }
  for (const hd of det.hands) {
    const colour = hd.chirality === 'left' ? '#0cf' : '#f90';
    const joints = hd.joints as Record<string, Joint | undefined>;
    for (const chain of FINGERS) {
      const pts = chain.map((n) => joints[n]).filter((j): j is Joint => !!j && j.c >= 0.3);
      for (let i = 1; i < pts.length; i++) line(P(pts[i - 1].p), P(pts[i].p), colour, 1.5);
    }
  }
  for (const f of det.faces) {
    const r = rect(f.box);
    g.strokeStyle = '#36f'; g.lineWidth = 1.5; g.strokeRect(...r);
    if (f.headPose) {
      const c: [number, number] = [r[0] + r[2] / 2, r[1] + r[3] / 2], len = r[2] * 1.2;
      line(c, [c[0] + Math.sin(f.headPose.yaw) * len, c[1] + Math.sin(f.headPose.pitch) * len], '#ff0');
    }
  }
  g.font = '11px ui-monospace, monospace';
  for (const p of frame.people) {
    const box = p.faceBox ?? p.bodyBox;
    if (!box) continue;
    const r = rect(box);
    g.fillStyle = p.engaged ? '#4c4' : p.id === frame.primaryID ? '#ff0' : '#fff';
    g.fillText(`#${p.id} ${p.distance.toFixed(1)} m`, r[0], r[1] - 4);
  }
}
