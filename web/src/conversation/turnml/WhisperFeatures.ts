// Smart Turn v3.2's front end: `WhisperFeatureExtractor(chunk_length=8)` with `do_normalize=True`, exactly as
// smart-turn's inference.py feeds the ONNX model (Tools/turn-models/smart_turn_model.py `WhisperFrontEnd` describes the
// same steps; on the iPad they live inside the Core ML model). On an already 8 s, front-padded window:
//   zero-mean unit-variance over all 128 000 samples (ε 1e-7) → centred reflect-padded STFT (n_fft 400, hop 160,
//   periodic Hann) → power → 80-bin Slaney mel filterbank (0–8 kHz) → log10(max(·, 1e-10)) → max(·, max − 8)
//   → (x + 4) / 4, last frame dropped → [80, 800] row-major (mel-major), float32.
// Allocation-free after construction: one extractor per Smart Turn instance (runs serially).
import { TurnAudioFormat } from '../turn/TurnTunables';

export const N_FFT = 400;
export const HOP = 160;
export const N_MELS = 80;
export const N_FRAMES = TurnAudioFormat.windowSamples / HOP; // 800 (801 STFT frames, the last dropped)
const N_BINS = N_FFT / 2 + 1; // 201

// MARK: Slaney mel scale (transformers.audio_utils hertz_to_mel / mel_to_hertz, mel_scale="slaney")
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = 15;
const LOGSTEP = 27 / Math.log(6.4);
const hzToMel = (f: number): number => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) * LOGSTEP : (3 * f) / 200);
const melToHz = (m: number): number => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp((m - MIN_LOG_MEL) / LOGSTEP) : (200 * m) / 3);

/** `mel_filter_bank(201, 80, 0, 8000, 16000, norm="slaney", mel_scale="slaney")`, as [mel][bin]. */
export function melFilterBank(): Float64Array {
  const melMin = hzToMel(0), melMax = hzToMel(8000);
  const filterFreqs = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) filterFreqs[i] = melToHz(melMin + ((melMax - melMin) * i) / (N_MELS + 1));
  const out = new Float64Array(N_MELS * N_BINS);
  for (let m = 0; m < N_MELS; m++) {
    const lo = filterFreqs[m], mid = filterFreqs[m + 1], hi = filterFreqs[m + 2];
    const enorm = 2 / (hi - lo);
    for (let b = 0; b < N_BINS; b++) {
      const f = (8000 * b) / (N_BINS - 1);
      const down = (f - lo) / (mid - lo), up = (hi - f) / (hi - mid);
      out[m * N_BINS + b] = Math.max(0, Math.min(down, up)) * enorm;
    }
  }
  return out;
}

/** A mixed-radix (4·4·5·5) complex FFT of length 400, preallocated. */
export class FFT400 {
  readonly n = N_FFT;
  private static readonly factors = [4, 4, 5, 5];
  private readonly cos = new Float64Array(N_FFT);
  private readonly sin = new Float64Array(N_FFT);
  private readonly tr = new Float64Array(5);
  private readonly ti = new Float64Array(5);

  constructor() {
    for (let e = 0; e < N_FFT; e++) {
      this.cos[e] = Math.cos((2 * Math.PI * e) / N_FFT);
      this.sin[e] = -Math.sin((2 * Math.PI * e) / N_FFT);
    }
  }

  /** out = DFT(in), both split complex; `in` is read with `stride` from `off`. */
  transform(inRe: Float64Array, inIm: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    this.rec(inRe, inIm, 0, 1, N_FFT, 0, outRe, outIm, 0);
  }

  private rec(inRe: Float64Array, inIm: Float64Array, inOff: number, stride: number, n: number, fi: number,
    outRe: Float64Array, outIm: Float64Array, outOff: number): void {
    if (n === 1) { outRe[outOff] = inRe[inOff]; outIm[outOff] = inIm[inOff]; return; }
    const r = FFT400.factors[fi], m = n / r;
    for (let j = 0; j < r; j++) this.rec(inRe, inIm, inOff + j * stride, stride * r, m, fi + 1, outRe, outIm, outOff + j * m);
    const step = N_FFT / n; // W_n^a = W_N^(a·step)
    const rstep = N_FFT / r;
    const { cos, sin, tr, ti } = this;
    for (let k = 0; k < m; k++) {
      for (let j = 0; j < r; j++) {
        const e = (j * k * step) % N_FFT;
        const yr = outRe[outOff + j * m + k], yi = outIm[outOff + j * m + k];
        tr[j] = yr * cos[e] - yi * sin[e];
        ti[j] = yr * sin[e] + yi * cos[e];
      }
      for (let q = 0; q < r; q++) {
        let sr = 0, si = 0;
        for (let j = 0; j < r; j++) {
          const e = ((j * q) % r) * rstep;
          sr += tr[j] * cos[e] - ti[j] * sin[e];
          si += tr[j] * sin[e] + ti[j] * cos[e];
        }
        outRe[outOff + q * m + k] = sr;
        outIm[outOff + q * m + k] = si;
      }
    }
  }
}

export class WhisperFeatureExtractor {
  /** [80 × 800] log-mel, the Smart Turn `input_features` backing. */
  readonly features = new Float32Array(N_MELS * N_FRAMES);
  private readonly mel = melFilterBank();
  /** Each filter's non-zero bins [lo, hi): the bank is sparse (2–9 bins per filter). */
  private readonly melLo = new Int32Array(N_MELS);
  private readonly melHi = new Int32Array(N_MELS);
  private readonly window = new Float64Array(N_FFT);
  private readonly fft = new FFT400();
  private readonly fr = new Float64Array(N_FFT);
  private readonly fi = new Float64Array(N_FFT);
  private readonly xr = new Float64Array(N_FFT);
  private readonly xi = new Float64Array(N_FFT);
  private readonly power = new Float64Array(N_BINS);
  private readonly norm = new Float64Array(TurnAudioFormat.windowSamples);

  constructor() {
    for (let i = 0; i < N_FFT; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT); // periodic Hann
    for (let m = 0; m < N_MELS; m++) {
      let lo = N_BINS, hi = 0;
      for (let b = 0; b < N_BINS; b++) if (this.mel[m * N_BINS + b] !== 0) { lo = Math.min(lo, b); hi = b + 1; }
      this.melLo[m] = Math.min(lo, hi);
      this.melHi[m] = hi;
    }
  }

  /** `audio`: 128 000 samples (the right-aligned, front-padded window). Fills and returns `features`. */
  extract(audio: Float32Array): Float32Array {
    const n = audio.length;
    if (n !== TurnAudioFormat.windowSamples) throw new RangeError(`window must be ${TurnAudioFormat.windowSamples} samples`);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += audio[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = audio[i] - mean; v += d * d; }
    const inv = 1 / Math.sqrt(v / n + 1e-7);
    const x = this.norm;
    for (let i = 0; i < n; i++) x[i] = (audio[i] - mean) * inv;

    const half = N_FFT / 2;
    const out = this.features;
    let maxLog = -Infinity;
    for (let t = 0; t < N_FRAMES; t++) {
      const base = t * HOP - half; // centred: frame t is centred on sample t·hop
      for (let i = 0; i < N_FFT; i++) {
        let j = base + i;
        if (j < 0) j = -j; else if (j >= n) j = 2 * (n - 1) - j; // reflect (no edge repeat)
        this.fr[i] = x[j] * this.window[i];
        this.fi[i] = 0;
      }
      this.fft.transform(this.fr, this.fi, this.xr, this.xi);
      for (let b = 0; b < N_BINS; b++) this.power[b] = this.xr[b] * this.xr[b] + this.xi[b] * this.xi[b];
      for (let m = 0; m < N_MELS; m++) {
        let s = 0;
        const row = m * N_BINS;
        for (let b = this.melLo[m]; b < this.melHi[m]; b++) s += this.mel[row + b] * this.power[b];
        const l = Math.log10(Math.max(s, 1e-10));
        out[m * N_FRAMES + t] = l;
        if (l > maxLog) maxLog = l;
      }
    }
    const floor = maxLog - 8;
    for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
    return out;
  }
}
