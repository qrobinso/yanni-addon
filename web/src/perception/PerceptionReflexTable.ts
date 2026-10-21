// Port of FacePerception/PerceptionReflexTable.swift, with PerceptionReflexes+Rows.swift (`makePlan`) and
// PerceptionReflexes+Decide.swift (`decide`, `highFive`) folded into the class.
//
// The single perception reflex table (canonical; the emotion layer adopts it: the coordinator hands each impulse to
// `onImpulse`, then sends the beat or cue). Perception upgrade design §6.1:
//
// | Gesture | Needs | Beat (fallback) | Impulse (P, A, D), strength | Cooldown |
// |---|---|---|---|---|
// | wave | directed, ≤ 3.5 m, ≥ 0.75 | glance at a non-primary waver, then `dance` (`perkUp` while dance cools down); the first confident (≥ 0.9) wave within 20 s of arriving after ≥ 60 s alone → `.delight` cue | (0.7, 0.7, 0.3), 0.6 | 30 s person, 15 s global, dance 45 s |
// | bye wave | directed | `pretendExit` toward the exit side (`delightedSquint`) | (0.2, −0.1, 0), 0.2 | 10 min person |
// | clap | directed | `laugh` | (0.7, 0.6, 0.3), 0.5 | 45 s |
// | arms up | directed | `.delight` cue (`perkUp`) | (0.8, 0.8, 0.4), 0.6 | 60 s |
// | point | directed | look there (stimulus 0.6; outside the beat budget) | — | 8 s |
// | nod | the engaged person, follow-up only | `nodYes`, soft chirp | (0.4, 0.2, 0.2), 0.2 | 30 s |
// | thumbs up | directed, ≥ 0.8 | `.success` cue (`perkUp`) | (0.7, 0.5, 0.4), 0.5 | 30 s + the arbiter's |
// | thumbs down | directed | `sorryBlink` | (−0.3, 0.1, −0.2), 0.3 | 60 s |
// | open palm | directed, idle / noticing | `perkUp` | (0.5, 0.4, 0.1), 0.3 | 20 s |
// | peace | directed | `crossEyed` | (0.6, 0.4, 0.3), 0.3 | 60 s |
// | heart hands | directed | `.affection` cue (`delightedSquint`) | (0.8, 0.4, 0.1), 0.5 | 2 min + the arbiter's |
// | peekaboo | aimed before the cover | `bigSurprise` at the reveal | (0.7, 0.7, 0.2), 0.5 | 30 s |
// | dancing | facing ≥ 0.3 for 4 s | once per episode: `.music` cue, then one `dance` (`dance`) | (0.8, 0.8, 0.3), 0.6 | an episode ends after 60 s without dancing |
// | high-five | approach armed + tap ≤ 0.8 s | the engine's big `delightedSquint` (1.2) | (0.8, 0.8, 0.4), 0.6 | 20 s |
//
// Gating, in order: nothing at bedtime, sulking, drowsy, asleep, half-awake, waking or thinking; beats in idle,
// noticing, engaged and follow-up; in listening only a directed cue and speaking gets events only; the row's needs
// and cooldown; habituation (60 % / 30 % / events only); the global beat budget (over budget: no beat, no impulse,
// no cue); a one-shot beat while another plays → "busy"; an urgent beat while a pupil shape shows → "shape showing".
// Cues carry `source: perception`, `directedAtYanni`, valence 0.4, the key `"<cueKind>:person-<id>"` and the
// gesture's completion time.
import type { V2 } from '../core/vec';
import { makeReactionCue, type AgentState, type OneShotKind, type ReactionCue, type ReactionCueKind } from '../engine';
import { GestureBeatBudget } from './GestureBeatBudget';
import { GestureKind, clamp, vnormalize2, type GestureObservation } from './PerceptionTypes';
import {
  ReflexBeat, makePerceptionEffects, makeReflexImpulse, PerceptionEffects, someoneEngaged,
  type ReflexContext, type ReflexImpulse,
} from './PerceptionReflexes';

/// One row's plan before the shared gates.
interface Plan {
  beat: ReflexBeat;
  impulse: ReflexImpulse | null;
  fallback: OneShotKind | null;
  reason: string;
  glance: V2 | null;
  softVoice: boolean;
  followUp: { kind: OneShotKind; after: number } | null;
  /// Bookkeeping when the beat goes ahead.
  commit: (r: PerceptionReflexes) => void;
}
const plan = (o: Partial<Plan> & Pick<Plan, 'beat' | 'reason'>): { plan: Plan } => ({
  plan: { impulse: null, fallback: null, glance: null, softVoice: false, followUp: null, commit: () => {}, ...o },
});
type PlanResult = { plan: Plan } | { reject: string };

const imp = (p: number, a: number, d: number, s: number): ReflexImpulse => makeReflexImpulse({ x: p, y: a, z: d }, s);

export class PerceptionReflexes {
  static readonly waveMaxDistance = 3.5;
  static readonly waveMinConfidence = 0.75;
  static readonly wavePersonCooldown = 30;
  static readonly waveGlobalCooldown = 15;
  static readonly danceCooldown = 45;
  static readonly delightMinConfidence = 0.9;
  static readonly delightAloneSeconds = 60;
  static readonly delightArrivalWindow = 20;
  static readonly thumbsUpMinConfidence = 0.8;
  static readonly pointStimulus = 0.6;
  /// How far along the pointing direction (gaze units) Yanni looks.
  static readonly pointReach = 0.6;
  static readonly cueValence = 0.4;
  /// A new dancing episode needs this long without dancing.
  static readonly danceEpisodeGap = 60;
  /// The dance along starts this long after the note eyes.
  static readonly danceAlongDelay = 2.4;
  /// The friendly-touch window after a high-five approach.
  static readonly highFiveTapWindow = 0.8;
  /// One-shots that cut a showing pupil shape (the arbiter's urgent ones).
  static readonly urgentBeats: ReadonlySet<OneShotKind> = new Set<OneShotKind>(['bigSurprise', 'sorryBlink']);

  static readonly waveImpulse = imp(0.7, 0.7, 0.3, 0.6);
  static readonly byeImpulse = imp(0.2, -0.1, 0, 0.2);
  static readonly clapImpulse = imp(0.7, 0.6, 0.3, 0.5);
  static readonly armsUpImpulse = imp(0.8, 0.8, 0.4, 0.6);
  static readonly nodImpulse = imp(0.4, 0.2, 0.2, 0.2);
  static readonly thumbsUpImpulse = imp(0.7, 0.5, 0.4, 0.5);
  static readonly thumbsDownImpulse = imp(-0.3, 0.1, -0.2, 0.3);
  static readonly openPalmImpulse = imp(0.5, 0.4, 0.1, 0.3);
  static readonly peaceImpulse = imp(0.6, 0.4, 0.3, 0.3);
  static readonly heartImpulse = imp(0.8, 0.4, 0.1, 0.5);
  static readonly peekabooImpulse = imp(0.7, 0.7, 0.2, 0.5);
  static readonly danceImpulse = imp(0.8, 0.8, 0.3, 0.6);
  static readonly highFiveImpulse = imp(0.8, 0.8, 0.4, 0.6);

  /// Per-gesture row cooldown (per person; wave also has a global one).
  static cooldown(k: GestureKind): number {
    switch (k.kind) {
      case 'wave': return PerceptionReflexes.wavePersonCooldown;
      case 'byeWave': return 600;
      case 'clap': return 45;
      case 'armsUp': return 60;
      case 'point': return 8;
      case 'nod': return 30;
      case 'thumbsUp': return 30;
      case 'thumbsDown': return 60;
      case 'openPalm': return 20;
      case 'peace': return 60;
      case 'heartHands': return 120;
      case 'peekaboo': return 30;
      case 'dancing': return 0;
      case 'highFive': return 20;
    }
  }

  /// States where gestures do nothing at all.
  static readonly mutedStates: ReadonlySet<AgentState> = new Set<AgentState>(['drowsy', 'asleep', 'halfAwake', 'waking', 'thinking']);
  /// States where beats play.
  static readonly beatStates: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'noticing', 'engaged', 'followUp']);

  lastRow = new Map<number, number>();          // person * 16 + gesture → time of the last beat
  lastWaveAny = -Infinity;
  lastDance = -Infinity;
  lastPoint = -Infinity;
  delightUsed = new Set<number>();
  lastDancingSeen = -Infinity;
  dancingBefore = -Infinity;
  lastHighFive = -Infinity;
  highFiveArmed = new Map<number, number>();
  budget = new GestureBeatBudget();

  // port-note: like the Swift, `reset` leaves `dancingBefore` as it was.
  reset(): void {
    this.lastRow.clear(); this.lastWaveAny = -Infinity; this.lastDance = -Infinity; this.lastPoint = -Infinity;
    this.delightUsed.clear(); this.lastDancingSeen = -Infinity; this.lastHighFive = -Infinity; this.highFiveArmed.clear();
    this.budget.reset();
  }

  /// The cue's topic key: `"<cueKind>:person-<id>"`.
  static key(kind: ReactionCueKind, g: GestureObservation): string {
    return `${kind}:person-${g.personID !== null ? String(g.personID) : 'unknown'}`;
  }

  cue(kind: ReactionCueKind, g: GestureObservation, directed: boolean | null = null): ReactionCue {
    return makeReactionCue(kind, g.confidence, {
      source: 'perception', directedAtYanni: directed ?? g.directedAtYanni, valence: PerceptionReflexes.cueValence,
      hostTime: g.time, key: PerceptionReflexes.key(kind, g),
    });
  }

  rowKey(g: GestureObservation): number { return (g.personID ?? -1) * 16 + GestureKind.index(g.kind); }

  // MARK: PerceptionReflexes+Decide.swift

  /// Decides the effects of one gesture (and books cooldowns, habituation and the budget when a beat goes ahead).
  decide(g: GestureObservation, c: ReflexContext): PerceptionEffects {
    const R = PerceptionReflexes;
    const name = g.kind.kind;
    if (g.kind.kind === 'dancing') {
      this.dancingBefore = this.lastDancingSeen;
      this.lastDancingSeen = Math.max(this.lastDancingSeen, g.time);
    }
    if (c.isBedtime) return PerceptionEffects.rejected(`${name}: bedtime`);
    if (c.isSulking) return PerceptionEffects.rejected(`${name}: sulking`);
    if (R.mutedStates.has(c.agentState)) return PerceptionEffects.rejected(`${name}: ${c.agentState}`);
    const now = c.now;
    const beats = R.beatStates.has(c.agentState);

    if (g.kind.kind === 'point') {
      if (!g.directedAtYanni) return PerceptionEffects.rejected('point: not aimed at Yanni');
      if (!beats) return PerceptionEffects.rejected(`point: event only (${c.agentState})`);
      if (!(now - this.lastPoint >= R.cooldown(g.kind))) return PerceptionEffects.rejected('point: cooldown');
      this.lastPoint = now;
      const d = vnormalize2(g.kind.direction);
      const target = { x: g.at.x + d.x * R.pointReach, y: g.at.y + d.y * R.pointReach };
      const p = { x: clamp(target.x, -1, 1), y: clamp(target.y, -1, 1) };
      return makePerceptionEffects({ stimulus: { at: p, strength: R.pointStimulus }, activity: true, reason: 'point → look there' });
    }
    if (g.kind.kind === 'highFive') return this.highFive(g, c);
    if (g.kind.kind === 'dancing' && g.phase === 'ended') return PerceptionEffects.rejected('dancing ended');

    // Needs.
    if (g.kind.kind === 'nod') {
      if (!(g.personID !== null && g.personID === c.engagedID)) return PerceptionEffects.rejected('nod: not the engaged person');
      if (c.agentState !== 'followUp') return PerceptionEffects.rejected(`nod: event only (${c.agentState})`);
    } else if (!g.directedAtYanni) {
      return PerceptionEffects.rejected(`${name}: not aimed at Yanni`);
    }
    const res = this.makePlan(g, c);
    if ('reject' in res) return PerceptionEffects.rejected(res.reject);
    const p = res.plan;

    // States: beats in idle / noticing / engaged / follow-up; in listening only a directed cue.
    const cueInListening = p.beat.kind === 'cue' && c.agentState === 'listening';
    if (!(beats || cueInListening)) return PerceptionEffects.rejected(`${name}: event only (${c.agentState})`);

    // Row cooldown (per person).
    if (now - (this.lastRow.get(this.rowKey(g)) ?? -Infinity) < R.cooldown(g.kind)) return PerceptionEffects.rejected(`${name}: cooldown`);

    // Habituation and the global budget (over budget: no beat, no impulse, no cue).
    const intensity = this.budget.intensity(g.personID, GestureKind.index(g.kind), now);
    if (intensity === null) return PerceptionEffects.rejected(`${name}: habituated (events only)`);
    const why = this.budget.refusal(now);
    if (why !== null) return PerceptionEffects.rejected(`${name}: ${why}`);

    // The one-shot channel and a showing shape.
    const beatKind: OneShotKind | null = p.beat.kind === 'oneShot' || p.beat.kind === 'edgeAntic' ? p.beat.oneShot : null;
    if (beatKind !== null && c.oneShotBusy) return PerceptionEffects.rejected(`${name}: busy`);
    if (beatKind !== null && R.urgentBeats.has(beatKind) && c.pupilShapeShowing) return PerceptionEffects.rejected(`${name}: shape showing`);

    // Edge antics only in idle / noticing with nobody engaged; else the fallback right away.
    let beat = p.beat;
    let reason = p.reason;
    if (beat.kind === 'edgeAntic' && (!(c.agentState === 'idle' || c.agentState === 'noticing') || someoneEngaged(c)) &&
        p.fallback !== null) {
      beat = ReflexBeat.oneShot(p.fallback);
      reason = `${name} → ${p.fallback} (antics need idle, nobody engaged)`;
    }

    this.lastRow.set(this.rowKey(g), now);
    this.budget.record(g.personID, GestureKind.index(g.kind), now);
    p.commit(this);
    return makePerceptionEffects({
      impulse: p.impulse !== null ? makeReflexImpulse(p.impulse.target, p.impulse.strength * intensity) : null,
      beat, glanceAt: p.glance, activity: true,
      reason: intensity < 1 ? reason + ` (${Math.trunc(intensity * 100)}%)` : reason,
      intensity, fallback: p.fallback, softVoice: p.softVoice, followUp: p.followUp,
    });
  }

  /// The high-five: the approach arms the friendly-touch window; the tap (confirmed by the engine) gets the impulse.
  highFive(g: GestureObservation, c: ReflexContext): PerceptionEffects {
    const now = c.now;
    if (g.phase === 'started') {
      if (!g.directedAtYanni) return PerceptionEffects.rejected('highFive: not aimed at Yanni');
      if (!PerceptionReflexes.beatStates.has(c.agentState)) return PerceptionEffects.rejected(`highFive: event only (${c.agentState})`);
      if (!(now - this.lastHighFive >= PerceptionReflexes.cooldown(g.kind))) return PerceptionEffects.rejected('highFive: cooldown');
      if (g.personID !== null) this.highFiveArmed.set(g.personID, g.time);
      return makePerceptionEffects({ reason: 'highFive → touch window', friendlyTouchUntil: g.time + PerceptionReflexes.highFiveTapWindow });
    }
    this.lastHighFive = now;
    this.budget.record(g.personID, GestureKind.index(g.kind), now);
    return makePerceptionEffects({ impulse: PerceptionReflexes.highFiveImpulse, activity: true, reason: 'highFive → big delighted squint' });
  }

  /// Whether a high-five approach by this person armed the touch window within the precedence window.
  highFiveArmedRecently(id: number | null, now: number): boolean {
    if (id === null) return false;
    const t = this.highFiveArmed.get(id);
    return t !== undefined && now - t <= 0.8;
  }

  // MARK: PerceptionReflexes+Rows.swift

  /// Each row's beat (design §6.1) before the shared gates.
  makePlan(g: GestureObservation, c: ReflexContext): PlanResult {
    const R = PerceptionReflexes;
    const now = c.now;
    switch (g.kind.kind) {
      case 'wave': {
        if (!(g.distance <= R.waveMaxDistance)) return { reject: 'wave: too far' };
        if (!(g.confidence >= R.waveMinConfidence)) return { reject: 'wave: low confidence' };
        if (!(now - this.lastWaveAny >= R.waveGlobalCooldown)) return { reject: 'wave: cooldown' };
        const glance = g.personID !== c.primaryID ? g.at : null;
        // The first confident wave from someone who just arrived after a long time alone: star eyes.
        const id = g.personID;
        if (id !== null && !this.delightUsed.has(id) && g.confidence >= R.delightMinConfidence && c.arrivedAt !== null &&
            now - c.arrivedAt <= R.delightArrivalWindow && c.aloneBeforeArrival >= R.delightAloneSeconds) {
          return plan({
            beat: ReflexBeat.cue(this.cue('delight', g)), impulse: R.waveImpulse, fallback: 'perkUp',
            reason: 'wave → delight cue', glance, commit: (r) => { r.delightUsed.add(id); r.lastWaveAny = now; },
          });
        }
        if (now - this.lastDance >= R.danceCooldown) {
          return plan({
            beat: ReflexBeat.oneShot('dance'), impulse: R.waveImpulse, reason: 'wave → dance', glance,
            commit: (r) => { r.lastDance = now; r.lastWaveAny = now; },
          });
        }
        return plan({
          beat: ReflexBeat.oneShot('perkUp'), impulse: R.waveImpulse, reason: 'wave → perkUp (dance cooling down)', glance,
          commit: (r) => { r.lastWaveAny = now; },
        });
      }
      case 'byeWave':
        return plan({ beat: ReflexBeat.edgeAntic('pretendExit', g.kind.side), impulse: R.byeImpulse,
          fallback: 'delightedSquint', reason: 'byeWave → pretendExit' });
      case 'clap':
        return plan({ beat: ReflexBeat.oneShot('laugh'), impulse: R.clapImpulse, reason: 'clap → laugh' });
      case 'armsUp':
        return plan({ beat: ReflexBeat.cue(this.cue('delight', g)), impulse: R.armsUpImpulse, fallback: 'perkUp',
          reason: 'arms up → delight cue' });
      case 'nod':
        return plan({ beat: ReflexBeat.oneShot('nodYes'), impulse: R.nodImpulse, reason: 'nod → nod along', softVoice: true });
      case 'thumbsUp':
        if (!(g.confidence >= R.thumbsUpMinConfidence)) return { reject: 'thumbsUp: low confidence' };
        return plan({ beat: ReflexBeat.cue(this.cue('success', g)), impulse: R.thumbsUpImpulse, fallback: 'perkUp',
          reason: 'thumbsUp → success cue' });
      case 'thumbsDown':
        return plan({ beat: ReflexBeat.oneShot('sorryBlink'), impulse: R.thumbsDownImpulse, reason: 'thumbsDown → sorry blink' });
      case 'openPalm':
        if (!(c.agentState === 'idle' || c.agentState === 'noticing')) return { reject: `openPalm: event only (${c.agentState})` };
        if (this.highFiveArmedRecently(g.personID, g.time)) return { reject: 'openPalm: high-five precedence' };
        return plan({ beat: ReflexBeat.oneShot('perkUp'), impulse: R.openPalmImpulse, reason: 'openPalm → perkUp' });
      case 'peace':
        return plan({ beat: ReflexBeat.oneShot('crossEyed'), impulse: R.peaceImpulse, reason: 'peace → cross-eyed photo face' });
      case 'heartHands':
        return plan({ beat: ReflexBeat.cue(this.cue('affection', g)), impulse: R.heartImpulse, fallback: 'delightedSquint',
          reason: 'heartHands → affection cue' });
      case 'peekaboo':
        return plan({ beat: ReflexBeat.oneShot('bigSurprise'), impulse: R.peekabooImpulse, reason: 'peekaboo → big surprise' });
      case 'dancing':
        // One note-eyes cue and one dance along per episode (a new episode after 60 s without dancing).
        if (g.time - this.dancingBefore < R.danceEpisodeGap) return { reject: 'dancing: same episode' };
        return plan({
          beat: ReflexBeat.cue(this.cue('music', g, true)), impulse: R.danceImpulse, fallback: 'dance',
          reason: 'dancing → note eyes, then dance along', followUp: { kind: 'dance', after: R.danceAlongDelay },
          commit: (r) => { r.lastDance = now; },
        });
      case 'point': case 'highFive':
        return { reject: `${g.kind.kind}: handled elsewhere` };
    }
  }
}
