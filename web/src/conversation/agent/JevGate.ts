// Port of ConversationAgent/JevGate.swift. Pass A / Pass B through `jev.ask` with fail-open rules (design §6.4): a
// timeout, an error result or a closed socket fails open; 3 failures in a row open a breaker (no calls for 5 s,
// doubling to 60 s, then one trial call); `decision-model-unavailable` is reported once per outage and cleared by the
// next good answer. Pass A and Pass B share the breaker.
// port-note: the actor becomes a class (single-threaded); cancellation is the caller's `AbortSignal`.
import type { DecisionModelUnavailable } from '../events/AgentEvents';
import type { ExpressiveAskResult, ExpressiveFeatures } from '../events/ExpressiveEvents';
import { roundHalfAway } from '../turn/TurnTunables';
import { AgentTimeout, CancellationError, makeAgentTunables, withAgentTimeout, type AgentClock, type AgentTunables } from './AgentTunables';
import { DecisionAnswerMapping, type Answers, type DecisionQuestions, type RecentLine } from './DecisionQuestions';
import { at, type JSONObject, type JSONValue } from './JSONValue';
import { intValue } from './JSONValue+Agent';

export type JevAsk = (state: JSONValue, questions: JSONValue, signal: AbortSignal) => Promise<JSONValue>;
type Reason = DecisionModelUnavailable['reason'];

export type JevOutcome =
  /** Mapped answers (possibly with keys omitted) and the round trip / Jev's own latency in ms. */
  | { kind: 'answered'; answers: Answers; roundTripMs: number; latencyMs: number | null }
  /** Failed open. `report` is set for the first failure of an outage only. */
  | { kind: 'failedOpen'; report: Reason | null }
  /** No decision model (HA-Jev not installed): every utterance is addressed, nothing is reported. */
  | { kind: 'disabled' };

export class JevGate {
  private ask: JevAsk | null = null;
  private tunables: AgentTunables;
  private failures = 0;
  private openUntil: number | null = null;
  private backoff: number;
  private trialInFlight = false;
  private outageReported = false;
  private passBInFlight = 0;
  private passBWaiters: (() => void)[] = [];

  lastRoundTripMs: number | null = null;
  lastLatencyMs: number | null = null;

  constructor(private readonly questions: DecisionQuestions, tunables: AgentTunables = makeAgentTunables(),
    private readonly clock: AgentClock) {
    this.tunables = tunables;
    this.backoff = tunables.breakerInitialBackoff;
  }

  /** null = disabled (no Jev config entry). */
  setAsk(ask: JevAsk | null): void { this.ask = ask; }
  setTunables(t: AgentTunables): void { this.tunables = t; }
  get isEnabled(): boolean { return this.ask !== null; }
  get breakerOpen(): boolean { return this.openUntil !== null; }
  get version(): number { return this.questions.version; }

  // MARK: Pass A

  async passA(utterance: string, recent: readonly RecentLine[], signal?: AbortSignal): Promise<JevOutcome> {
    const ask = this.ask;
    if (!ask) return { kind: 'disabled' };
    if (!this.permit()) return { kind: 'failedOpen', report: this.noteFailure('backoff', false) };
    const state = this.questions.passAState(utterance, recent);
    return this.run(ask, state, this.questions.passA, this.tunables.gateTimeout, signal);
  }

  // MARK: Pass B

  /** One reply chunk. Waits for a concurrency slot (at most `passBConcurrency` in flight). */
  async passB(sentence: string, recent: readonly RecentLine[], signal?: AbortSignal): Promise<JevOutcome> {
    const ask = this.ask;
    if (!ask) return { kind: 'disabled' };
    if (this.passBInFlight >= this.tunables.passBConcurrency) {
      // The releasing call hands its slot over (passBInFlight stays as it is).
      await new Promise<void>((resolve) => this.passBWaiters.push(resolve));
    } else {
      this.passBInFlight += 1;
    }
    try {
      if (signal?.aborted) return { kind: 'failedOpen', report: null };
      if (!this.permit()) return { kind: 'failedOpen', report: this.noteFailure('backoff', false) };
      const state = this.questions.passBState(sentence, recent);
      return await this.run(ask, state, this.questions.passB, this.tunables.passBTimeout, signal);
    } finally {
      const next = this.passBWaiters.shift();
      if (next) next(); else this.passBInFlight -= 1;
    }
  }

  // MARK: Expressive asks (expressive decisions design §4–§6)

  /** One expressive ask with only the documented features. The orchestrator keeps a separate gate instance for these,
   *  so their breaker never opens the conversation gate's. Outage reports are not used here. */
  async expressive(features: ExpressiveFeatures, signal?: AbortSignal): Promise<ExpressiveAskResult> {
    const ask = this.ask;
    if (!ask || Object.keys(this.questions.expressive).length === 0) return { kind: 'disabled' };
    if (!this.permit()) { this.noteFailure('backoff', false); return { kind: 'breakerOpen' }; }
    const state = this.questions.expressiveState(features);
    const o = await this.run(ask, state, this.questions.expressive, this.tunables.expressiveTimeout, signal);
    return o.kind === 'answered' ? { kind: 'answered', answers: o.answers, roundTripMs: o.roundTripMs } : { kind: 'failed' };
  }

  // MARK: Internals

  private async run(ask: JevAsk, state: JSONValue, set: JSONObject, timeout: number, signal?: AbortSignal): Promise<JevOutcome> {
    const start = this.clock.now();
    try {
      const response = await withAgentTimeout(timeout, this.clock, (s) => ask(state, set, s), signal);
      const answers = DecisionAnswerMapping.map(response, set);
      const rt = roundHalfAway((this.clock.now() - start) * 1000);
      const lat = intValue(at(response, 'latency_ms'));
      this.lastRoundTripMs = rt;
      this.lastLatencyMs = lat;
      this.noteSuccess();
      return { kind: 'answered', answers, roundTripMs: rt, latencyMs: lat };
    } catch (e) {
      if (e instanceof AgentTimeout) return { kind: 'failedOpen', report: this.noteFailure('timeout', true) };
      if (e instanceof CancellationError || signal?.aborted) {
        this.trialInFlight = false;
        return { kind: 'failedOpen', report: null };
      }
      return { kind: 'failedOpen', report: this.noteFailure('error', true) };
    }
  }

  /** Whether a call may go out now (breaker closed, or the one trial call after the backoff). */
  private permit(): boolean {
    if (this.openUntil === null) return true;
    if (!(this.clock.now() >= this.openUntil) || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  private noteSuccess(): void {
    this.failures = 0;
    this.openUntil = null;
    this.trialInFlight = false;
    this.backoff = this.tunables.breakerInitialBackoff;
    this.outageReported = false;
  }

  private noteFailure(reason: Reason, counts: boolean): Reason | null {
    if (counts) {
      this.failures += 1;
      if (this.trialInFlight) {
        // The trial failed: reopen for longer.
        this.trialInFlight = false;
        this.backoff = Math.min(this.backoff * 2, this.tunables.breakerMaxBackoff);
        this.openUntil = this.clock.now() + this.backoff;
      } else if (this.openUntil === null && this.failures >= this.tunables.breakerFailures) {
        this.openUntil = this.clock.now() + this.backoff;
      }
    }
    if (this.outageReported) return null;
    this.outageReported = true;
    return reason;
  }
}

/** The gate's verdict on Pass A (design §6.4 "Verdict"), checked in this order: not for me, dismissed, unclear,
 *  sign-off, addressed. */
export type GateVerdict =
  | { kind: 'addressed' }
  | { kind: 'notForMe' }
  | { kind: 'unclear' }
  /** Only ending the conversation or dismissing Yanni: no agent call, the mic closes. */
  | { kind: 'dismissed'; closing: number }
  /** A request plus a sign-off: the agent runs, then the mic closes after the reply. */
  | { kind: 'signOff'; closing: number };

export const GateVerdict = {
  of(answers: Answers, tunables: AgentTunables): GateVerdict {
    const no = answers.addressed?.no;
    if (no !== undefined && no >= tunables.notForMeThreshold) return { kind: 'notForMe' };
    const closing = answers.closing;
    const only = closing?.only;
    if (only !== undefined && only >= tunables.closingThreshold) return { kind: 'dismissed', closing: only };
    const notUnderstood = answers.understood?.no;
    if (notUnderstood !== undefined && notUnderstood >= tunables.unclearThreshold) return { kind: 'unclear' };
    const withRequest = closing?.withRequest;
    if (withRequest !== undefined && withRequest >= tunables.closingThreshold) return { kind: 'signOff', closing: withRequest };
    return { kind: 'addressed' };
  },

  /** Said harshly: Pass A's top feel is Annoyance, Sadness or Embarrassment at 0.5 or more (the acknowledgement is a
   *  sheepish look away instead of the "okay!" nod). */
  sheepish(answers: Answers): boolean {
    const feel = answers.feel;
    if (!feel) return false;
    let top: [string, number] | null = null;
    for (const e of Object.entries(feel)) if (top === null || top[1] < e[1]) top = e;
    if (!top) return false;
    return top[1] >= 0.5 && ['Annoyance', 'Sadness', 'Embarrassment'].includes(top[0]);
  },
};
