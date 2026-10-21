// Port of ConversationAgent/DecisionQuestions.swift. The versioned question set (`decision-questions.json`, design
// §6.4): the character brief, Pass A and Pass B in HA-Jev's `jev.ask` shape. Its `version` goes out as
// `decision.version`.
import { normalizedFeatures, type ExpressiveFeatures } from '../events/ExpressiveEvents';
import bundledJSON from './decision-questions.json';
import { arrayValue, at, objectValue, stringValue, type JSONObject, type JSONValue } from './JSONValue';
import { doubleValue, intValue, parseJSON } from './JSONValue+Agent';

export type Answers = Record<string, Record<string, number>>;

export class DecisionQuestionsLoadError extends Error {
  override name = 'DecisionQuestionsLoadError';
}

export class DecisionQuestions {
  /** key → question (`{type, instructions, …}`), exactly as sent. The expressive set (version 3+) may be empty. */
  constructor(readonly version: number, readonly character: string, readonly passA: JSONObject,
    readonly passB: JSONObject, readonly expressive: JSONObject = {}) {}

  /** The set bundled with the app. */
  static bundled(): DecisionQuestions { return DecisionQuestions.parse(bundledJSON as unknown as JSONValue); }

  static parse(data: string | JSONValue): DecisionQuestions {
    let v: JSONValue;
    try { v = typeof data === 'string' ? parseJSON(data) : data; } catch { throw new DecisionQuestionsLoadError('malformed'); }
    const version = intValue(at(v, 'version'));
    const character = stringValue(at(v, 'character'));
    const a = objectValue(at(v, 'passA'));
    const b = objectValue(at(v, 'passB'));
    if (version === null || character === null || !a || !b) throw new DecisionQuestionsLoadError('malformed');
    const x = objectValue(at(v, 'expressive')) ?? {};
    for (const q of [...Object.values(a), ...Object.values(b), ...Object.values(x)]) {
      if (stringValue(at(q, 'type')) === null) throw new DecisionQuestionsLoadError('malformed');
    }
    return new DecisionQuestions(version, character, a, b, x);
  }

  /** Pass A's `state`: brief + recent turns + the utterance. */
  passAState(utterance: string, recent: readonly RecentLine[]): JSONValue {
    return { character: this.character, recent: recent.map(recentLineJSON), utterance };
  }

  /** An expressive ask's `state` (expressive decisions design §5): the brief and the normalised features, with exactly
   *  `ExpressiveFeaturesStatics.documentedKeys` (optional ones only when set). Nothing else ever goes in. */
  expressiveState(features: ExpressiveFeatures): JSONValue {
    const f = normalizedFeatures(features);
    const o: JSONObject = {
      character: this.character, event: f.event, people: f.people, mood: f.mood, state: f.state,
      time_of_day: f.timeOfDay, bedtime: f.bedtime, recent: [...f.recent],
    };
    if (f.gesture !== null) o.gesture = f.gesture;
    if (f.confidence !== null) o.confidence = f.confidence;
    if (f.priority !== null) o.priority = f.priority;
    if (f.distance !== null) o.distance = f.distance;
    if (f.facing !== null) o.facing = f.facing;
    if (f.eyeContact !== null) o.eye_contact = f.eyeContact;
    if (f.presentSeconds !== null) o.present_s = f.presentSeconds;
    return o;
  }

  /** Pass B's `state`: brief + recent turns + the reply chunk Yanni is saying. */
  passBState(sentence: string, recent: readonly RecentLine[]): JSONValue {
    return { character: this.character, recent: recent.map(recentLineJSON), yanni_says: sentence };
  }
}

/** Jev's answers → the `answers` shape the emotion layer reads (design §6.4 table). Anything invalid omits its key
 *  (fail open for that question). */
export const DecisionAnswerMapping = {
  map(response: JSONValue, questions: JSONObject): Answers {
    const answers = objectValue(at(response, 'answers'));
    if (!answers) return {};
    const out: Answers = {};
    for (const [key, q] of Object.entries(questions)) {
      const a = answers[key];
      const type = stringValue(at(q, 'type'));
      if (a === undefined || type === null) continue;
      let mapped: Record<string, number> | null;
      switch (type) {
        case 'noul': mapped = DecisionAnswerMapping.noul(a); break;
        case 'choice': mapped = DecisionAnswerMapping.choice(a, new Set(Object.keys(objectValue(at(q, 'criteria')) ?? {}))); break;
        case 'score': mapped = DecisionAnswerMapping.score(a, arrayValue(at(q, 'criteria'))?.length ?? 0); break;
        default: mapped = null;
      }
      if (mapped) out[key] = mapped;
    }
    return out;
  },

  valid(p: number | null): number | null {
    if (p === null || !Number.isFinite(p) || p < 0 || p > 1) return null;
    return p;
  },

  /** `{"type":"noul","noul": p}` (p = P(yes)) → `{yes: p, no: 1 − p}`. */
  noul(a: JSONValue): Record<string, number> | null {
    const p = DecisionAnswerMapping.valid(doubleValue(at(a, 'noul')) ?? doubleValue(a));
    return p === null ? null : { yes: p, no: 1 - p };
  },

  /** `probabilities {option: p}` verbatim; an unknown option or a bad number omits the key. */
  choice(a: JSONValue, options: Set<string>): Record<string, number> | null {
    const probs = objectValue(at(a, 'probabilities'));
    if (!probs || Object.keys(probs).length === 0) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(probs)) {
      const p = DecisionAnswerMapping.valid(doubleValue(v));
      if ((options.size > 0 && !options.has(k)) || p === null) return null;
      out[k] = p;
    }
    return out;
  },

  /** `probabilities {"0": p, …, "n−1": p}` (0-based) → `"1"` … `"n"`. */
  score(a: JSONValue, levels: number): Record<string, number> | null {
    const probs = objectValue(at(a, 'probabilities'));
    if (levels <= 0 || !probs || Object.keys(probs).length === 0) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(probs)) {
      const i = /^[+-]?\d+$/.test(k) ? Number(k) : NaN;
      const p = DecisionAnswerMapping.valid(doubleValue(v));
      if (!Number.isInteger(i) || i < 0 || i >= levels || p === null) return null;
      out[String(i + 1)] = p;
    }
    return out;
  },
};

/** One line of the in-memory recent-turns list (the Jev `state`). Never logged, never persisted. */
export type RecentSpeaker = 'person' | 'yanni';
export interface RecentLine { speaker: RecentSpeaker; text: string }
export const recentLine = (speaker: RecentSpeaker, text: string): RecentLine => ({ speaker, text });
const recentLineJSON = (l: RecentLine): JSONValue => ({ speaker: l.speaker, text: l.text });
