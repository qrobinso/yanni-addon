// Port of ConversationCore/ExpressiveDecisions.swift.
// port-note: the Swift ask is an async closure in a cancellable `Task`; here it returns a promise and gets an
// `AbortSignal` that aborts on cancel. A cancelled or replaced ask's answer is ignored by generation either way.
import type { AgentState } from '../../engine/AgentState';
import { GestureKind, type PerceptionEvent, type TrackedPerson } from '../../perception/PerceptionTypes';
import {
  distanceBand, ExpressiveFeaturesStatics, makeExpressiveFeatures, timeOfDay,
  type ExpressiveAskResult, type ExpressiveFeatures, type ExpressiveTrigger,
} from '../events/ExpressiveEvents';

/** Rates, caps and timings of expressive asks (expressive decisions design §2 D2–D5, D12, §3). */
export interface ExpressiveBudget {
  /** The owner's switch (it only matters with HA-Jev configured). */
  enabled: boolean;
  /** Asks per rolling hour (the owner's reaction budget; 0 = none). */
  perHour: number;
  /** Asks per rolling 24 h. */
  dailyCap: number;
  minSpacing: number;
  burst: number;
  burstWindow: number;
  perMinute: number;
  /** A considered reaction lands only this soon after its event (seconds). */
  deadline: number;
  /** The same trigger key within this long is coalesced. */
  coalesceWindow: number;
  /** Eye contact asks at this many seconds of looking, once per person per `eyeContactGap`. */
  eyeContactSeconds: number;
  eyeContactGap: number;
  /** Someone present this long with no eye contact, engagement or turn is "ignored"; at most once per `ignoredGap`. */
  ignoredAfter: number;
  ignoredGap: number;
  /** Taps within `pokeWindow` that make a streak. */
  pokeTaps: number;
  pokeWindow: number;
  /** People that make a group. */
  groupSize: number;
}

export const makeExpressiveBudget = (b: Partial<ExpressiveBudget> = {}): ExpressiveBudget => ({
  enabled: true, perHour: 60, dailyCap: 600, minSpacing: 4, burst: 3, burstWindow: 20, perMinute: 8, deadline: 0.9,
  coalesceWindow: 6, eyeContactSeconds: 2, eyeContactGap: 60, ignoredAfter: 90, ignoredGap: 300, pokeTaps: 3,
  pokeWindow: 4, groupSize: 3, ...b,
});

/** What happened to expressive triggers (Status: counts only, never content). */
export interface ExpressiveCounts {
  asked: number; applied: number; belowThreshold: number; late: number; cancelled: number; failed: number;
  coalesced: number; rateLimited: number; capped: number; skipped: number;
}

export const makeExpressiveCounts = (): ExpressiveCounts => ({
  asked: 0, applied: 0, belowThreshold: 0, late: 0, cancelled: 0, failed: 0, coalesced: 0, rateLimited: 0, capped: 0,
  skipped: 0,
});

export const expressiveCountsText = (c: ExpressiveCounts): string =>
  `${c.asked} asked · ${c.applied} applied · ${c.belowThreshold} below threshold · ${c.late} late · ${c.cancelled} cancelled · `
  + `${c.failed} failed · ${c.coalesced} coalesced · ${c.rateLimited} rate-limited · ${c.capped} capped · ${c.skipped} skipped`;

/** The moment as the bridge needs it (read at each trigger). */
export interface ExpressiveContext {
  agentState: AgentState;
  /** The life cycle is awake (not drowsy or asleep). */
  awake: boolean;
  bedtime: boolean;
  /** Yanni's emotion label (PAD). */
  mood: string;
  hour: number;
  /** HA-Jev is configured and the conversation transport is connected. */
  jevAvailable: boolean;
}

export const makeExpressiveContext = (c: Partial<ExpressiveContext> = {}): ExpressiveContext => ({
  agentState: 'idle', awake: true, bedtime: false, mood: 'Neutral', hour: 15, jevAvailable: true, ...c,
});

/** One person as the bridge needs them (from perception's `TrackedPerson`): no positions, no boxes. */
export interface ExpressivePerson {
  id: number;
  distance: number;
  facing: number;
  lookingAtMe: number;
  /** Seconds in view. */
  dwell: number;
}

export const makeExpressivePerson = (id: number, p: Partial<Omit<ExpressivePerson, 'id'>> = {}): ExpressivePerson =>
  ({ id, distance: 1.5, facing: 1, lookingAtMe: 0, dwell: 0, ...p });

export const expressivePersonFrom = (p: TrackedPerson): ExpressivePerson =>
  ({ id: p.id, distance: p.distance, facing: p.facing, lookingAtMe: p.lookingAtMe, dwell: p.dwell });

/** Outcome of one trigger (tests, the Tune panel). */
export type ExpressiveOutcome = 'asked' | 'off' | 'noJev' | 'state' | 'coalesced' | 'rateLimited' | 'capped';

export type ExpressiveAsk = (f: ExpressiveFeatures, signal: AbortSignal) => Promise<ExpressiveAskResult>;

interface InFlight {
  generation: number; key: string; personID: number | null; startedAt: number; abort: AbortController;
  cancelsOnTurn: boolean;
}

/** The perception → decision bridge (expressive decisions design §3–§5, §9): turns perception events, taps, tickles,
 *  long ignored presence and announcements into expressive asks within the budget, keeps one in flight, drops answers
 *  later than the deadline, cancels when the moment passes, and hands timely answers to `onAnswer` (the app: the
 *  emotion layer's `playExpressive`). The local reflex has already played; with no Jev nothing is asked. */
export class ExpressiveDecisions {
  budget = makeExpressiveBudget();
  /** The decision model (null: none, reflexes only). */
  ask: ExpressiveAsk | null = null;
  context: () => ExpressiveContext = () => makeExpressiveContext();
  /** A timely answer for trigger key (e.g. "gesture:wave"): returns the played plan's summary, or null when the
   *  mapping stayed below its threshold. */
  onAnswer: ((key: string, answers: Record<string, Record<string, number>>) => string | null) | null = null;
  /** One line per outcome (Status log; never feature values beyond the trigger). */
  onLog: ((line: string) => void) | null = null;

  counts = makeExpressiveCounts();
  /** The last non-conversation decision: trigger · round trip · plan · confidence. */
  lastDecision: string | null = null;
  /** The last request's features (the Tune panel shows what was sent). */
  lastRequest: ExpressiveFeatures | null = null;

  /** States where perception triggers ask (never during a turn). */
  static readonly askStates: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'noticing', 'engaged', 'followUp']);
  static readonly turnStates: ReadonlySet<AgentState> = new Set<AgentState>(['listening', 'thinking', 'speaking', 'interrupted']);

  private inFlight: InFlight | null = null;
  private generation = 0;
  private askTimes: number[] = [];
  private lastKeyAt = new Map<string, number>();
  private recent: string[] = [];
  private arrivals = new Map<number, number>();
  private lastEyeContact = new Map<number, number>();
  private taps: number[] = [];
  private lastAttention: number;
  private lastIgnored = -Infinity;

  constructor(readonly clock: () => number = () => performance.now() / 1000) {
    this.lastAttention = clock();
  }

  // MARK: Inputs

  /** A perception event with the reflex's note (`PerceptionCoordinator.onEvent`) and the people in view. */
  note(e: PerceptionEvent, reflexNote: string | null, people: readonly ExpressivePerson[]): void {
    const now = this.clock();
    switch (e.kind) {
      case 'gesture': {
        const g = e.gesture;
        if (!(g.phase !== 'ended' && (g.directedAtYanni || g.kind.kind === 'nod'))) return;
        if (reflexNote !== null && ExpressiveDecisions.refusesConsidered(reflexNote)) return;
        if (g.kind.kind === 'highFive' && g.phase === 'started') return;   // the tap confirms it
        this.lastAttention = now;
        const p = g.personID !== null ? people.find((x) => x.id === g.personID) ?? null : null;
        const f = this.features('gesture', p, people);
        f.gesture = GestureKind.name(g.kind);
        f.confidence = g.confidence;
        this.request(f, `gesture:${GestureKind.name(g.kind)}`, g.personID);
        break;
      }
      case 'personEntered': {
        this.arrivals.set(e.id, now);
        const group = people.length >= this.budget.groupSize;
        const t: ExpressiveTrigger = group ? 'group' : 'arrival';
        this.request(this.features(t, people.find((x) => x.id === e.id) ?? null, people), t, group ? null : e.id);
        break;
      }
      case 'personOutOfView':
        if (this.inFlight?.personID === e.id) this.cancel('person out of view');
        break;
      case 'personLeft':
        if (this.inFlight?.personID === e.id) this.cancel('person left');
        this.arrivals.delete(e.id);
        this.lastEyeContact.delete(e.id);
        this.request(this.features('leaving', null, people), 'leaving', null);
        break;
      case 'lookingAtMe': {
        this.lastAttention = now;
        if (!(Math.abs(e.seconds - this.budget.eyeContactSeconds) < 0.01
          && now - (this.lastEyeContact.get(e.id) ?? -Infinity) >= this.budget.eyeContactGap)) return;
        this.lastEyeContact.set(e.id, now);
        this.request(this.features('eyeContact', people.find((x) => x.id === e.id) ?? null, people), 'eyeContact', e.id);
        break;
      }
      case 'engaged':
        this.lastAttention = now;
        this.request(this.features('approach', people.find((x) => x.id === e.id) ?? null, people), 'approach', e.id);
        break;
      default:
        break;
    }
  }

  /** A tap on the face: the 3rd within `pokeWindow` is a poke streak. */
  noteTap(people: readonly ExpressivePerson[] = []): void {
    const now = this.clock();
    this.lastAttention = now;
    this.taps.push(now);
    this.taps = this.taps.filter((t) => !(now - t > this.budget.pokeWindow));
    if (this.taps.length < this.budget.pokeTaps) return;
    this.taps.length = 0;
    this.request(this.features('pokeStreak', null, people), 'pokeStreak', null);
  }

  /** The first stroke of a scratch (tickle). */
  noteTickle(people: readonly ExpressivePerson[] = []): void {
    this.lastAttention = this.clock();
    this.request(this.features('tickle', null, people), 'tickle', null);
  }

  /** A proactive batch starts delivery: the delivery face (the priority only, never the text). */
  noteAnnouncement(priority: string, people: readonly ExpressivePerson[] = []): void {
    const f = this.features('announcement', null, people);
    f.priority = priority === 'high' ? 'high' : 'normal';
    this.request(f, 'announcement', null, true);
  }

  /** About once a second: a turn opening, sleep or bedtime cancels a perception ask; someone long ignored asks once. */
  tick(people: readonly ExpressivePerson[]): void {
    const now = this.clock();
    const c = this.context();
    if (ExpressiveDecisions.turnStates.has(c.agentState)) {
      this.lastAttention = now;
      if (this.inFlight?.cancelsOnTurn === true) this.cancel('turn opened');
    }
    if ((!c.awake || c.bedtime || !this.budget.enabled) && this.inFlight !== null) this.cancel(c.bedtime ? 'bedtime' : 'asleep');
    let p: ExpressivePerson | null = null;
    for (const x of people) if (p === null || p.dwell < x.dwell) p = x;
    if (p === null || !(p.dwell >= this.budget.ignoredAfter) || !(now - this.lastAttention >= this.budget.ignoredAfter)
      || !(now - this.lastIgnored >= this.budget.ignoredGap)) return;
    this.lastIgnored = now;
    this.request(this.features('ignored', p, people), 'ignored', p.id);
  }

  /** Cancels the in-flight ask (its late answer is ignored). */
  cancel(why: string): void {
    const f = this.inFlight;
    if (f === null) return;
    f.abort.abort();
    this.inFlight = null;
    this.counts.cancelled += 1;
    this.log(`${f.key}: cancelled (${why})`);
  }

  // MARK: Asking

  /** The reflex refused the beat for a reason the considered reaction must respect too. */
  static refusesConsidered(note: string): boolean {
    return ['bedtime', 'sulking', 'budget', 'habituated', 'stale', 'reactions off', 'not aimed'].some((s) => note.includes(s));
  }

  features(t: ExpressiveTrigger, p: ExpressivePerson | null, people: readonly ExpressivePerson[]): ExpressiveFeatures {
    const c = this.context();
    const now = this.clock();
    const here = p !== null ? (this.arrivals.has(p.id) ? now - this.arrivals.get(p.id)! : p.dwell) : null;
    return makeExpressiveFeatures({
      event: t, people: people.length, distance: p !== null ? distanceBand(p.distance) : null,
      facing: p !== null ? p.facing >= 0.5 : null, eyeContact: p !== null ? p.lookingAtMe >= 0.5 : null,
      presentSeconds: here, mood: c.mood, state: c.agentState, timeOfDay: timeOfDay(c.hour), bedtime: c.bedtime,
      recent: this.recent.slice(),
    });
  }

  /** Checks the budget and asks. `anyState`: the announcement's delivery face (it plays in conversation states,
   *  where the engine keeps it subtle). */
  request(f: ExpressiveFeatures, key: string, personID: number | null, anyState = false): ExpressiveOutcome {
    const now = this.clock();
    const c = this.context();
    const b = this.budget;
    this.recent.push(key);
    const maxRecent = ExpressiveFeaturesStatics.maxRecent;
    if (this.recent.length > maxRecent) this.recent.splice(0, this.recent.length - maxRecent);
    if (!(b.enabled && b.perHour > 0)) { this.counts.skipped += 1; return 'off'; }
    if (!(c.jevAvailable && this.ask !== null)) { this.counts.skipped += 1; return 'noJev'; }
    if (!(c.awake && !c.bedtime && (anyState || ExpressiveDecisions.askStates.has(c.agentState)))) {
      this.counts.skipped += 1;
      return 'state';
    }
    if (this.inFlight !== null || now - (this.lastKeyAt.get(key) ?? -Infinity) < b.coalesceWindow) {
      this.counts.coalesced += 1;
      return 'coalesced';
    }
    this.askTimes = this.askTimes.filter((t) => !(now - t >= 86_400));
    const within = (w: number): number => this.askTimes.reduce((n, t) => n + (now - t < w ? 1 : 0), 0);
    const last = this.askTimes.length > 0 ? this.askTimes[this.askTimes.length - 1] : null;
    if (last !== null && now - last < b.minSpacing) { this.counts.rateLimited += 1; return 'rateLimited'; }
    if (within(b.burstWindow) >= b.burst || within(60) >= b.perMinute) { this.counts.rateLimited += 1; return 'rateLimited'; }
    if (within(3600) >= b.perHour || this.askTimes.length >= b.dailyCap) {
      this.counts.capped += 1;
      return 'capped';
    }
    this.askTimes.push(now);
    this.lastKeyAt.set(key, now);
    if (this.lastKeyAt.size > 64) {
      for (const [k, t] of this.lastKeyAt) if (!(now - t < b.coalesceWindow)) this.lastKeyAt.delete(k);
    }
    this.counts.asked += 1;
    this.lastRequest = f;
    this.generation += 1;
    const gen = this.generation;
    const ask = this.ask!;
    const abort = new AbortController();
    this.inFlight = { generation: gen, key, personID, startedAt: now, abort, cancelsOnTurn: !anyState };
    // port-note: a rejected ask counts as failed (the Swift closure can't throw).
    ask(f, abort.signal).then((r) => this.finish(gen, key, r), () => this.finish(gen, key, { kind: 'failed' }));
    return 'asked';
  }

  private finish(gen: number, key: string, r: ExpressiveAskResult): void {
    const f = this.inFlight;
    if (f === null || f.generation !== gen) return;   // cancelled or replaced
    this.inFlight = null;
    const elapsed = this.clock() - f.startedAt;
    switch (r.kind) {
      case 'disabled':
      case 'breakerOpen':
        this.counts.skipped += 1;
        this.log(`${key}: ${r.kind === 'disabled' ? 'no decision model' : 'breaker open'} (reflex only)`);
        break;
      case 'failed':
        this.counts.failed += 1;
        this.log(`${key}: failed (reflex only)`);
        break;
      case 'answered': {
        if (!(elapsed <= this.budget.deadline)) {
          this.counts.late += 1;
          this.log(`${key}: late ${Math.round(elapsed * 1000)} ms (dropped)`);
          return;
        }
        const summary = this.onAnswer?.(key, r.answers) ?? null;
        if (summary !== null) {
          this.counts.applied += 1;
          this.lastDecision = `${key} · ${r.roundTripMs} ms · ${summary}`;
          this.log(this.lastDecision);
        } else {
          this.counts.belowThreshold += 1;
          this.log(`${key}: ${r.roundTripMs} ms · below threshold (reflex only)`);
        }
        break;
      }
    }
  }

  /** True while an ask is waiting for its answer. */
  get isAsking(): boolean { return this.inFlight !== null; }

  private log(s: string): void { this.onLog?.(`expressive ${s}`); }
}
