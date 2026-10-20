// The turn-detection tuning page (web/turn-demo.html): live VAD probability, mic level, turn phase, Smart Turn
// verdicts and the Listening tunables, for tuning by ear. Dev only (`npm run dev`, then /turn-demo.html).
import { ConversationAudio } from '../audio/ConversationAudio';
import { TurnDetectionRuntime } from '../audio/TurnDetectionRuntime';
import { availabilityLabel } from '../turn/TurnDetectionStatus';
import type { TurnSignal } from '../turn/TurnSignal';
import { EchoWindow, makeTurnTunables, tunableThreshold, TurnTunablesStatics, type TurnTunables } from '../turn/TurnTunables';
import { ModelCatalog } from '../turnml/ModelCatalog';
import { SileroVADModel } from '../turnml/SileroVADModel';
import { SmartTurnWorkerClient } from '../turnml/SmartTurnWorkerClient';
import { hostNow } from '../audio/TurnAudioPump';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const audio = new ConversationAudio();
const eot = new SmartTurnWorkerClient();
let tunables: TurnTunables = makeTurnTunables();
const rt = new TurnDetectionRuntime({
  pump: audio.pump, playout: audio.audibility, makeVAD: () => SileroVADModel.create(), endOfTurn: eot,
  computeUnits: () => eot.provider, tunables,
});
// Window (s) the plot shows, and its history at the frame rate.
const SPAN = 10;
const hist: { t: number; p: number; echo: boolean }[] = [];
let lastLevel = 0, lastDB = -120;

rt.onSignal = (s) => logSignal(s);
audio.onLevel = (l, db) => { lastLevel = l; lastDB = db; };
audio.onFrame = (_samples, end) => {
  // Plotted one frame late (the VAD runs on the chain); good enough by eye.
  const a = audio.audibility;
  hist.push({ t: end, p: rt.vadProbability, echo: end - 0.032 < EchoWindow.until(a.lastLoudHostTime(end), a.outputLatency, -Infinity, tunables.echoTail) });
  while (hist.length && hist[0].t < end - SPAN) hist.shift();
};
rt.prepare();

function log(line: string): void {
  const el = $('log');
  const t = new Date().toLocaleTimeString([], { hour12: false });
  el.textContent = `${t}  ${line}\n` + (el.textContent ?? '').slice(0, 20_000);
}

function logSignal(s: TurnSignal): void {
  const ago = (t: number) => `${((hostNow() - t) * 1000).toFixed(0)} ms ago`;
  switch (s.kind) {
    case 'speechStarted': log(`speech started (${ago(s.at)}${s.echoRule ? ', echo rule' : ''})`); break;
    case 'pause': log(`pause: Smart Turn ${s.pause.probability === null ? 'failed / timed out' : `p ${s.pause.probability.toFixed(2)} → incomplete`}${s.pause.inferenceMs !== null ? `, ${s.pause.inferenceMs.toFixed(0)} ms` : ''}`); break;
    case 'turnEnded': {
      const e = s.end;
      const why = e.reason.kind === 'complete' ? `complete p ${e.reason.probability.toFixed(2)}` : 'silence fallback';
      log(`TURN END: ${why}, verdict ${((e.verdictAt - e.speechEnd) * 1000).toFixed(0)} ms after speech end${e.inferenceMs !== null ? `, Smart Turn ${e.inferenceMs.toFixed(0)} ms` : ''}`);
      break;
    }
    case 'turnDiscarded': log('turn discarded (mic closed)'); break;
    case 'selfTriggerRejected': log(`self-trigger rejected (peak ${s.peak.toFixed(2)})`); break;
    case 'unavailable': log(`UNAVAILABLE: ${s.reason}`); break;
  }
}

// MARK: Controls

$('start').onclick = async () => {
  try { await audio.startMic(); rt.setListening(true); $('msg').textContent = `mic open at ${audio.context.sampleRate} Hz`; }
  catch (e) { $('msg').textContent = `mic failed: ${e}`; }
};
$('stop').onclick = () => { rt.setListening(false); audio.stopMic(); $('msg').textContent = 'mic closed'; };

$('babble').onclick = () => {
  // 2.5 s of a voice-like buzz (harmonics of a gliding 160 Hz, syllable-rate envelope) through the playout path.
  const rate = audio.context.sampleRate, n = Math.round(rate * 2.5);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, f0 = 160 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    ph += (2 * Math.PI * f0) / rate;
    const env = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.5;
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(h * ph) / h;
    x[i] = 0.18 * env * s;
  }
  audio.playPcm(x, rate);
  log('playing babble (marked audible)');
};

$('say').onclick = () => {
  // Browser TTS doesn't go through Web Audio: mark it audible from start to end by its events.
  const u = new SpeechSynthesisUtterance('Hi there! It looks like a lovely afternoon. Do you want me to turn on the lights?');
  u.onstart = () => audio.markPlayout(hostNow(), hostNow() + 30);
  u.onend = () => audio.audibility.cutAfter(hostNow());
  speechSynthesis.speak(u);
  log('speaking a sentence (marked audible)');
};

$('bench').onclick = async () => {
  $('msg').textContent = 'benchmarking…';
  try {
    const res = await fetch('/test/conversation/fixtures/TurnClips/say-complete-weather.wav');
    const d = new DataView(await res.arrayBuffer());
    const n = (d.byteLength - 44) >> 1;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = d.getInt16(44 + 2 * i, true) / 32768;
    const vad = await SileroVADModel.create();
    let t = performance.now(), frames = 0;
    for (let r = 0; r < 5; r++) {
      vad.reset();
      for (let i = 0; i + 512 <= n; i += 512, frames++) await vad.speechProbability(pcm.subarray(i, i + 512));
    }
    const vadMs = (performance.now() - t) / frames;
    await eot.prepare();
    const win = { samples: new Float32Array(128_000), validCount: Math.min(n, 128_000), count: 128_000 };
    win.samples.set(pcm.subarray(Math.max(0, n - 128_000)), 128_000 - Math.min(n, 128_000));
    const round: number[] = [], worker: number[] = [];
    let p = 0;
    for (let r = 0; r < 12; r++) {
      t = performance.now();
      p = await eot.completionProbability(win);
      round.push(performance.now() - t);
      worker.push(eot.lastMs);
    }
    round.sort((a, b) => a - b); worker.sort((a, b) => a - b);
    const line = `bench: Silero ${vadMs.toFixed(3)} ms/frame (wasm, main thread) · Smart Turn ${eot.provider} p50 ${worker[6].toFixed(1)} ms in worker, ${round[6].toFixed(1)} ms round trip, load+warm ${eot.loadMs.toFixed(0)} ms · p ${p.toFixed(4)} (ref 0.9866)`;
    log(line);
    $('msg').textContent = line;
    (window as unknown as { benchResult: string }).benchResult = line;
  } catch (e) {
    $('msg').textContent = `bench failed: ${e}`;
    (window as unknown as { benchResult: string }).benchResult = `failed: ${e}`;
  }
};

// MARK: Tunables

const sliders: [keyof TurnTunables, string, number, number, number][] = [
  ['vadThreshold', 'VAD threshold', 0.3, 0.9, 0.01],
  ['minSpeech', 'Min speech (s)', 0.032, 0.256, 0.032],
  ['echoThresholdBoost', 'Echo boost', 0, 0.35, 0.01],
  ['echoMinSpeech', 'Echo min speech (s)', 0.032, 0.32, 0.032],
  ['echoTail', 'Echo tail (s)', 0, 1, 0.05],
  ['stopSecs', 'Stop silence (s)', 0.1, 0.6, 0.032],
  ['completionThreshold', 'Completion p', 0.3, 0.9, 0.01],
  ['fallbackSilence', 'Fallback silence (s)', 1, 6, 0.1],
];
for (const [key, label, lo, hi, step] of sliders) {
  const row = document.createElement('label');
  row.className = 't';
  row.innerHTML = `<span>${label}</span><input type="range" min="${lo}" max="${hi}" step="${step}" value="${tunables[key]}"><output>${(+tunables[key]).toFixed(3)}</output>`;
  const input = row.querySelector('input')!, out = row.querySelector('output')!;
  input.oninput = () => {
    tunables = { ...tunables, [key]: +input.value };
    out.textContent = (+input.value).toFixed(3);
    rt.setTunables(tunables);
  };
  $('tunables').append(row);
}
const reset = document.createElement('button');
reset.textContent = 'Defaults';
reset.onclick = () => { tunables = makeTurnTunables(); rt.setTunables(tunables); for (const [i, [k]] of sliders.entries()) {
  const row = $('tunables').children[i] as HTMLElement;
  row.querySelector('input')!.value = String(tunables[k]);
  row.querySelector('output')!.textContent = (+tunables[k]).toFixed(3);
} };
$('tunables').append(reset);

// MARK: Render

const canvas = $<HTMLCanvasElement>('plot');
const g = canvas.getContext('2d')!;
function draw(): void {
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio), h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  g.clearRect(0, 0, w, h);
  const now = hostNow();
  const x = (t: number) => ((t - (now - SPAN)) / SPAN) * w, y = (p: number) => h - p * h;
  g.fillStyle = 'rgba(255,179,92,0.18)';
  for (const s of hist) if (s.echo) g.fillRect(x(s.t - 0.032), 0, Math.max(1, (0.032 / SPAN) * w), h);
  const thr = tunableThreshold(tunables, false);
  g.strokeStyle = '#7be08f'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, y(thr)); g.lineTo(w, y(thr)); g.stroke();
  g.strokeStyle = '#4a5260'; g.beginPath(); g.moveTo(0, y(thr - TurnTunablesStatics.hysteresis)); g.lineTo(w, y(thr - TurnTunablesStatics.hysteresis)); g.stroke();
  g.setLineDash([]); g.strokeStyle = '#6cc4ff'; g.lineWidth = 2 * devicePixelRatio; g.beginPath();
  hist.forEach((s, i) => (i ? g.lineTo(x(s.t), y(s.p)) : g.moveTo(x(s.t), y(s.p))));
  g.stroke(); g.lineWidth = 1;

  const p = rt.vadProbability, st = rt.status, phase = rt.phase;
  $('pv').textContent = p.toFixed(2);
  $('pbar').style.width = `${p * 100}%`;
  $('lv').textContent = lastLevel.toFixed(2);
  $('ldb').textContent = audio.micOpen ? `${lastDB.toFixed(0)} dBFS` : '';
  $('lbar').style.width = `${(audio.micOpen ? lastLevel : 0) * 100}%`;
  const ph = $('phase'); ph.textContent = phase; ph.className = `phase ${phase}`;
  const rows: [string, string][] = [
    ['models', availabilityLabel(st.availability)],
    ['Smart Turn EP', st.computeUnits ?? '—'],
    ['Smart Turn last / p50', `${st.smartTurnLastMs?.toFixed(0) ?? '—'} / ${st.smartTurnP50Ms?.toFixed(0) ?? '—'} ms (${st.smartTurnRuns} runs)`],
    ['threshold now', `${st.threshold.toFixed(2)}${st.echoActive ? ' (echo rule)' : ''}`],
    ['self-trigger rejections', String(st.selfTriggerRejections)],
    ['gaps', String(st.gaps)],
    ['model files', `${ModelCatalog.entries.SileroVAD.file}, ${ModelCatalog.entries.SmartTurn.file}`],
  ];
  $('status').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
