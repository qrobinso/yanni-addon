// Port of FaceEmotion/Decision/DecisionMessage.swift.
import type { GateEvent } from '../EmotionTypes';

export type DecisionPass = 'utterance' | 'sentence';
export type Answers = Record<string, Record<string, number>>;

/// One decision-model answer set (decision model design §5): Pass A (`utterance`, while thinking) or Pass B
/// (`sentence`, a reply sentence's tag, applied when that sentence is heard).
export class Decision {
  /// Question-set version (`decision-questions.json`). Only `DecisionMessage.supportedVersions` are applied.
  version: number;
  pass: DecisionPass;
  /// The transport-minted turn id.
  turnId: string;
  /// Pass B: the reply sentence (0 = the first clause).
  sentenceIndex: number | null;
  /// Optional speaker id (topic keys for reaction cues; "session" when absent).
  speakerId: string | null;
  /// answer key → answer → probability (`feel`, `intensity`, `intent`, `addressed`, `understood`, `reaction`, and
  /// Pass B's `stance`: `none`, `yes`, `strongYes`, `no`, `strongNo`).
  answers: Answers;

  constructor(o: { version?: number; pass: DecisionPass; turnId: string; sentenceIndex?: number | null;
    speakerId?: string | null; answers: Answers }) {
    this.version = o.version ?? 1;
    this.pass = o.pass;
    this.turnId = o.turnId;
    this.sentenceIndex = o.sentenceIndex ?? null;
    this.speakerId = o.speakerId ?? null;
    this.answers = o.answers;
  }

  copy(): Decision {
    const a: Answers = {};
    for (const k of Object.keys(this.answers)) a[k] = { ...this.answers[k] };
    return new Decision({ ...this, answers: a });
  }

  equals(o: Decision): boolean {
    if (this.version !== o.version || this.pass !== o.pass || this.turnId !== o.turnId ||
      this.sentenceIndex !== o.sentenceIndex || this.speakerId !== o.speakerId) return false;
    const ka = Object.keys(this.answers), kb = Object.keys(o.answers);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      const a = this.answers[k], b = o.answers[k];
      if (!b || Object.keys(a).length !== Object.keys(b).length) return false;
      for (const n of Object.keys(a)) if (a[n] !== b[n]) return false;
    }
    return true;
  }

  /// The answers for `key`, finite and non-negative, sorted by probability (highest first; ties by name).
  distribution(key: string): { name: string; p: number }[] {
    const a = this.answers[key];
    if (!a) return [];
    const out: { name: string; p: number }[] = [];
    for (const name of Object.keys(a)) {
      const p = a[name];
      if (Number.isFinite(p) && p >= 0) out.push({ name, p });
    }
    // port-note: names compare by UTF-16 code unit (Swift: Unicode scalars); identical for the ASCII answer names.
    return out.sort((x, y) => (x.p !== y.p ? y.p - x.p : x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  }

  /// The most likely answer for `key`.
  top(key: string): { name: string; p: number } | null { return this.distribution(key)[0] ?? null; }

  /// P(`answer`) for `key` (null when the key is missing).
  p(key: string, answer: string): number | null {
    const a = this.answers[key];
    if (!a) return null;
    const v = a[answer] ?? 0;
    return Number.isFinite(v) ? v : 0;
  }
}

/// What the conversation client hands the emotion layer.
export type DecisionMessage =
  | { kind: 'decision'; decision: Decision }
  /// The gate: not addressed / not understood (nothing reached the agent).
  | { kind: 'gate'; gate: GateEvent }
  /// The decision model is unavailable (the conversation carries on untagged).
  | { kind: 'decisionModelUnavailable' };

export type DecodeResult =
  | { kind: 'message'; message: DecisionMessage }
  /// Valid JSON, but another message type (not the emotion layer's).
  | { kind: 'notOurs'; type: string }
  /// An envelope or question-set version this build doesn't know: ignored (the layer counts it).
  | { kind: 'unsupportedVersion'; version: number }
  | { kind: 'malformed'; why: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const malformed = (why: string): DecodeResult => ({ kind: 'malformed', why });

/// Sorted-key JSON (Swift `.sortedKeys`).
function sortedJSON(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJSON).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJSON(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const DecisionMessage = {
  decision: (d: Decision): DecisionMessage => ({ kind: 'decision', decision: d }),
  gate: (g: GateEvent): DecisionMessage => ({ kind: 'gate', gate: g }),
  decisionModelUnavailable: { kind: 'decisionModelUnavailable' } as DecisionMessage,

  /// Envelope major version (`"yanni": 1`) this build understands.
  envelopeVersion: 1,
  /// Question-set versions this build maps (2 adds Pass B's `stance`, 3 its `brow` and `gaze` and the expressive set,
  /// 4 Pass A's `closing`, which the conversation transport acts on and the mapping ignores).
  supportedVersions: new Set([1, 2, 3, 4]) as ReadonlySet<number>,

  equals(a: DecisionMessage, b: DecisionMessage): boolean {
    if (a.kind === 'decision') return b.kind === 'decision' && a.decision.equals(b.decision);
    if (a.kind === 'gate') return b.kind === 'gate' && a.gate.kind === b.gate.kind && a.gate.turnId === b.gate.turnId;
    return b.kind === a.kind;
  },

  /// Decodes a data-channel message (`{"yanni": 1, "type": "decision" | "notForMe" | "didNotUnderstand" |
  /// "decisionModelUnavailable", …}`).
  decode(data: string): DecodeResult {
    let obj: unknown;
    try { obj = JSON.parse(data); } catch { return malformed('not a JSON object'); }
    if (!isObj(obj)) return malformed('not a JSON object');
    const major = obj.yanni;
    if (isInt(major) && major !== DecisionMessage.envelopeVersion) return { kind: 'unsupportedVersion', version: major };
    const type = obj.type;
    if (typeof type !== 'string') return malformed('no type');
    switch (type) {
      case 'decision': {
        const version = obj.version;
        if (!isInt(version)) return malformed('decision without version');
        if (!DecisionMessage.supportedVersions.has(version)) return { kind: 'unsupportedVersion', version };
        const pass = obj.pass;
        if (pass !== 'utterance' && pass !== 'sentence') return malformed('decision without a valid pass');
        const turnId = obj.turnId;
        if (typeof turnId !== 'string' || turnId === '') return malformed('decision without turnId');
        const index = isInt(obj.sentenceIndex) ? obj.sentenceIndex : null;
        if (pass === 'sentence' && index === null) return malformed('sentence decision without sentenceIndex');
        const answers: Answers = {};
        if (isObj(obj.answers)) {
          for (const k of Object.keys(obj.answers)) {
            const dist = obj.answers[k];
            if (!isObj(dist)) continue;
            const out: Record<string, number> = {};
            for (const name of Object.keys(dist)) {
              const p = dist[name];
              // Swift reads NSNumber.floatValue: JSON booleans count as 1 / 0, and values are Float.
              const n = typeof p === 'number' ? p : typeof p === 'boolean' ? Number(p) : NaN;
              const f = Math.fround(n);
              if (Number.isFinite(f)) out[name] = f;
            }
            answers[k] = out;
          }
        }
        return { kind: 'message', message: DecisionMessage.decision(new Decision({ version, pass, turnId,
          sentenceIndex: pass === 'sentence' ? index : null,
          speakerId: typeof obj.speakerId === 'string' ? obj.speakerId : null, answers })) };
      }
      case 'notForMe': case 'didNotUnderstand': {
        const turnId = obj.turnId;
        if (typeof turnId !== 'string' || turnId === '') return malformed(`${type} without turnId`);
        return { kind: 'message', message: DecisionMessage.gate({ kind: type, turnId }) };
      }
      case 'decisionModelUnavailable':
        return { kind: 'message', message: DecisionMessage.decisionModelUnavailable };
      default:
        return { kind: 'notOurs', type };
    }
  },

  /// The wire JSON for a message (tests, replay fixtures), sorted keys.
  jsonData(m: DecisionMessage): string {
    const obj: Record<string, unknown> = { yanni: DecisionMessage.envelopeVersion };
    switch (m.kind) {
      case 'decision': {
        const d = m.decision;
        obj.type = 'decision';
        obj.version = d.version;
        obj.pass = d.pass;
        obj.turnId = d.turnId;
        if (d.sentenceIndex !== null) obj.sentenceIndex = d.sentenceIndex;
        if (d.speakerId !== null) obj.speakerId = d.speakerId;
        obj.answers = d.answers;
        break;
      }
      case 'gate':
        obj.type = m.gate.kind; obj.turnId = m.gate.turnId;
        break;
      case 'decisionModelUnavailable':
        obj.type = 'decisionModelUnavailable';
        break;
    }
    return sortedJSON(obj);
  },
} as const;
