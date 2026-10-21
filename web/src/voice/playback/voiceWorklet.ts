// The voice AudioWorklet (port-note: stands in for VoiceAudioHost's AVAudioSourceNode render blocks). Two ported
// `VoiceRenderer`s — the chirps and the babble reply — render every 128-frame quantum on the audio thread and are
// summed (the Swift host mixes two source nodes the same way). The main thread drives them through
// `VoiceRendererPort` messages. Loaded with `audioWorklet.addModule(url)` from `voiceWorklet.ts?worker&url`.
import { VoiceRenderer } from '../dsp/VoiceRenderer';
import { VoiceFingerprint } from '../model/VoiceFingerprint';
import { phraseFromData, type FromWorklet, type RendererId, type ToWorklet } from './protocol';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class YanniVoiceProcessor extends AudioWorkletProcessor {
  private readonly renderers: Record<RendererId, VoiceRenderer> = {
    chirp: new VoiceRenderer(sampleRate), reply: new VoiceRenderer(sampleRate),
  };
  private readonly scratch = new Float32Array(128);
  private offset = 0;
  private readonly seen: Record<RendererId, { id: number; hostTime: number; sounding: boolean }> = {
    chirp: { id: -1, hostTime: 0, sounding: false }, reply: { id: -1, hostTime: 0, sounding: false },
  };

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.handle(e.data);
  }

  private handle(m: ToWorklet): void {
    if (m.t === 'hostOffset') { this.offset = m.offset; return; }
    const r = this.renderers[m.r];
    switch (m.t) {
      case 'enqueue': r.enqueue(phraseFromData(m.phrase), m.start, m.stretch); break;
      case 'cancelAll': r.cancelAll(); break;
      case 'setVolume': r.setVolume(m.v); break;
      case 'setMuted': r.setMuted(m.v); break;
      case 'setGain': r.setGain(m.v); break;
      case 'setFingerprint':
        r.setFingerprint(Object.assign(new VoiceFingerprint(), { basePitchHz: m.basePitchHz, maxPitchHz: m.maxPitchHz, loudness: m.loudness }));
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const host = currentTime + this.offset;
    const n = out.length;
    if (this.scratch.length < n) return true;
    this.renderers.chirp.render(n, host, out);
    this.renderers.reply.render(n, host, this.scratch);
    for (let i = 0; i < n; i++) out[i] += this.scratch[i];
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    this.report('chirp');
    this.report('reply');
    return true;
  }

  /// Phrase starts (for the director's re-timing) and the sounding flag, posted only when they change.
  private report(id: RendererId): void {
    const r = this.renderers[id], s = this.seen[id];
    const st = r.lastStarted();
    if (st && (st.id !== s.id || st.hostTime !== s.hostTime)) {
      s.id = st.id; s.hostTime = st.hostTime;
      this.port.postMessage({ t: 'started', r: id, id: st.id, hostTime: st.hostTime } satisfies FromWorklet);
    }
    if (r.isSounding !== s.sounding) {
      s.sounding = r.isSounding;
      this.port.postMessage({ t: 'sounding', r: id, v: s.sounding } satisfies FromWorklet);
    }
  }
}

registerProcessor('yanni-voice', YanniVoiceProcessor);
