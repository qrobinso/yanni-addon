// Port of FaceVoice/Bridge/VoiceDirector+LaughFit.swift.
import type { LaughFitPart } from '../generate/LaughFit';
import type { VoiceDirector } from './VoiceDirector';

/// The tickle's laugh fit: while `FaceState.tickleLaugh` > 0 the director chains laugh phrases back to back, each
/// starting a short breath after the last one's release ends, so Yanni laughs continuously for as long as the scratch
/// goes on. Energy = drive (stroke intensity × fatigue × the night scale) × a build-up over the first second, so the
/// fit starts small, peaks with the scratch and gets breathier and calmer as it tires. When the drive returns to 0
/// it trails off: one or two small "hehe"s, then a happy sigh. The face's laugh bursts stay at their own rate-limited
/// cadence (and silent while the fit plays); every phrase still sends its face cues, so the face bobs on the notes.
///
/// Same rules as auto chirps (auto-vocalize, Sounds off, quiet mode, never over a babble reply or while speaking),
/// never while listening or thinking, and at bedtime only with quiet bedtime sounds (at the night volume).
export class LaughFitState {
  active = false;
  /// Host time the fit started (the build-up runs from it).
  since = 0;
  /// Host time the next phrase should start.
  nextStart = 0;
  /// Energy of the last laugh (the trail-off is quieter still).
  energy = 0;
  /// Trail-off phrases left after the scratch stopped (the last is the sigh); −1 while laughing.
  trail = -1;
  constructor(o: Partial<LaughFitState> = {}) { Object.assign(this, o); }
}

export const LaughFitTunables = {
  /// Build-up: energy × `laughBuildFloor` at the first phrase, rising (smoothstep) to × 1 over `laughBuild` s.
  laughBuild: 1.2,
  laughBuildFloor: 0.45,
  /// Breath between laugh phrases (s): the long end when calm or tired, the short end at the peak; ± `laughGapJitter`.
  laughGap: [0.08, 0.25] as const,
  laughGapJitter: 0.03,
  /// Breath before each trail-off phrase (s), and the trail-off's energy relative to the last laugh.
  trailGap: [0.15, 0.3] as const,
  trailEnergy: 0.6,
  /// The next phrase is planned this long (s) before the lead would make it late.
  laughPlanAhead: 0.03,
};

/// Per frame, before the started one-shots are read.
export function stepLaughFit(d: VoiceDirector): void {
  const T = LaughFitTunables;
  const drive = d.engine.state.tickleLaugh;
  if (!(drive > 0 || d.laughFit.active)) return;
  const now = d.clock();
  if (!laughFitAllowed(d, now)) { d.laughFit = new LaughFitState(); return; }
  const rng = d.generator.rng;
  if (drive > 0) {
    if (!d.laughFit.active) d.laughFit = new LaughFitState({ active: true, since: now, nextStart: now });
    d.laughFit.trail = -1;
    if (!(now + d.lead + T.laughPlanAhead >= d.laughFit.nextStart)) return;
    const t = Math.min((now - d.laughFit.since) / T.laughBuild, 1);
    const build = T.laughBuildFloor + (1 - T.laughBuildFloor) * t * t * (3 - 2 * t);
    const e = Math.min(drive, 1) * build;
    d.laughFit.energy = e;
    const g = T.laughGap;
    const gap = g[1] - (g[1] - g[0]) * e + rng.sym(T.laughGapJitter);
    planLaughFit(d, 'laugh', e, now, Math.min(Math.max(gap, g[0]), g[1]));
  } else {
    if (d.laughFit.trail < 0) d.laughFit.trail = rng.chance(0.5) ? 3 : 2;
    if (!(d.laughFit.trail > 0)) { d.laughFit = new LaughFitState(); return; }
    if (!(now + d.lead + T.laughPlanAhead >= d.laughFit.nextStart)) return;
    const part: LaughFitPart = d.laughFit.trail === 1 ? 'sigh' : 'hehe';
    d.laughFit.trail -= 1;
    const gap = rng.range(T.trailGap[0], T.trailGap[1]);
    planLaughFit(d, part, d.laughFit.energy * T.trailEnergy, now, gap);
  }
}

function laughFitAllowed(d: VoiceDirector, now: number): boolean {
  const st = d.engine.state.agentState;
  const s = d.settings;
  if (!(s.autoVocalize && !d.isSpeaking && st !== 'speaking' && st !== 'listening' && st !== 'thinking')) return false;
  if (now < d.reply.audibleUntil || s.quietMode || s.muted) return false;
  return !d.isBedtime || s.bedtimeSounds === 'quiet';
}

function planLaughFit(d: VoiceDirector, part: LaughFitPart, energy: number, now: number, gap: number): void {
  const affect = d.affectSnapshot();
  const phrase = d.generator.makeLaughFit(part, energy, affect);
  phrase.affect = { ...affect };
  const rec = d.schedule(phrase, now, { kind: 'at', t: d.laughFit.nextStart }, true, true);
  if (!rec) return;
  const stretch = rec.timeStretch;
  d.laughFit.nextStart = rec.startHostTime + rec.phrase.duration * stretch + gap * stretch;
}
