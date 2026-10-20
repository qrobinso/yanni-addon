// Render parity page: renders each fixtures/render/frames.json entry with the TS FaceRenderer (WebGPU), reads the
// pixels back and compares them with the Metal reference PNG. Driven by run.mjs through `window.parity`.
import fixturesJson from '../../../../fixtures/render/frames.json';
import { FaceRenderer } from '../../../src/render/FaceRenderer';
import { frameFromRecord, styleFromEntry, type RenderFixtures } from '../frames';

const fixtures = fixturesJson as unknown as RenderFixtures;
const pngUrl = (name: string) => new URL(`../../../../fixtures/render/${name}`, import.meta.url).href;

/// Strong local contrast in the reference (3 × 3 neighbourhood range > EDGE_RANGE code values in any channel) marks
/// an anti-aliased edge pixel, where a sub-pixel geometry difference legitimately moves a value a lot.
const EDGE_RANGE = 24;

async function referencePixels(name: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const blob = await (await fetch(pngUrl(name))).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { colorSpace: 'srgb' })!;
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, w, h).data;
}

function edgeMask(ref: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let edge = 0;
      for (let ch = 0; ch < 3 && !edge; ch++) {
        let lo = 255, hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(Math.max(y + dy, 0), h - 1);
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(Math.max(x + dx, 0), w - 1);
            const v = ref[(yy * w + xx) * 4 + ch];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        if (hi - lo > EDGE_RANGE) edge = 1;
      }
      m[y * w + x] = edge;
    }
  }
  return m;
}

async function toPngBase64(rgba: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface ParityResult {
  name: string; mean: number; max: number; maxNonEdge: number; over8NonEdge: number; edgePixels: number;
  pixels: number; diffPng?: string; outPng?: string;
}

const renderer = new FaceRenderer();

async function run(index: number, withImages: boolean): Promise<ParityResult> {
  const e = fixtures.entries[index];
  renderer.style = styleFromEntry(e);
  const w = e.width, h = e.height;
  const got = await renderer.renderPixels(frameFromRecord(e.frame), w, h);
  const ref = await referencePixels(e.png, w, h);
  const mask = edgeMask(ref, w, h);
  let sum = 0, max = 0, maxNonEdge = 0, over8 = 0, edges = 0;
  const diff = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let d = 0;
    for (let ch = 0; ch < 3; ch++) {
      const v = Math.abs(got[i * 4 + ch] - ref[i * 4 + ch]);
      sum += v;
      if (v > d) d = v;
    }
    if (d > max) max = d;
    if (mask[i]) edges++;
    else { if (d > maxNonEdge) maxNonEdge = d; if (d > 8) over8++; }
    // Diff image: grey reference, red = |error| × 16 (edge pixels in blue).
    const k = Math.min(255, d * 16), grey = ref[i * 4 + 1] >> 2;
    diff[i * 4] = mask[i] ? grey : Math.max(grey, k);
    diff[i * 4 + 1] = grey;
    diff[i * 4 + 2] = mask[i] ? Math.max(grey, k) : grey;
    diff[i * 4 + 3] = 255;
  }
  const r: ParityResult = { name: e.name, mean: sum / (w * h * 3), max, maxNonEdge, over8NonEdge: over8,
    edgePixels: edges, pixels: w * h };
  if (withImages) {
    r.diffPng = await toPngBase64(diff, w, h);
    r.outPng = await toPngBase64(new Uint8ClampedArray(got), w, h);
  }
  return r;
}

declare global {
  interface Window { parity: { ready: Promise<number>; run: typeof run } }
}

window.parity = {
  ready: renderer.init().then(() => fixtures.entries.length),
  run,
};
window.parity.ready.then(
  (n) => { document.getElementById('log')!.textContent = `ready: ${n} entries`; },
  (err) => { document.getElementById('log')!.textContent = `init failed: ${err}`; });
