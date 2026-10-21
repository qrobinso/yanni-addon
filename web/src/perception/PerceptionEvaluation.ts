// Port of FacePerception/PerceptionEvaluation.swift, with PerceptionEvaluationScoring.swift (`evaluate`, `score`,
// `scoreTracking`, `scoreDistance`, `band`) and PerceptionEvaluationTuning.swift (`TuningAxis`, `tune`, the report's
// `text`) folded in.
//
// The offline evaluator (perception upgrade design §5.5): recordings run through the real `PerceptionProcessor` and
// the reflex table, scored against the session's labels.
import { CameraGeometry } from './CameraGeometry';
import type { FeatureRecordingSession } from './FeatureRecordingSession';
import { SessionMark, type SessionLabel } from './FeatureRecordingStore';
import { StagePercentiles, StageTimings } from './HarnessTiming';
import { ReflexDecision } from './PerceptionCounters';
import { PerceptionProcessor } from './PerceptionProcessor';
import { PerceptionReflexes } from './PerceptionReflexTable';
import { makeReflexContext } from './PerceptionReflexes';
import { PerceptionSettings } from './PerceptionSettings';
import { PerceptionEvent, fmt, type PerceptionTier, type TrackedPerson } from './PerceptionTypes';

export interface EvaluationTimed { t: number; event: PerceptionEvent; reaction: string | null }

/// What re-running one session produced.
export interface EvaluationRun {
  session: FeatureRecordingSession;
  events: EvaluationTimed[];
  /// Per frame: the processor's people, primary and engaged IDs.
  frames: { t: number; people: TrackedPerson[]; engaged: number | null }[];
}

export class GestureScore {
  truePositives = 0;
  falsePositives = 0;
  falseNegatives = 0;
  get precision(): number | null {
    const n = this.truePositives + this.falsePositives;
    return n > 0 ? this.truePositives / n : null;
  }
  get recall(): number | null {
    const n = this.truePositives + this.falseNegatives;
    return n > 0 ? this.truePositives / n : null;
  }
  equals(o: GestureScore): boolean {
    return this.truePositives === o.truePositives && this.falsePositives === o.falsePositives && this.falseNegatives === o.falseNegatives;
  }
}

export interface DistanceBandError {
  /// Mean |estimate − mark| / mark.
  meanRelativeError: number;
  windows: number;
}

/// One platform's report (iPad and preview recordings are never pooled).
export class EvaluationReport {
  sessions = 0;
  hours = 0;
  /// Hours of "none" and hard-negative sessions.
  noneHours = 0;
  gestures: Record<string, GestureScore> = {};
  /// label → predicted gesture → count (predictions inside another gesture's window).
  confusion: Record<string, Record<string, number>> = {};
  falseReactions = 0;
  falseReactionsByGesture: Record<string, number> = {};
  timeToEngage: number[] = [];
  lookingWindows = 0;
  engagedWithin1_5s = 0;
  falseEngagements = 0;
  /// Hours of sessions where every engagement outside a "looking" label is false (eye-contact, none, hard negatives).
  engagementNegativeHours = 0;
  crossings = 0;
  idSwitches = 0;
  engagedSwaps = 0;
  distance: Record<string, DistanceBandError> = {};
  /// Live stage timings as recorded (ms): stage → [p50, p90, p99].
  stageMs: Record<string, number[]> = {};

  constructor(public platform: string) {}

  get falseReactionsPerHour(): number | null { return this.noneHours > 0 ? this.falseReactions / this.noneHours : null; }
  get falseEngagementsPerHour(): number | null {
    return this.engagementNegativeHours > 0 ? this.falseEngagements / this.engagementNegativeHours : null;
  }
  get idSwitchesPerCrossing(): number | null { return this.crossings > 0 ? this.idSwitches / this.crossings : null; }
  get engageRecall(): number | null { return this.lookingWindows > 0 ? this.engagedWithin1_5s / this.lookingWindows : null; }
  get medianTimeToEngage(): number | null {
    if (this.timeToEngage.length === 0) return null;
    const s = [...this.timeToEngage].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  /// A per-gesture rate of ≤ 0.3 / h may be claimed only from ≥ 10 held-out hours of real "none" data.
  get rateClaimable(): boolean { return this.noneHours >= 10 && this.platform !== 'synthetic'; }

  // MARK: PerceptionEvaluationTuning.swift

  /// The human-readable report the command line prints.
  get text(): string {
    const f = (v: number | null, d = 2): string => v !== null ? fmt(v, d) : '—';
    const sortedKeys = <T>(o: Record<string, T>): string[] => Object.keys(o).sort();
    let o = `== ${this.platform}: ${this.sessions} sessions, ${fmt(this.hours, 2)} h (none ${fmt(this.noneHours, 2)} h)\n`;
    o += 'Gestures (precision / recall · TP FP FN):\n';
    for (const k of sortedKeys(this.gestures)) {
      const g = this.gestures[k];
      o += `  ${k.padEnd(12).slice(0, 12)} ${f(g.precision)} / ${f(g.recall)} · ${g.truePositives} ${g.falsePositives} ${g.falseNegatives}\n`;
    }
    if (Object.keys(this.confusion).length > 0) {
      o += 'Confusion (label → predicted):\n';
      for (const l of sortedKeys(this.confusion)) {
        const m = this.confusion[l];
        o += `  ${l} → ` + sortedKeys(m).map((k) => `${k} ×${m[k]}`).join(', ') + '\n';
      }
    }
    o += `False reactions: ${this.falseReactions} (${f(this.falseReactionsPerHour)} / h`;
    o += this.rateClaimable ? ')\n' : '; not claimable: needs ≥ 10 h of real "none" data)\n';
    o += `Look-to-talk: median time-to-engage ${f(this.medianTimeToEngage)} s · engaged ≤ 1.5 s ${f(this.engageRecall)} of ${this.lookingWindows} looks`;
    o += ` · false engagements ${this.falseEngagements} (${f(this.falseEngagementsPerHour)} / h)\n`;
    o += `Tracking: ${this.crossings} crossings · ID switches / crossing ${f(this.idSwitchesPerCrossing)} · engaged swaps ${this.engagedSwaps}\n`;
    for (const b of sortedKeys(this.distance)) {
      const e = this.distance[b];
      o += `Distance ${b}: ±${fmt(e.meanRelativeError * 100, 1)} % over ${e.windows} windows\n`;
    }
    if (Object.keys(this.stageMs).length > 0) {
      o += 'Live stage ms (p50 / p90 / p99):\n';
      for (const name of StageTimings.names) {
        const p = this.stageMs[name];
        if (p !== undefined) o += `  ${name} ${fmt(p[0], 1)} / ${fmt(p[1], 1)} / ${fmt(p[2], 1)}\n`;
      }
    }
    return o;
  }
}

/// One tunable of the grid search: a name, the values to try and how to apply one to the settings.
export interface TuningAxis {
  name: string;
  values: number[];
  apply: (s: PerceptionSettings, v: number) => void;
}

export const TuningAxis = {
  engageDwell: { name: 'engageDwell', values: [0.6, 0.8, 1.0, 1.2, 1.4], apply: (s, v) => { s.engageDwell = v; } } as TuningAxis,
  eyeContactEnter: { name: 'eyeContactEnter', values: [0.5, 0.6, 0.7, 0.8], apply: (s, v) => { s.eyeContactEnter = v; } } as TuningAxis,
  eyeContactSigmaEyes: { name: 'eyeContactSigmaEyes', values: [5, 6.5, 8, 10, 12], apply: (s, v) => { s.eyeContactSigmaEyes = v; } } as TuningAxis,
  get lookToTalk(): TuningAxis[] { return [TuningAxis.engageDwell, TuningAxis.eyeContactEnter, TuningAxis.eyeContactSigmaEyes]; },
};

export interface TuningResult {
  values: Record<string, number>;
  falseEngagementsPerHour: number;
  medianTimeToEngage: number | null;
  engageRecall: number | null;
  feasible: boolean;
}

/// Matching slack around a labelled window (seconds).
const slack = 0.5;
/// Labels that are not gesture names.
const nonGestureLabels = new Set(['looking', 'notLooking', 'crossing', 'none']);

export const PerceptionEvaluator = {
  slack,
  isGesture: (label: string): boolean => !nonGestureLabels.has(label) && !label.startsWith('none:'),

  /// Re-runs a session through the processor (its recorded tier and camera offset) and the reflex table.
  run(s: FeatureRecordingSession, settings: PerceptionSettings): EvaluationRun {
    // v1 and synthetic recordings carry no tier: they run at full.
    const recorded = s.header.schema >= 2 && s.header.platform !== 'synthetic' && s.header.platform !== 'v1';
    const t = s.frames[0]?.tier;
    const tier: PerceptionTier = recorded && t !== undefined && t >= 0 && t <= 3 ? t as PerceptionTier : 3;
    const proc = new PerceptionProcessor(settings, new CameraGeometry(undefined, s.header.cameraOffset), tier);
    const reflexes = new PerceptionReflexes();
    const events: EvaluationTimed[] = [];
    const frames: EvaluationRun['frames'] = [];
    for (const f of s.frames) {
      const det = { ...f.detections, motion: null, bodies: f.detections.bodies.map((b) => ({ ...b, appearance: null })) };
      const out = proc.process(det);
      frames.push({ t: det.time, people: out.snapshot.people, engaged: out.snapshot.engagedID });
      for (const e of out.events) {
        let reaction: string | null = null;
        if (e.kind === 'gesture') {
          const ctx = makeReflexContext({ agentState: out.snapshot.engagedID === null ? 'idle' : 'engaged',
            primaryID: out.snapshot.primaryID, now: det.time });
          const fx = reflexes.decide(e.gesture, ctx);
          if (ReflexDecision.parse(PerceptionEvent.name(e), fx.reason)?.kind === 'played') reaction = fx.reason;
        }
        events.push({ t: det.time, event: e, reaction });
      }
    }
    return { session: s, events, frames };
  },

  // MARK: PerceptionEvaluationScoring.swift

  /// Scores sessions per platform (never pooled across platforms).
  evaluate(sessions: FeatureRecordingSession[], settings: PerceptionSettings = new PerceptionSettings()): EvaluationReport[] {
    const reports = new Map<string, EvaluationReport>();
    for (const s of sessions) {
      const r = reports.get(s.header.platform) ?? new EvaluationReport(s.header.platform);
      PerceptionEvaluator.score(PerceptionEvaluator.run(s, settings), r, settings);
      reports.set(s.header.platform, r);
    }
    for (const [k, r] of reports) r.stageMs = PerceptionEvaluator.stagePercentiles(sessions.filter((s) => s.header.platform === k));
    return [...reports.values()].sort((a, b) => a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0);
  },

  stagePercentiles(sessions: FeatureRecordingSession[]): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    StageTimings.names.forEach((name, i) => {
      const v = sessions.flatMap((s) => s.frames.map((f) => f.stages.values[i])).filter((x) => x > 0);
      if (v.length === 0) return;
      const p = StagePercentiles.of(v);
      out[name] = [p.p50, p.p90, p.p99];
    });
    return out;
  },

  /// Adds one run to a report.
  score(run: EvaluationRun, r: EvaluationReport, settings: PerceptionSettings): void {
    const s = run.session;
    const hours = s.duration / 3600;
    const type = s.header.sessionType;
    r.sessions += 1;
    r.hours += hours;
    const negativeSession = type === 'none' || type === 'hardNegatives';
    if (negativeSession) r.noneHours += hours;
    if (negativeSession || type === 'eyeContact') r.engagementNegativeHours += hours;
    const labels = s.labels.labels;
    const wrongMarks = s.labels.marks.filter((m) => m.kind === SessionMark.wrongReaction).map((m) => m.t);

    // Gestures: each labelled window is matched by the first gesture event of its kind inside it (± slack).
    const gestures = run.events.flatMap((e) => e.event.kind === 'gesture'
      ? [{ t: e.t, kind: e.event.gesture.kind.kind as string, reaction: e.reaction }] : []);
    const used = new Set<number>();
    const scoreOf = (k: string): GestureScore => (r.gestures[k] ??= new GestureScore());
    for (const w of labels) {
      if (!PerceptionEvaluator.isGesture(w.label)) continue;
      const score = scoreOf(w.label);
      const i = gestures.findIndex((g, j) => !used.has(j) && g.kind === w.label && g.t >= w.start - slack && g.t <= w.end + slack);
      if (i >= 0) { used.add(i); score.truePositives += 1; } else { score.falseNegatives += 1; }
    }
    gestures.forEach((g, i) => {
      if (used.has(i)) return;
      scoreOf(g.kind).falsePositives += 1;
      const w = labels.find((l) => g.t >= l.start - slack && g.t <= l.end + slack && l.label !== g.kind);
      if (w !== undefined) {
        const m = (r.confusion[w.label] ??= {});
        m[g.kind] = (m[g.kind] ?? 0) + 1;
      }
      // Reactions in a negative session are false reactions — and every marked one counts too.
      const marked = wrongMarks.some((t) => Math.abs(t - g.t) <= 5);
      if (g.reaction !== null && (negativeSession || marked)) {
        r.falseReactions += 1;
        r.falseReactionsByGesture[g.kind] = (r.falseReactionsByGesture[g.kind] ?? 0) + 1;
      }
    });

    // Look-to-talk: time from each "looking" window's start to the first engagement.
    const engagedTimes = run.events.filter((e) => e.event.kind === 'engaged').map((e) => e.t);
    const looking = labels.filter((l) => l.label === 'looking' && (l.distance ?? 0) <= settings.engageMaxDistance);
    for (const w of looking) {
      r.lookingWindows += 1;
      const t = engagedTimes.find((x) => x >= w.start - 0.2 && x <= w.end);
      if (t !== undefined) {
        const dt = Math.max(t - w.start, 0);
        r.timeToEngage.push(dt);
        if (dt <= 1.5) r.engagedWithin1_5s += 1;
      }
    }
    if (negativeSession || type === 'eyeContact') {
      const lookWindows = labels.filter((l) => l.label === 'looking');
      r.falseEngagements += engagedTimes.filter((t) => !lookWindows.some((l) => t >= l.start - slack && t <= l.end + slack)).length;
    }

    PerceptionEvaluator.scoreTracking(run, labels, r);
    PerceptionEvaluator.scoreDistance(run, labels, r);
  },

  /// ID switches per scripted crossing (distinct confirmed track IDs in the window minus the people the script put
  /// there) and engaged-person swaps (the engaged ID moving straight to another ID).
  scoreTracking(run: EvaluationRun, labels: SessionLabel[], r: EvaluationReport): void {
    for (const w of labels) {
      if (w.label !== 'crossing') continue;
      const inside = run.frames.filter((f) => f.t >= w.start && f.t <= w.end);
      const ids = new Set(inside.flatMap((f) => f.people.filter((p) => p.state !== 'tentative' && !p.isStatic).map((p) => p.id)));
      r.crossings += 1;
      r.idSwitches += Math.max(ids.size - (w.people ?? 1), 0);
      let last: number | null = null;
      for (const f of inside) {
        if (f.engaged !== null && last !== null && f.engaged !== last) r.engagedSwaps += 1;
        last = f.engaged;
      }
    }
  },

  /// Distance error by band: single-person windows with a floor mark, the middle half of the window.
  scoreDistance(run: EvaluationRun, labels: SessionLabel[], r: EvaluationReport): void {
    const sums = new Map<string, [number, number]>();
    for (const w of labels) {
      if ((w.people ?? 1) !== 1) continue;
      const mark = w.distance;
      if (mark === null || !(mark > 0)) continue;
      const a = w.start + (w.end - w.start) * 0.25, b = w.end - (w.end - w.start) * 0.25;
      const est = run.frames.filter((f) => f.t >= a && f.t <= b).flatMap((f) => f.people.length > 0 ? [f.people[0].distance] : []);
      if (est.length === 0) continue;
      const mean = est.reduce((x, y) => x + y, 0) / est.length;
      const band = PerceptionEvaluator.band(mark);
      const e = Math.abs(mean - mark) / mark;
      const old = sums.get(band);
      sums.set(band, [(old?.[0] ?? 0) + e, (old?.[1] ?? 0) + 1]);
    }
    for (const [band, [sum, n]] of sums) {
      const old = r.distance[band];
      const total = n + (old?.windows ?? 0);
      const mean = (sum + (old !== undefined ? old.meanRelativeError * old.windows : 0)) / total;
      r.distance[band] = { meanRelativeError: mean, windows: total };
    }
  },

  band: (d: number): string => d <= 1.5 ? 'near ≤1.5 m' : d <= 2.5 ? 'mid 1.5–2.5 m' : 'far 2.5–3.5 m',

  // MARK: PerceptionEvaluationTuning.swift

  /// Grid search: every combination of the axes, scored on the sessions of one platform. Feasible = false
  /// engagements per hour within `maxFalsePerHour`. Sorted best first: feasible before infeasible, then the shortest
  /// median time-to-engage, then the highest recall.
  tune(sessions: FeatureRecordingSession[], axes: TuningAxis[], base: PerceptionSettings = new PerceptionSettings(),
    maxFalsePerHour = 0.5): TuningResult[] {
    let combos: Record<string, number>[] = [{}];
    for (const a of axes) combos = combos.flatMap((c) => a.values.map((v) => ({ ...c, [a.name]: v })));
    const results: TuningResult[] = [];
    for (const c of combos) {
      let s = base.copy();
      for (const a of axes) { const v = c[a.name]; if (v !== undefined) a.apply(s, v); }
      s = s.validated();
      const r = new EvaluationReport('tune');
      for (const session of sessions) PerceptionEvaluator.score(PerceptionEvaluator.run(session, s), r, s);
      const fph = r.falseEngagementsPerHour ?? 0;
      results.push({ values: c, falseEngagementsPerHour: fph, medianTimeToEngage: r.medianTimeToEngage,
        engageRecall: r.engageRecall, feasible: fph <= maxFalsePerHour });
    }
    // port-note: Swift's sort isn't documented as stable; JS's is.
    return results.sort((a, b) => {
      if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
      const ta = a.medianTimeToEngage ?? Infinity, tb = b.medianTimeToEngage ?? Infinity;
      if (ta !== tb) return ta < tb ? -1 : 1;
      const ra = a.engageRecall ?? 0, rb = b.engageRecall ?? 0;
      return ra > rb ? -1 : ra < rb ? 1 : 0;
    });
  },
};
