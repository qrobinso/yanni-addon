// The capture AudioWorklet (port-note: stands in for ConversationAudio/CaptureTap's real-time producer). Channel 0 of
// the echo-cancelled microphone → `CaptureResampler` (16 kHz) → 512-sample frames posted to the main thread with the
// context frame (input rate) at which each frame ends, so the main thread can stamp host times. Loaded with
// `audioWorklet.addModule(url)` from `captureWorklet.ts?worker&url` (Vite bundles the resampler in).
import { CaptureResampler } from './CaptureResampler';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export interface CaptureFrameMessage {
  kind: 'frame';
  /** 512 samples, 16 kHz mono (a fresh buffer, transferred). */
  samples: Float32Array;
  /** Context frame (at `inputRate`) just after the frame's last sample. */
  endFrame: number;
  inputRate: number;
  /** Input frames consumed since the previous message. */
  inputFrames: number;
}

const FRAME = 512;

class YanniCaptureProcessor extends AudioWorkletProcessor {
  private readonly rs = CaptureResampler.make(Math.round(sampleRate));
  private streamStart = -1;
  private frame = new Float32Array(FRAME);
  private fill = 0;
  private consumed = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    const rs = this.rs;
    if (!ch || !rs) return true;
    if (this.streamStart < 0) this.streamStart = currentFrame;
    this.consumed += ch.length;
    rs.process(ch, (chunk) => {
      let i = 0;
      while (i < chunk.length) {
        const take = Math.min(FRAME - this.fill, chunk.length - i);
        this.frame.set(chunk.subarray(i, i + take), this.fill);
        this.fill += take;
        i += take;
        if (this.fill < FRAME) break;
        // The output position of this frame's end, mapped back to the input stream (zero-latency resampler).
        const outEnd = rs.outputFrames - (chunk.length - i);
        const msg: CaptureFrameMessage = {
          kind: 'frame', samples: this.frame, inputRate: rs.inputRate, inputFrames: this.consumed,
          endFrame: this.streamStart + rs.inputFramesForOutput(outEnd),
        };
        this.port.postMessage(msg, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME);
        this.fill = 0;
        this.consumed = 0;
      }
    });
    return true;
  }
}

registerProcessor('yanni-capture', YanniCaptureProcessor);
