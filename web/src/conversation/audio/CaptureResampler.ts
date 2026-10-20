// Port of ConversationAudio/CaptureResampler.swift: hardware input rate → 16 kHz mono Float32 for the detectors.
// port-note: AVAudioConverter (max quality) becomes a polyphase windowed-sinc filter (Blackman, 32 zero crossings of
// the output rate, cutoff 7.2 kHz). Same contract: zero latency (output sample k lines up with input time
// k / 16 kHz from the stream's start; only the filter's look-ahead is held back), so `inputFrames(forOutput:)` maps an
// output position back to the input stream with no delay correction. Runs in the capture AudioWorklet; allocation-free
// after construction.

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export class CaptureResampler {
  static readonly outputRate = 16_000;
  static readonly zeroCrossings = 32;
  static readonly cutoffHz = 7_200;
  static readonly inputCapacity = 4096;

  readonly inputRate: number;
  /** 16 kHz frames produced since the stream started (`reset`). */
  outputFrames = 0;
  /** Input frames consumed since the stream started. */
  inputFrames = 0;

  // t_k = k·a / b input samples (a / b = inputRate / 16 kHz in lowest terms): `b` filter phases.
  private readonly a: number;
  private readonly b: number;
  /** Half-width in input samples; taps run from floor(t) − half + 1 to floor(t) + half. */
  private readonly half: number;
  private readonly taps: number;
  private readonly table: Float32Array;
  // Input history: `hist[i]` is absolute input sample `histStart + i`.
  private readonly hist: Float32Array;
  private histStart = 0;
  private histLen = 0;
  private readonly out = new Float32Array(2048);

  /** null for an unusable rate (non-integer or < 8 kHz). */
  static make(inputRate: number): CaptureResampler | null {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || !Number.isInteger(inputRate)) return null;
    return new CaptureResampler(inputRate);
  }

  private constructor(inputRate: number) {
    this.inputRate = inputRate;
    const g = gcd(inputRate, CaptureResampler.outputRate);
    this.a = inputRate / g;
    this.b = CaptureResampler.outputRate / g;
    const ratio = Math.max(inputRate / CaptureResampler.outputRate, 1);
    this.half = Math.ceil(CaptureResampler.zeroCrossings * ratio);
    this.taps = 2 * this.half;
    const fc = CaptureResampler.cutoffHz / inputRate; // cycles per input sample
    this.table = new Float32Array(this.b * this.taps);
    for (let ph = 0; ph < this.b; ph++) {
      const frac = ph / this.b;
      let sum = 0;
      for (let j = 0; j < this.taps; j++) {
        const d = j - this.half + 1 - frac; // input sample position minus t
        const x = 2 * fc * d;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / this.half) + 0.08 * Math.cos((2 * Math.PI * d) / this.half);
        const h = Math.abs(d) >= this.half ? 0 : 2 * fc * sinc * w;
        this.table[ph * this.taps + j] = h;
        sum += h;
      }
      for (let j = 0; j < this.taps; j++) this.table[ph * this.taps + j] /= sum; // unity DC gain at every phase
    }
    this.hist = new Float32Array(CaptureResampler.inputCapacity + this.taps + 8);
    this.reset();
  }

  /** Input frames (since the stream started) that line up with output position `k`. */
  inputFramesForOutput(k: number): number {
    return (k * this.inputRate) / CaptureResampler.outputRate;
  }

  /** A new stream: forget the filter history and the counters. */
  reset(): void {
    this.outputFrames = 0;
    this.inputFrames = 0;
    // The stream starts in silence: history before sample 0 reads as zeros.
    this.hist.fill(0);
    this.histStart = -this.half;
    this.histLen = this.half;
  }

  /** Converts `src`; `emit` receives each 16 kHz chunk as it is produced (zero or more calls; the view is valid only
   *  during the call). */
  process(src: Float32Array, emit: (chunk: Float32Array) => void): void {
    let done = 0;
    while (done < src.length) {
      const room = this.hist.length - this.histLen;
      const n = Math.min(src.length - done, room);
      this.hist.set(src.subarray(done, done + n), this.histLen);
      this.histLen += n;
      this.inputFrames += n;
      done += n;
      this.drain(emit);
    }
  }

  private drain(emit: (chunk: Float32Array) => void): void {
    const { a, b, half, taps, table, hist, out } = this;
    let produced = 0;
    for (;;) {
      const num = this.outputFrames * a;
      const base = Math.floor(num / b);
      const ph = num - base * b;
      const first = base - half + 1; // absolute index of tap 0
      if (base + half >= this.histStart + this.histLen) break; // look-ahead not here yet
      const off = first - this.histStart;
      let s = 0;
      const row = ph * taps;
      for (let j = 0; j < taps; j++) s += hist[off + j] * table[row + j];
      out[produced++] = s;
      this.outputFrames += 1;
      if (produced === out.length) { emit(out); produced = 0; }
    }
    if (produced > 0) emit(out.subarray(0, produced));
    // Keep only what the next output still needs.
    const nextFirst = Math.floor((this.outputFrames * a) / b) - half + 1;
    const drop = Math.max(0, Math.min(nextFirst - this.histStart, this.histLen));
    if (drop > 0) {
      hist.copyWithin(0, drop, this.histLen);
      this.histLen -= drop;
      this.histStart += drop;
    }
  }
}
