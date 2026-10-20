// Port of ConversationEvents/AgentIntents.swift.

// MARK: - Payloads (controller → transport)

/** Someone engaged and the mic just opened (listening): the next agent call starts a new conversation. */
export interface Engage {
  personCount: number;
  /** First engagement after an arrival (the greeting may have played). */
  firstEngagement: boolean;
}

/** The cached greeting clip was played; the transport keeps it in its recent-turns memory as Yanni's own words. */
export interface Greeted { text: string }

export interface PAD { p: number; a: number; d: number }

/** The emotion layer's mood report, verbatim (emotion design §8). The transport folds it into the per-turn note. */
export interface MoodReportPayload {
  /** The report's own schema version. */
  version: number;
  /** Fast felt PAD (baseline + mood + emotion). */
  felt: PAD;
  /** Slow mood deviation. */
  mood: PAD;
  /** Nearest expression name of `felt` (e.g. "Happiness"). */
  label: string;
  /** Plain-word bucket of the slow mood (cheerful, playful, calm, a bit bored, a bit down, unsure, excited). */
  moodLabel: string;
  boredom: number;
  /** Active sustained conditions (voiceServicesUnreachable, decisionModelDown). */
  conditions: string[];
}

export function makeMoodReport(m: Omit<MoodReportPayload, 'version'> & { version?: number }): MoodReportPayload {
  return { version: 1, ...m };
}

/** Session context for the per-turn context note. */
export interface ContextUpdate { quietMode: boolean; peopleCount: number }

export interface ProactiveItem {
  /** `announcement` (Home Assistant). Future kinds are additive. */
  kind: string;
  /** Untrusted text (≤ 500 chars). Phrased through `ai_task` as quoted data, never sent to the conversation agent. */
  text: string;
  /** Small flat context (≤ 8 keys). */
  context: Record<string, string>;
}

export const makeProactiveItem = (text: string, context: Record<string, string> = {}, kind = 'announcement'): ProactiveItem =>
  ({ kind, text, context });

/** Deliver held Home Assistant announcements now, as one turn. */
export interface ProactiveRequest {
  ids: string[];
  items: ProactiveItem[];
  audience: { people: number; engaged: boolean };
}

/** Abandon a turn (thinking timeout, the person left before the reply): the transport cancels everything for it. */
export interface CancelTurn { turnId: string; reason: 'thinking-timeout' | 'left' | 'superseded' }

/** A user turn started (turn detection's `speech-start`). The ASR pre-roll is taken from `onsetHostTime`. */
export interface SpeechStart { onsetHostTime: number }

/** The user's turn is over (`turn-end`). The ASR audio is drained to `hostTime`. */
export interface TurnEnd { hostTime: number }

// MARK: - Agent intent

/** What the controller tells the transport. Never queued: the transport is local. */
export type AgentIntent =
  | { kind: 'engage'; payload: Engage }
  | { kind: 'greeted'; payload: Greeted }
  | { kind: 'mood'; payload: MoodReportPayload }
  | { kind: 'context'; payload: ContextUpdate }
  | { kind: 'proactive'; payload: ProactiveRequest }
  | { kind: 'cancelTurn'; payload: CancelTurn }
  | { kind: 'speechStart'; payload: SpeechStart }
  | { kind: 'turnEnd'; payload: TurnEnd };

const intentNames: Record<AgentIntent['kind'], string> = {
  engage: 'engage', greeted: 'greeted', mood: 'mood', context: 'context', proactive: 'proactive',
  cancelTurn: 'cancel-turn', speechStart: 'speech-start', turnEnd: 'turn-end',
};

/** The intent's name for logs and traces (never its content). */
export const agentIntentName = (i: AgentIntent): string => intentNames[i.kind];
