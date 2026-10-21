// The browser's PerceptionModel (Swift app's Perception/PerceptionModel.swift + CameraCapture.swift): the front camera,
// the frame gate (one frame in flight, frames dropped rather than queued), the perception worker, the tier policy every
// 5 s, the camera offset, the life cycle's camera mode and bedtime, and the coordinator that applies everything to the
// face. The kiosk calls `startPerception(engine, life)`; the demo page passes its own <video> to show it.
import type { V2 } from '../../core/vec';
import type { FaceEngine } from '../../engine/FaceEngine';
import type { LifeCycleController } from '../../life/LifeCycleController';
import type { FrameStats } from '../../render/FrameStats';
import { CameraOffsetTable, type InterfaceOrientation } from '../CameraGeometry';
import type { PerceptionRecording } from '../Replay';
import { ReplaySource } from '../ReplaySource';
import { SyntheticScenes } from '../SyntheticScenes';
import { PerceptionCoordinator, perceptionFace, perceptionLife, type PeopleSource } from '../PerceptionCoordinator';
import { PerceptionSettings } from '../PerceptionSettings';
import {
  CameraStatus, PerceptionTier, type PerceptionEvent, type PerceptionOutput, type PerceptionSnapshot,
} from '../PerceptionTypes';
import { FrameGate, PressureLevel, TierPolicy } from '../TierPolicy';
import type { Delegate } from './MediaPipeDetector';
import { PerceptionPipeline, type FrameRequest, type FrameResult, type PipelineInit } from './PerceptionPipeline';
import type { ToWorker } from './perception.worker';

export interface PerceptionOptions {
  settings?: PerceptionSettings;
  /** A <video> to show the camera in (the demo); otherwise a detached one is made. */
  video?: HTMLVideoElement;
  /** Camera position from the screen centre (metres, x + viewer's right, y + down) in the current orientation, as
   *  mounted. Default: the settings' measured `cameraOffsetOverride` (portrait frame, rotated with
   *  `screen.orientation`), else a tablet's camera centred on the landscape top edge. The field of view is the
   *  settings' `horizontalFovDegrees` (measured by the calibration flow). */
  cameraOffset?: V2 | null;
  gazeFromBlendshapes?: boolean;
  delegate?: Delegate;
  /** Run MediaPipe in a module worker (default) or on the main thread. */
  worker?: boolean;
  /** The face's frame delivery: the tier policy's "perception costs the face frames" input. */
  frameStats?: FrameStats;
  /** The hardware tier (never exceeded). Default full. */
  tierCeiling?: PerceptionTier;
  /** Capture size (4:3). Default 1280×960. */
  width?: number;
  height?: number;
}

export interface PerceptionRuntimeStats {
  camera: CameraStatus;
  tier: PerceptionTier;
  delegate: Delegate | null;
  worker: boolean;
  /** Analysed frames per second over the last policy window, and the last second. */
  analysisFPS: number;
  hz: number;
  /** Latest stage milliseconds (rects = pose, landmarks = face, hands, body, motion, logic) and the window p90. */
  stageMs: Record<string, number>;
  p90Ms: number;
  /** Whole seconds the running camera has delivered no frame (null while frames flow). */
  noFramesFor: number | null;
  /** Camera frames that arrived, were analysed, were dropped because one was in flight (since start). */
  arrived: number; accepted: number; droppedBusy: number;
  cameraOffset: V2;
  video: { width: number; height: number };
  /** The people source in use, and the pressure the tier policy saw (the governor's cap included). */
  source: PeopleSource;
  pressure: PressureLevel;
  /** Frames that arrived while one was in flight, over the last policy window. */
  lateFraction: number;
}

/** What drives the coordinator: the camera, a recording replayed (null: the synthetic Simulator demo), or nothing
 *  (the gaze pad). */
export type PerceptionSourceChoice = { kind: 'camera' } | { kind: 'replay'; recording: PerceptionRecording | null } | { kind: 'simulated' };

export interface PerceptionHandle {
  readonly coordinator: PerceptionCoordinator;
  readonly video: HTMLVideoElement;
  stop(): void;
  setSettings(s: PerceptionSettings): void;
  /** Every perception event with what the coordinator did about it; returns the unsubscribe. */
  onEvent(cb: (e: PerceptionEvent, note: string | null) => void): () => void;
  /** Called with every analysed frame's output (the demo's overlay); returns the unsubscribe. */
  onFrame(cb: (out: PerceptionOutput, r: FrameResult) => void): () => void;
  snapshot(): PerceptionSnapshot;
  stats(): PerceptionRuntimeStats;
  /** Override the camera offset (current orientation, metres), or null for the settings' / default one. */
  setCameraOffset(o: V2 | null): void;
  /** Swap the people source (Swift PerceptionModel.source). */
  setSource(s: PerceptionSourceChoice): void;
  /** The kiosk resource governor's pressure cap (worst input wins with the camera's own pressure). */
  setGovernorPressure(level: number): void;
}

const now = (): number => performance.now() / 1000;

/** getUserMedia / track errors → CameraStatus (Swift CameraCapture's statuses). */
export function cameraErrorStatus(e: unknown): CameraStatus {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError': case 'SecurityError': return CameraStatus.denied;
    case 'NotReadableError': return CameraStatus.unavailable('in use by another app');
    case 'AbortError': return CameraStatus.interrupted('aborted');
    case 'NotFoundError': case 'OverconstrainedError': return CameraStatus.unavailable('no camera');
    default: return CameraStatus.unavailable(e instanceof Error ? e.message : 'camera failed');
  }
}

/** `screen.orientation.type` → the UIKit orientation the offset table rotates by (landscape-primary: camera on top). */
export function interfaceOrientation(type: string | undefined): InterfaceOrientation {
  switch (type) {
    case 'portrait-primary': return 'portrait';
    case 'portrait-secondary': return 'portraitUpsideDown';
    case 'landscape-secondary': return 'landscapeRight';
    default: return 'landscapeLeft';
  }
}

/// The default camera offset: a long-edge camera (landscape top, like the M4 iPads) on a screen whose short side is
/// `min(screen.width, screen.height)` CSS px at 132 px per inch (an iPad's points), plus the table's 1 cm bezel:
/// −(short / 2 + 0.01) m above the centre in landscape-primary, rotated for the current orientation.
// shortcut: CSS px per inch is a tablet guess (iPad 132; Android tablets ~160); set `cameraOffset` once measured.
export function defaultCameraOffset(screenW: number, screenH: number, orientation: InterfaceOrientation): V2 {
  const short = Math.min(screenW, screenH) / (132 / 0.0254);
  const portrait = { x: CameraOffsetTable.unknownIPadOffset(short).y, y: 0 };   // on the portrait left edge
  return CameraOffsetTable.offset(portrait, orientation);
}

interface Analyser { analyse(r: FrameRequest): Promise<FrameResult>; close(): void; delegate: Delegate }

/** The worker (preferred) or, if it can't start MediaPipe, the same pipeline on the main thread. */
async function startAnalyser(init: PipelineInit, useWorker: boolean): Promise<Analyser & { worker: boolean }> {
  if (useWorker) {
    const w = new Worker(new URL('./perception.worker.ts', import.meta.url), { type: 'module', name: 'perception' });
    let pending: { ok: (r: FrameResult) => void; fail: (e: Error) => void } | null = null;
    try {
      const delegate = await new Promise<Delegate>((ok, fail) => {
        w.onerror = (e) => fail(new Error(e.message || 'worker failed to load'));
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'ready') ok(m.delegate);
          else if (m.type === 'failed') fail(new Error(m.error));
          else if (m.type === 'result') { pending?.ok(m.result); pending = null; }
          else if (m.type === 'error') { pending?.fail(new Error(m.error)); pending = null; }
        };
        w.postMessage({ type: 'init', init } satisfies ToWorker);
      });
      return {
        worker: true, delegate, close: () => w.terminate(),
        analyse: (r) => new Promise((ok, fail) => {
          pending = { ok, fail };
          w.postMessage({ type: 'frame', ...r } satisfies ToWorker, [r.bitmap]);
        }),
      };
    } catch (e) {
      w.terminate();
      console.warn(`perception: worker unavailable (${e instanceof Error ? e.message : String(e)}), running on the main thread`);
    }
  }
  const p = await PerceptionPipeline.create(init);
  return { worker: false, delegate: p.detector.delegate, close: () => p.detector.close(), analyse: (r) => p.analyse(r) };
}

export function startPerception(engine: FaceEngine, life: LifeCycleController | null, opts: PerceptionOptions = {}): PerceptionHandle {
  const settings = (opts.settings ?? new PerceptionSettings()).validated();
  const coordinator = new PerceptionCoordinator(perceptionFace(engine), life ? perceptionLife(life) : null, settings, now);
  coordinator.source = 'camera';
  const video = opts.video ?? Object.assign(document.createElement('video'), { muted: true, playsInline: true });
  video.muted = true;
  video.playsInline = true;
  const ceiling = opts.tierCeiling ?? PerceptionTier.full;
  const policy = new TierPolicy(ceiling, tierFor(settings.tierOverride));
  let tier = policy.current;
  let cameraStatus: CameraStatus = CameraStatus.stopped;
  let offsetOverride = opts.cameraOffset ?? null;
  let source: PeopleSource = 'camera';
  let replay: ReplaySource | null = null;
  let replayTimer: ReturnType<typeof setInterval> | undefined;
  let governorPressure: PressureLevel = PressureLevel.nominal, pressure: PressureLevel = PressureLevel.nominal;
  let lateFraction = 0;
  let offset: V2 = { x: 0, y: 0 };
  let stream: MediaStream | null = null;
  let analyser: (Analyser & { worker: boolean }) | null = null;
  let stopped = false;
  let paused = false;
  let probeUntil: number | null = null;
  let offAtBedtime = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const gate = new FrameGate();
  let inFlight = false, analysisFPS = 15, captureFPS = 30, index = 0;
  let arrived = 0, accepted = 0, droppedBusy = 0, winArrived = 0, winBusy = 0;
  let lastFrameAt = 0, cameraStartedAt = 0;
  const totals: number[] = [];
  const doneAt: number[] = [];
  let windowFrames = 0, windowFPS = 0, stageMs: Record<string, number> = {}, p90 = 0;
  let lastDelivered = 0, lastRequested = 0, warmedUp = false;
  const frameListeners = new Set<(out: PerceptionOutput, r: FrameResult) => void>();

  const setStatus = (s: CameraStatus) => { cameraStatus = s; coordinator.noteCameraStatus(s); };

  // ---- Camera offset (rotated with the orientation unless overridden) ----
  function pushCameraOffset(): void {
    const orientation = interfaceOrientation(screen.orientation?.type);
    const measured = coordinator.settings.cameraOffsetOverride;
    offset = offsetOverride ?? (measured ? CameraOffsetTable.offset(measured, orientation) : defaultCameraOffset(screen.width, screen.height, orientation));
    coordinator.setCameraOffset(offset);
  }
  pushCameraOffset();
  const onOrientation = () => pushCameraOffset();
  screen.orientation?.addEventListener('change', onOrientation);

  // ---- Life cycle: camera mode, and the camera off while asleep at bedtime (when the setting says so) ----
  const previousPhase = life?.onPhaseChange ?? null;
  const lifeChanged = () => {
    coordinator.lifeChanged();
    if (!life) return;
    const off = coordinator.settings.cameraOffWhenAsleepAtBedtime && life.phase === 'asleep' && life.isBedtime &&
      !life.settings.wakeOnMotionAtBedtime;
    if (off === offAtBedtime) return;
    offAtBedtime = off;
    if (source !== 'camera') return;
    if (off) { stopCamera(); setStatus(CameraStatus.offAtBedtime); } else void startCamera();
  };
  const ourPhase = (c: Parameters<NonNullable<LifeCycleController['onPhaseChange']>>[0]) => { previousPhase?.(c); lifeChanged(); };
  if (life) life.onPhaseChange = ourPhase;
  coordinator.lifeChanged();

  // ---- Camera ----
  function stopCamera(): void {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  function scheduleRetry(): void {
    clearTimeout(retry);
    retry = setTimeout(() => { if (!stopped && !offAtBedtime) void startCamera(); }, 60_000);
  }

  async function startCamera(): Promise<void> {
    if (stopped || offAtBedtime || source !== 'camera') return;
    stopCamera();
    setStatus(CameraStatus.starting);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: 'user', width: { ideal: opts.width ?? 1280 }, height: { ideal: opts.height ?? 960 },
        aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 30 } } });
    } catch (e) {
      const s = cameraErrorStatus(e);
      setStatus(s);
      if (s.kind !== 'denied') scheduleRetry();
      return;
    }
    if (stopped || source !== 'camera') { stopCamera(); return; }
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (stream?.getVideoTracks()[0] === track) { setStatus(CameraStatus.unavailable('camera disconnected')); scheduleRetry(); } });
    track.addEventListener('mute', () => setStatus(CameraStatus.interrupted('muted')));
    track.addEventListener('unmute', () => setStatus(CameraStatus.running));
    video.srcObject = stream;
    try { await video.play(); } catch (e) { setStatus(cameraErrorStatus(e)); return; }
    captureFPS = 30;
    cameraStartedAt = now();
    setStatus(document.visibilityState === 'hidden' ? CameraStatus.interrupted('hidden') : CameraStatus.running);
    video.requestVideoFrameCallback(onVideoFrame);
  }

  // ---- Frames: gate → bitmap → analyser → coordinator ----
  function onVideoFrame(_t: number, meta: VideoFrameCallbackMetadata): void {
    if (stopped || !stream) return;
    video.requestVideoFrameCallback(onVideoFrame);
    const t = now();
    // captureTime is in the page's performance timeline when the browser gives it.
    const time = meta.captureTime !== undefined && Math.abs(meta.captureTime / 1000 - t) < 1 ? meta.captureTime / 1000 : t;
    arrived++; winArrived++;
    lastFrameAt = t;
    if (paused || probeUntil !== null || !analyser) return;
    if (inFlight) { droppedBusy++; winBusy++; }
    if (!gate.shouldAnalyse(time, analysisFPS, inFlight)) return;
    inFlight = true;
    accepted++;
    void analyseFrame(time);
  }

  async function analyseFrame(time: number): Promise<void> {
    try {
      const bitmap = await createImageBitmap(video);
      const r = await analyser!.analyse({ bitmap, time, index: ++index, commands: coordinator.mailbox.drain() });
      if (stopped || source !== 'camera') return;
      analysisFPS = r.analysisFPS;
      if (r.captureFPS !== captureFPS) {
        captureFPS = r.captureFPS;
        void stream?.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: captureFPS } }).catch(() => {});
      }
      totals.push(r.totalMs);
      if (totals.length > 300) totals.shift();
      stageMs = r.stages;
      windowFrames++;
      doneAt.push(now());
      if (doneAt.length > 60) doneAt.shift();
      coordinator.ingest(r.out, 'camera');
      for (const f of frameListeners) f(r.out, r);
    } catch (e) {
      console.warn(`perception: frame failed (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      inFlight = false;
    }
  }

  // ---- Tab hidden: pause analysis (the camera keeps its permission) ----
  const onVisibility = () => {
    if (stopped || !stream) return;
    paused = document.visibilityState === 'hidden';
    setStatus(paused ? CameraStatus.interrupted('hidden') : CameraStatus.running);
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- Tier policy every 5 s (Swift PerceptionModel.evaluatePolicy) ----
  const policyTimer = setInterval(() => {
    const t = now();
    let drop = 0;
    if (opts.frameStats) {
      const fs = opts.frameStats.snapshot();
      const requested = fs.asleep.requested + fs.awake.requested + fs.burst.requested;
      const dD = fs.frames - lastDelivered, dR = requested - lastRequested;
      lastDelivered = fs.frames; lastRequested = requested;
      drop = dR > 0 ? Math.max(0, 1 - dD / dR) : 0;
    }
    if (probeUntil !== null) {
      if (t >= probeUntil) { probeUntil = null; policy.noteProbe(drop, t); }
      return;
    }
    // The first window after MediaPipe starts (shader compiles, graph warm-up) says nothing about the tier's cost.
    const counts = warmedUp;
    warmedUp = analyser !== null;
    const sorted = totals.slice().sort((a, b) => a - b);
    p90 = sorted.length ? sorted[Math.min(Math.trunc(sorted.length * 0.9), sorted.length - 1)] : 0;
    totals.length = 0;
    windowFPS = windowFrames / TierPolicy.interval;
    windowFrames = 0;
    const late = winArrived > 0 ? winBusy / winArrived : 0;
    winArrived = 0; winBusy = 0;
    lateFraction = late;
    if (!stream || paused || !counts) return;
    // The browser's own thermal state reaches perception only through the kiosk governor's cap (setGovernorPressure).
    const level = governorPressure;
    if (level !== pressure) coordinator.mailbox.post({ kind: 'pressure', level });
    pressure = level;
    const d = policy.evaluate({ p90Ms: p90, lateFraction: late, displayDropRate: drop, pressure: level,
      vacant: coordinator.latest.stats.vacant }, t);
    switch (d.kind) {
      case 'change': coordinator.noteTierChange(tier, d.to, d.reason); tier = d.to; break;
      case 'requestProbe': probeUntil = t + TierPolicy.probeSeconds; break;
      case 'stopCamera': stopCamera(); setStatus(CameraStatus.pressure(d.reason)); scheduleRetry(); break;
      case 'keep': break;
    }
  }, TierPolicy.interval * 1000);

  // ---- Replay (Swift startReplay / replayTick): a recording through a fresh processor at 15 Hz, looping ----
  function stopReplay(): void { clearInterval(replayTimer); replayTimer = undefined; replay = null; }
  function startReplay(recording: PerceptionRecording | null): void {
    const rec = recording ?? SyntheticScenes.simulatorDemo.recording();
    replay = new ReplaySource(rec, coordinator.settings, tier, now());
    setStatus(CameraStatus.running);
    replayTimer = setInterval(() => {
      if (!replay) return;
      for (const { out, detections } of replay.tick(now(), coordinator.mailbox.drain())) {
        coordinator.ingest(out, 'replay');
        const r: FrameResult = { out, detections, stages: {}, totalMs: 0, analysisFPS: 15, captureFPS: 15 };
        for (const f of frameListeners) f(out, r);
      }
    }, 1000 / 15);
  }

  // ---- Start ----
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  void startAnalyser({
    base: new URL(base, location.href).href, delegate: opts.delegate ?? 'GPU', settings: settings.toJSON(),
    cameraOffset: offset, tier, lowMode: life?.cameraMode === 'low', mirrored: true,
    gazeFromBlendshapes: opts.gazeFromBlendshapes ?? false,
  }, opts.worker ?? true).then((a) => {
    if (stopped) { a.close(); return; }
    analyser = a;
  }, (e) => {
    console.error(`perception: MediaPipe failed to start (${e instanceof Error ? e.message : String(e)})`);
    setStatus(CameraStatus.unavailable('perception failed to start'));
  });
  void startCamera();

  return {
    coordinator, video,
    stop() {
      if (stopped) return;
      stopped = true;
      stopCamera();
      clearInterval(policyTimer);
      clearTimeout(retry);
      stopReplay();
      analyser?.close();
      document.removeEventListener('visibilitychange', onVisibility);
      screen.orientation?.removeEventListener('change', onOrientation);
      if (life?.onPhaseChange === ourPhase) life.onPhaseChange = previousPhase;
      coordinator.source = 'simulated';
      setStatus(CameraStatus.stopped);
    },
    setSettings(s) {
      const v = s.validated();
      const overrideChanged = v.tierOverride !== coordinator.settings.tierOverride;
      const offsetChanged = JSON.stringify(v.cameraOffsetOverride) !== JSON.stringify(coordinator.settings.cameraOffsetOverride);
      coordinator.settings = v;
      if (offsetChanged) pushCameraOffset();
      if (overrideChanged) {
        policy.override = tierFor(v.tierOverride);
        const next = policy.override !== null ? Math.min(policy.override, policy.ceiling) as PerceptionTier : policy.adapted;
        if (next !== tier) { coordinator.noteTierChange(tier, next, `override ${v.tierOverride}`); tier = next; }
      }
      lifeChanged();
    },
    onEvent(cb) {
      const prev = coordinator.onEvent;
      const all = (e: PerceptionEvent, note: string | null) => { prev?.(e, note); cb(e, note); };
      coordinator.onEvent = all;
      return () => { if (coordinator.onEvent === all) coordinator.onEvent = prev; };
    },
    onFrame(cb) { frameListeners.add(cb); return () => frameListeners.delete(cb); },
    snapshot: () => coordinator.latest,
    stats() {
      const t = now();
      const since = Math.max(lastFrameAt, cameraStartedAt);
      const expected = !!stream && (cameraStatus.kind === 'running' || cameraStatus.kind === 'lowRate');
      const gap = expected ? t - since : 0;
      const recent = doneAt.filter((d) => t - d <= 1);
      return {
        camera: cameraStatus, tier, delegate: analyser?.delegate ?? null, worker: analyser?.worker ?? false,
        analysisFPS: windowFPS, hz: recent.length, stageMs, p90Ms: p90, noFramesFor: gap > 5 ? Math.trunc(gap) : null,
        arrived, accepted, droppedBusy, cameraOffset: offset, video: { width: video.videoWidth, height: video.videoHeight },
        source, pressure, lateFraction,
      };
    },
    setCameraOffset(o) { offsetOverride = o; pushCameraOffset(); },
    setSource(choice) {
      if (stopped) return;
      stopCamera();
      stopReplay();
      clearTimeout(retry);
      source = choice.kind;
      coordinator.source = source;
      if (choice.kind === 'camera') {
        // The worker's processor outlives a replay, which drained the mailbox meanwhile: re-send the current state.
        const m = coordinator.mailbox;
        m.post({ kind: 'settings', settings: coordinator.settings });
        m.post({ kind: 'cameraOffset', offset: { ...offset } });
        m.post({ kind: 'tier', tier });
        m.post({ kind: 'lowMode', on: life?.cameraMode === 'low' });
        m.post({ kind: 'pressure', level: pressure });
        void startCamera();
      }
      else if (choice.kind === 'replay') startReplay(choice.recording);
      else setStatus(CameraStatus.stopped);
    },
    setGovernorPressure(level) {
      governorPressure = Math.min(Math.max(Math.trunc(level) || 0, 0), PressureLevel.shutdown) as PressureLevel;
    },
  };
}

function tierFor(o: PerceptionSettings['tierOverride']): PerceptionTier | null {
  switch (o) {
    case 'full': return PerceptionTier.full;
    case 'standard': return PerceptionTier.standard;
    case 'reduced': return PerceptionTier.reduced;
    default: return null;
  }
}
