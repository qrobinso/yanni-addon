// Port of ConversationEvents/AgentEvents.swift. The transport seam (direct Home Assistant design §5.1): what the
// controller hears from the voice transport. Nothing here is a wire format.

// MARK: - Payloads (transport → controller)

/** Which voice says a reply (owner setting `speech.replyVoice`, design §7): Home Assistant's speech voice, or Yanni's
 *  own procedural babble (no words). */
export type ReplyVoice = 'spoken' | 'yanni';
export const replyVoices: readonly ReplyVoice[] = ['spoken', 'yanni'];

/** Session facts, emitted on connect and whenever the TTS voice or the reply voice changes. */
export interface ServicesInfo {
  /** Home Assistant's version from `auth_ok` (Status card; selects the agent path). */
  haVersion: string;
  /** `wyoming:<host>:<voice>[:<speaker>]`, or null without a TTS host. A change re-renders the greeting clips. */
  voiceId: string | null;
  decisionModel: 'up' | 'down' | 'disabled';
  replyVoice: ReplyVoice;
  ttsAvailable: boolean;
}

/** A bot turn that doesn't follow a user utterance has started (today: a proactive delivery). */
export interface TurnStarted {
  turnId: string;
  kind: 'proactive';
  /** The announcement ids this turn delivers (from the `proactive` intent). */
  ids: string[];
}

/** The user's turn is final (the ASR transcript arrived after `audio-stop`); the transport minted `turnId`. */
export interface TurnEnded {
  turnId: string;
  /** Length of the final transcript (never the text). 0 = empty transcript. */
  transcriptChars: number;
}

/** A decision-model result (decision design §5): Pass A (`utterance`) or Pass B (`sentence`). Raw probabilities. */
export interface DecisionPayload {
  turnId: string;
  pass: 'utterance' | 'sentence';
  /** Pass B only: 0 = the reply's first clause. */
  sentenceIndex: number | null;
  /** The question-set version (`decision-questions.json`). An unknown version is ignored. */
  version: number;
  /** question key → answer → probability (each distribution sums to ≈ 1). Pass A keys: addressed, understood, intent,
   *  feel, intensity, reaction, closing. Pass B keys: feel, intensity, reaction, stance. */
  answers: Record<string, Record<string, number>>;
}

/** The gate judged the utterance not addressed to Yanni (P(addressed = no) ≥ 0.8). Nothing reached the agent. */
export interface NotForMe { turnId: string }

/** The person ended the conversation or dismissed Yanni: Pass A's `closing` answer, or the local matcher while the
 *  decision model is unavailable. Never carries the words. */
export interface Dismissed {
  turnId: string;
  /** `decision`: P(closing) at or above the threshold; `local`: the local matcher. */
  source: 'decision' | 'local';
  /** The closing probability (`decision` only). */
  probability: number | null;
  /** A request plus a sign-off: the agent still runs and the mic closes after the reply. false = only a dismissal. */
  afterReply: boolean;
  /** Said harshly: Yanni's acknowledgement is a sheepish look away instead of the "okay!" nod. */
  sheepish: boolean;
}

export function makeDismissed(d: Pick<Dismissed, 'turnId' | 'source'> & Partial<Dismissed>): Dismissed {
  return { probability: null, afterReply: false, sheepish: false, ...d };
}

/** The log and status wording (never the words said): "closing p 0.82", "local", "after the reply, closing p 0.71". */
export function dismissedReason(d: Dismissed): string {
  const why = d.probability !== null ? `closing p ${d.probability.toFixed(2)}` : d.source;
  return d.afterReply ? 'after the reply, ' + why : why;
}

/** The gate judged the utterance unintelligible / incomplete, or the transcript was empty. No reply. */
export interface DidNotUnderstand { turnId: string; reason: 'empty' | 'unclear' }

/** The decision model failed open (timeout, error or backoff). Emitted once per outage. */
export interface DecisionModelUnavailable { reason: 'timeout' | 'error' | 'backoff' }

/** A reply sentence's audio is about to be queued (Spoken) or its babble scheduled (Yanni). `offsetMs` is its position
 *  in this turn's reply audio, counted from the reply's first frame. */
export interface SentenceStart {
  turnId: string;
  /** 0 = the first clause. */
  sentenceIndex: number;
  offsetMs: number;
}

/** The reply's last audio was queued / scheduled. The controller ends speaking once `audioMs` has played. */
export interface ReplyEnd {
  turnId: string;
  sentences: number;
  /** Total reply audio, ms (same origin as `SentenceStart.offsetMs`). */
  audioMs: number;
}

/** The transport cut the reply after a local barge-in (an acknowledgement; idempotent). */
export interface Interrupted { turnId: string }

/** How a proactive turn ended in the transport. */
export interface ProactiveDone {
  /** null when the turn never started. */
  turnId: string | null;
  ids: string[];
  /** spoken: the whole reply was queued; interrupted: barge-in; unavailable: nothing (more) will be said; cancelled:
   *  dropped before any audio. */
  status: 'spoken' | 'interrupted' | 'unavailable' | 'cancelled';
}

export type AgentErrorCode = 'stt-failed' | 'llm-failed' | 'llm-timeout' | 'tts-failed' | 'internal';

/** A failed turn (design §6.7). Any error for the current turn makes Yanni sheepish. */
export interface AgentError {
  code: AgentErrorCode;
  turnId: string | null;
  /** Why, for the event log (an error's type, a stage; never words). Not part of equality. */
  detail: string | null;
}

export const agentErrorEquals = (a: AgentError, b: AgentError): boolean => a.code === b.code && a.turnId === b.turnId;

/** A log-safe description of an error: its type and name (never a message that could quote what was said).
 *  port-note: Swift prints CustomStringConvertible errors and NSError domain/code; JS errors only expose the name. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

// MARK: - Agent event

/** What the controller hears from the transport. */
export type AgentEvent =
  | { kind: 'servicesInfo'; payload: ServicesInfo }
  | { kind: 'turnStarted'; payload: TurnStarted }
  | { kind: 'turnEnded'; payload: TurnEnded }
  | { kind: 'decision'; payload: DecisionPayload }
  | { kind: 'notForMe'; payload: NotForMe }
  | { kind: 'dismissed'; payload: Dismissed }
  | { kind: 'didNotUnderstand'; payload: DidNotUnderstand }
  | { kind: 'decisionModelUnavailable'; payload: DecisionModelUnavailable }
  | { kind: 'sentenceStart'; payload: SentenceStart }
  | { kind: 'replyEnd'; payload: ReplyEnd }
  | { kind: 'interrupted'; payload: Interrupted }
  | { kind: 'proactiveDone'; payload: ProactiveDone }
  | { kind: 'error'; payload: AgentError };

const eventNames: Record<AgentEvent['kind'], string> = {
  servicesInfo: 'services-info', turnStarted: 'turn-started', turnEnded: 'turn-ended', decision: 'decision',
  notForMe: 'not-for-me', dismissed: 'dismissed', didNotUnderstand: 'did-not-understand',
  decisionModelUnavailable: 'decision-model-unavailable', sentenceStart: 'sentence-start', replyEnd: 'reply-end',
  interrupted: 'interrupted', proactiveDone: 'proactive-done', error: 'error',
};

/** The event's name for logs and traces (never its content). */
export const agentEventName = (e: AgentEvent): string => eventNames[e.kind];

/** The turn an event belongs to, if any. */
export function agentEventTurnId(e: AgentEvent): string | null {
  switch (e.kind) {
    case 'servicesInfo':
    case 'decisionModelUnavailable':
      return null;
    default:
      return e.payload.turnId;
  }
}
