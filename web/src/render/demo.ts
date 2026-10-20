// Render demo (web/render-demo.html): the default FaceFrame on WebGPU with a few sliders, for eyeballing.
import { v3 } from '../core/vec';
import { makeFaceFrame } from '../model/FaceFrame';
import { FacePose } from '../model/FacePose';
import { BrowPose } from '../model/BrowPose';
import { Oklab } from '../model/Oklab';
import { FaceRenderer } from './FaceRenderer';

const frame = makeFaceFrame(FacePose.defaults, { brows: BrowPose.restNeutral });
const renderer = new FaceRenderer();
const panel = document.getElementById('panel')!;

function control(label: string, input: HTMLInputElement | HTMLSelectElement, apply: (v: string) => void): void {
  const l = document.createElement('label');
  l.textContent = label;
  input.addEventListener('input', () => { apply(input.value); draw(); });
  panel.append(l, input);
  apply(input.value);
}

function slider(label: string, min: number, max: number, value: number, apply: (v: number) => void): void {
  const i = document.createElement('input');
  Object.assign(i, { type: 'range', min: String(min), max: String(max), step: String((max - min) / 200), value: String(value) });
  control(label, i, (v) => apply(Number(v)));
}

const both = (f: (side: 'left' | 'right') => void) => { f('left'); f('right'); };
slider('pupil x', -1, 1, 0, (v) => both((s) => frame.pose.setEye(s, 'x', v)));
slider('pupil y', -1, 1, 0, (v) => both((s) => frame.pose.setEye(s, 'y', v)));
slider('pupil size', 0.15, 0.85, 0.5, (v) => both((s) => frame.pose.setEye(s, 'size', v)));
slider('upper lid', 0, 1, 0, (v) => both((s) => frame.pose.setEye(s, 'upperLidY', v)));
slider('lower lid', 0, 1, 0, (v) => both((s) => frame.pose.setEye(s, 'lowerLidY', v)));
slider('lid angle', -30, 30, 0, (v) => both((s) => frame.pose.setEye(s, 'upperLidAngle', s === 'left' ? v : -v)));

const brows = document.createElement('input');
brows.type = 'checkbox';
control('brows', brows, () => { renderer.style.browsEnabled = brows.checked; });
slider('brow y', -0.3, 0.6, 0, (v) => both((s) => frame.brows.setLane(s, 'y', v)));
slider('brow rotation', -40, 40, 12, (v) => both((s) => frame.brows.setLane(s, 'rotation', v)));

const shape = document.createElement('select');
for (const [n, id] of [['ellipse', 0], ['star', 1], ['heart', 2], ['note', 3], ['question', 4], ['exclaim', 5]] as const) {
  shape.add(new Option(n, String(id)));
}
control('pupil shape', shape, (v) => { frame.pupilShape.x = frame.pupilShape.y = Number(v); });
slider('morph', 0, 1, 1, (v) => { frame.pupilMorph.x = frame.pupilMorph.y = v; });

const colour = document.createElement('input');
Object.assign(colour, { type: 'color', value: '#5ff6ff' });
control('mood colour', colour, (v) => {
  const c = Oklab.linear(parseInt(v.slice(1), 16));
  frame.color = v3(c.x, c.y, c.z);
  frame.backgroundColor = v3(c.x, c.y, c.z);
});
slider('background', 0, 1, 0, (v) => { frame.backgroundStrength = v; });
slider('blink', 0, 1, 0, (v) => {
  // A blink as the engine draws it: the lids meet and the eye squashes (closure scale).
  both((s) => { frame.pose.setEye(s, 'upperLidY', 0.5 * v); frame.pose.setEye(s, 'lowerLidY', 0.5 * v); });
  frame.closureScale.y = 1 - 0.7 * v;
});
slider('glow', 0, 1, 0, (v) => {
  Object.assign(frame, { glowLevel: v, glowHeight: 0.12, glowMotion: 0.6, glowColor: v3(0.1, 0.6, 1), glowColor2: v3(0.6, 0.2, 1) });
});
slider('caption inset', 0, 0.4, 0, (v) => { frame.captionInset = v; });

let pending = false;
function draw(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; renderer.render(frame); });
}

renderer.onRestored = draw;
renderer.init(document.getElementById('face') as HTMLCanvasElement).then(draw,
  (e: unknown) => { document.getElementById('err')!.textContent = `WebGPU: ${e}`; });
addEventListener('resize', draw);
