// Port of yanni/Preview/ListeningPanel.swift (on-device turn detection design §13.1): the turn-detection tunables,
// edited live and saved with the other developer tuning values (this browser's storage, `yanni.turnTunables`), a live
// meter polled at 4 Hz while visible, a local echo test and an on-device model parity check. Probabilities and states
// only: never audio. Without the app's detector (the standalone Tuning page) it builds its own on the shared audio.
import type { AppContext } from '../app/AppContext';
import { TurnDetectionRuntime } from '../conversation/audio/TurnDetectionRuntime';
import type { ConversationTurnDetection } from '../conversation/core/TurnDetection';
import { TurnAudioWindow } from '../conversation/turn/DetectorPorts';
import { availabilityLabel } from '../conversation/turn/TurnDetectionStatus';
import { clampedTunables, makeTurnTunables, tunableThreshold, TurnAudioFormat, type TurnTunables } from '../conversation/turn/TurnTunables';
import { SileroVADModel } from '../conversation/turnml/SileroVADModel';
import { SmartTurnWorkerClient } from '../conversation/turnml/SmartTurnWorkerClient';
import { button, buttons, h, note, readout, section, slider, type Build } from './ui';

export const TUNABLES_KEY = 'yanni.turnTunables';

/** The saved tunables (the app hands them to the detector at launch), clamped; defaults when none or unreadable. */
export function savedTurnTunables(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): TurnTunables {
  try {
    const raw = storage?.getItem(TUNABLES_KEY);
    return raw ? clampedTunables(makeTurnTunables(JSON.parse(raw) as Partial<TurnTunables>)) : makeTurnTunables();
  } catch { return makeTurnTunables(); }
}

/** The live mic level, "-32 dB ▮▮▮▯▯" (a number only, never audio); "–" while closed. */
export function micLevelText(db: number | null): string {
  if (db === null || !Number.isFinite(db)) return '–';
  const bars = Math.round(Math.min(Math.max((db + 60) / 8, 0), 5));
  return `${db.toFixed(0)} dB ${'▮'.repeat(bars)}${'▯'.repeat(5 - bars)}`;
}

/** Fixture clip and reference outputs for the parity check (served by the dev server; absent in the add-on build). */
const CLIPS = '/test/conversation/fixtures/TurnClips/';

export class ListeningPreview {
  tunables: TurnTunables;
  echo = '';
  parity = '';
  private own: TurnDetectionRuntime | null = null;
  private ownMic = false;
  private signals = { speech: 0, rejected: 0 };

  constructor(readonly ctx: AppContext) { this.tunables = savedTurnTunables(); }

  /** The app's detector, else the page's own (built on first use). */
  get detector(): ConversationTurnDetection {
    const app = this.ctx.turnDetector ?? this.ctx.conversation?.turn;
    if (app) return app;
    if (!this.own) {
      const a = this.ctx.conversationAudio, eot = new SmartTurnWorkerClient();
      this.own = new TurnDetectionRuntime({ pump: a.pump, playout: a.audibility, makeVAD: () => SileroVADModel.create(), endOfTurn: eot,
        computeUnits: () => eot.provider, tunables: this.tunables });
      this.own.onSignal = (s) => {
        if (s.kind === 'speechStarted') this.signals.speech += 1;
        if (s.kind === 'selfTriggerRejected') this.signals.rejected += 1;
      };
      this.own.prepare();
    }
    return this.own;
  }

  get ownsDetector(): boolean { return !(this.ctx.turnDetector ?? this.ctx.conversation?.turn); }

  set(t: Partial<TurnTunables>): void {
    this.tunables = clampedTunables({ ...this.tunables, ...t });
    this.detector.setTunables(this.tunables);
    try { localStorage.setItem(TUNABLES_KEY, JSON.stringify(this.tunables)); } catch { /* private mode */ }
  }

  reset(): void { this.set(makeTurnTunables()); }

  /** The page's own mic (the app's conversation opens its mic itself). */
  async toggleMic(): Promise<void> {
    const a = this.ctx.conversationAudio;
    if (this.ownMic) { this.detector.setListening(false); a.stopMic(); this.ownMic = false; return; }
    await a.startMic();
    this.detector.setListening(true);
    this.ownMic = true;
  }
  get micOn(): boolean { return this.ownMic; }

  /** Echo test: 2.5 s of a voice-like buzz through the playout path (marked audible); the detector must not start a
   *  turn on it. Reports onsets and self-trigger rejections during it. */
  echoTest(): void {
    const a = this.ctx.conversationAudio, rate = a.context.sampleRate, n = Math.round(rate * 2.5);
    const x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate, f0 = 160 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
      ph += (2 * Math.PI * f0) / rate;
      const env = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.5;
      let s = 0;
      for (let k = 1; k <= 12; k++) s += Math.sin(k * ph) / k;
      x[i] = 0.18 * env * s;
    }
    const before = { ...this.signals }, rejBefore = this.detector.status.selfTriggerRejections;
    a.playPcm(x, rate);
    this.echo = `playing 2.5 s of babble (marked audible)${this.ctx.conversationAudio.micOpen ? '' : ' · open the mic to test'}`;
    setTimeout(() => {
      const st = this.detector.status;
      const speech = this.signals.speech - before.speech;
      const rejected = st.selfTriggerRejections - rejBefore;
      this.echo = `${speech === 0 ? 'pass' : 'FAIL'}: ${speech} onsets during playback · ${rejected} self-trigger rejections · `
        + `echo rule ${st.echoActive ? 'still on' : 'off'}${this.ownsDetector ? '' : ' (app detector: onsets counted by the conversation)'}`;
    }, 3500);
  }

  /** Model parity: Silero frame by frame and Smart Turn on a committed clip, against the ONNX reference outputs. */
  async parityCheck(): Promise<void> {
    this.parity = 'running…';
    try {
      const ref = await fetch(`${CLIPS}expected.json`).then((r) => { if (!r.ok) throw new Error('fixtures not served (dev server only)'); return r.json(); }) as
        { clips: { file: string; smartTurnFp32: number; sileroFrames: number[] }[] };
      const clip = ref.clips.find((c) => c.file === 'say-complete-weather.wav') ?? ref.clips[0]!;
      const pcm = wavSamples(await fetch(CLIPS + clip.file).then((r) => r.arrayBuffer()));
      const vad = await SileroVADModel.create();
      const frame = TurnAudioFormat.frameSamples;
      let worst = 0, i = 0;
      const t0 = performance.now();
      for (let o = 0; o + frame <= pcm.length; o += frame, i++) {
        const p = await vad.speechProbability(pcm.subarray(o, o + frame));
        worst = Math.max(worst, Math.abs(p - (clip.sileroFrames[i] ?? p)));
      }
      const vadMs = (performance.now() - t0) / Math.max(i, 1);
      const eot = new SmartTurnWorkerClient();
      await eot.prepare();
      const w = new TurnAudioWindow();
      const n = Math.min(pcm.length, w.count);
      w.samples.set(pcm.subarray(pcm.length - n), w.count - n);
      w.validCount = n;
      const p = await eot.completionProbability(w);
      const d = Math.abs(p - clip.smartTurnFp32);
      const ok = worst <= 0.02 && d <= 0.02;
      this.parity = `${ok ? 'pass' : 'FAIL'} · Silero max |Δp| ${worst.toFixed(4)} over ${i} frames (${vadMs.toFixed(2)} ms/frame) · `
        + `Smart Turn ${eot.provider ?? '?'} p ${p.toFixed(4)} vs ${clip.smartTurnFp32.toFixed(4)} (|Δ| ${d.toFixed(4)}, ${eot.lastMs.toFixed(0)} ms)`;
    } catch (e) {
      this.parity = `unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

/** 16-bit PCM WAV → float samples (the data chunk only). */
export function wavSamples(buf: ArrayBuffer): Float32Array {
  const d = new DataView(buf);
  let o = 12;
  while (o + 8 <= d.byteLength) {
    const id = String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));
    const size = d.getUint32(o + 4, true);
    if (id === 'data') {
      const out = new Float32Array(size >> 1);
      for (let i = 0; i < out.length; i++) out[i] = d.getInt16(o + 8 + 2 * i, true) / 32768;
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

export function listeningSection(lp: ListeningPreview, b: Build): HTMLElement {
  const t = () => lp.tunables;
  const fill = h('div', { class: 'fill' }), mark = h('div', { class: 'mark' }), boost = h('div', { class: 'mark boost' });
  const meter = h('div', { class: 'pv-meter' }, fill, mark, boost);
  meter.setAttribute('role', 'meter');
  b.poll.add(() => {
    const s = lp.detector.status, p = Math.min(Math.max(s.vadProbability, 0), 1);
    fill.style.width = `${p * 100}%`;
    fill.classList.toggle('on', p >= t().vadThreshold);
    mark.style.left = `${t().vadThreshold * 100}%`;
    boost.style.left = `${tunableThreshold(t(), true) * 100}%`;
    meter.setAttribute('aria-valuenow', p.toFixed(2));
  });
  const frames = (label: string, k: 'minSpeech' | 'echoMinSpeech', range: readonly [number, number]) =>
    slider(label, () => Math.round(t()[k] / TurnAudioFormat.frameDuration), (v) => lp.set({ [k]: Math.round(v) * TurnAudioFormat.frameDuration }),
      range, (v) => `${Math.round(v)} frames`, 1);
  const num = (label: string, k: 'vadThreshold' | 'echoThresholdBoost' | 'echoTail' | 'stopSecs' | 'completionThreshold' | 'fallbackSilence',
    range: readonly [number, number], fmt: (v: number) => string) => slider(label, () => t()[k], (v) => lp.set({ [k]: v }), range, fmt);
  const micButton = button(lp.micOn ? 'Close mic' : 'Open mic (local)', () => {
    void lp.toggleMic().then(() => { micButton.textContent = lp.micOn ? 'Close mic' : 'Open mic (local)'; },
      (e: unknown) => { lp.echo = `mic failed: ${String(e)}`; });
  });
  return section('Listening',
    readout(b, () => { const s = lp.detector.status; return `Turn detection: ${availabilityLabel(s.availability)}${s.computeUnits ? ` · ${s.computeUnits}` : ''}`; }),
    readout(b, () => `VAD probability ${lp.detector.status.vadProbability.toFixed(2)}`, 'pv-note'),
    meter,
    readout(b, () => { const s = lp.detector.status; return `Mic level ${micLevelText(s.micLevelDB)} · ${s.echoActive ? 'Echo rule on' : 'Echo rule off'} · State: ${s.phase}`; }),
    num('VAD threshold', 'vadThreshold', [0.3, 0.9], (v) => v.toFixed(2)),
    frames('Minimum speech', 'minSpeech', [1, 8]),
    num('Echo threshold boost', 'echoThresholdBoost', [0, 0.35], (v) => `+${v.toFixed(2)}`),
    frames('Echo minimum speech', 'echoMinSpeech', [1, 10]),
    num('Echo tail', 'echoTail', [0, 1], (v) => `${v.toFixed(2)} s`),
    num('Stop seconds', 'stopSecs', [0.1, 0.6], (v) => `${v.toFixed(2)} s`),
    num('Smart Turn completion threshold', 'completionThreshold', [0.3, 0.9], (v) => v.toFixed(2)),
    num('Fallback silence', 'fallbackSilence', [1, 6], (v) => `${v.toFixed(1)} s`),
    button('Reset to defaults', () => { lp.reset(); b.rebuild(); }),
    readout(b, () => {
      const s = lp.detector.status, ms = (v: number | null) => (v === null ? '–' : `${v.toFixed(0)} ms`);
      return `Smart Turn last ${ms(s.smartTurnLastMs)} · p50 ${ms(s.smartTurnP50Ms)} · ${s.smartTurnRuns} runs · self-trigger rejections ${s.selfTriggerRejections}`;
    }, 'pv-note'),
    lp.ownsDetector ? micButton : note('The conversation owns the mic; the meter reads its detector.'),
    buttons(['Echo test', () => lp.echoTest()], ['Model parity check', () => void lp.parityCheck()]),
    readout(b, () => lp.echo),
    readout(b, () => lp.parity)
  );
}
