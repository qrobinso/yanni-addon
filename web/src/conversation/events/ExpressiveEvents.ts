// Port of ConversationEvents/ExpressiveEvents.swift.
import { roundHalfAway } from '../turn/TurnTunables';

/** What made Yanni ask the decision model for a considered reaction (expressive decisions design §3). */
export type ExpressiveTrigger =
  | 'gesture' | 'arrival' | 'group' | 'leaving' | 'eyeContact' | 'approach' | 'pokeStreak' | 'tickle' | 'ignored'
  | 'announcement';
export const expressiveTriggers: readonly ExpressiveTrigger[] = [
  'gesture', 'arrival', 'group', 'leaving', 'eyeContact', 'approach', 'pokeStreak', 'tickle', 'ignored', 'announcement',
];

/** The only things an expressive ask sends (design §5): text features, never images, positions, ids, names or speech. */
export interface ExpressiveFeatures {
  event: ExpressiveTrigger;
  /** Gesture triggers: the curated gesture name and the recogniser's confidence. */
  gesture: string | null;
  confidence: number | null;
  /** Announcement trigger: `normal` / `high`. */
  priority: string | null;
  /** People in view. */
  people: number;
  /** The trigger person's distance band (`near`, `mid`, `far`), facing and eye contact; null when unknown. */
  distance: string | null;
  facing: boolean | null;
  eyeContact: boolean | null;
  /** How long they have been here, seconds. */
  presentSeconds: number | null;
  /** Yanni's emotion label (PAD) and agent state. */
  mood: string;
  state: string;
  /** `morning`, `afternoon`, `evening`, `night`. */
  timeOfDay: string;
  bedtime: boolean;
  /** The last few trigger labels (no times, no ids). */
  recent: string[];
}

export function makeExpressiveFeatures(f: Pick<ExpressiveFeatures, 'event'> & Partial<ExpressiveFeatures>): ExpressiveFeatures {
  return {
    gesture: null, confidence: null, priority: null, people: 0, distance: null, facing: null, eyeContact: null,
    presentSeconds: null, mood: 'Neutral', state: 'idle', timeOfDay: 'afternoon', bedtime: false, recent: [], ...f,
  };
}

export const ExpressiveFeaturesStatics = {
  /** Every key the `jev.ask` state may carry (design §5). */
  documentedKeys: new Set([
    'character', 'event', 'gesture', 'confidence', 'priority', 'people', 'distance', 'facing', 'eye_contact',
    'present_s', 'mood', 'state', 'time_of_day', 'bedtime', 'recent',
  ]),
  maxRecent: 4,
} as const;

// port-note: Swift's String.prefix counts grapheme clusters; this counts code points.
const short = (s: string): string => Array.from(s).slice(0, 32).join('');

/** Rounded and capped: people 0…9, confidence to 2 decimals, presence to 5 s (≤ 3600), the last 4 recent labels,
 *  names trimmed to 32 characters. */
export function normalizedFeatures(src: ExpressiveFeatures): ExpressiveFeatures {
  const c = src.confidence;
  const p = src.presentSeconds;
  return {
    ...src,
    people: Math.min(Math.max(src.people, 0), 9),
    confidence: c !== null && Number.isFinite(c) ? roundHalfAway(Math.min(Math.max(c, 0), 1) * 100) / 100 : null,
    presentSeconds: p !== null && Number.isFinite(p) ? Math.min(Math.max(roundHalfAway(p / 5) * 5, 0), 3600) : null,
    gesture: src.gesture !== null ? short(src.gesture) : null,
    mood: short(src.mood),
    state: short(src.state),
    recent: src.recent.slice(-ExpressiveFeaturesStatics.maxRecent).map(short),
  };
}

/** `near` (< 1 m), `mid` (1–2.5 m) or `far`. */
export function distanceBand(metres: number): string | null {
  if (!Number.isFinite(metres) || !(metres > 0)) return null;
  return metres < 1 ? 'near' : metres <= 2.5 ? 'mid' : 'far';
}

/** `morning` 5–12, `afternoon` 12–17, `evening` 17–22, `night` otherwise. */
export function timeOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** The outcome of one expressive ask. */
export type ExpressiveAskResult =
  /** Mapped answers (`answers` shape) and the round trip in ms. */
  | { kind: 'answered'; answers: Record<string, Record<string, number>>; roundTripMs: number }
  /** Timed out or errored (counts toward the expressive breaker). */
  | { kind: 'failed' }
  /** The expressive breaker is open: nothing was sent. */
  | { kind: 'breakerOpen' }
  /** No decision model: nothing was sent. */
  | { kind: 'disabled' };
