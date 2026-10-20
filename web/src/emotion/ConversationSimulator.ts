// Port of FaceEmotion/ConversationSimulator.swift.
import type { AgentState } from '../engine';
import type { EmotionLayer } from './EmotionLayer';
import type { EmotionCondition } from './EmotionTypes';
import { Decision, DecisionMessage, type Answers } from './Decision/DecisionMessage';

export type SimScenario = 'joke' | 'compliment' | 'sadNews' | 'teasing' | 'notForMe' | 'garbled' | 'bargeIn' |
  'decisionModelDown' | 'voiceServicesDown';

export type SimAction =
  | { kind: 'state'; state: AgentState }
  | { kind: 'message'; message: DecisionMessage }
  /// Sentence `index` of the turn becomes audible `delay` seconds after this step runs.
  | { kind: 'audioStart'; index: number; delay: number }
  | { kind: 'cancel' }
  | { kind: 'condition'; condition: EmotionCondition; on: boolean }
  | { kind: 'connect' };

export interface SimStep { at: number; action: SimAction }

const step = (at: number, action: SimAction): SimStep => ({ at, action });
const state = (s: AgentState): SimAction => ({ kind: 'state', state: s });
const audio = (index: number, delay: number): SimAction => ({ kind: 'audioStart', index, delay });

/// A fake conversation source: plays scripted turns through the real emotion layer (and, through it, the face), the
/// way the voice loop will — agent states, decisions over the wire format, sentence audio starts, barge-in, gate
/// outcomes and failures. The preview's "Simulate" buttons and the scenario tests use it.
///
/// The simulator never sets `notForMe` / `confused` itself: like the real conversation controller it waits for the
/// layer's `onGate` (the app's stand-in controller, or the test, sets the state).
export class ConversationSimulator {
  static readonly scenarios: readonly SimScenario[] = ['joke', 'compliment', 'sadNews', 'teasing', 'notForMe', 'garbled',
    'bargeIn', 'decisionModelDown', 'voiceServicesDown'];

  static title(s: SimScenario): string {
    switch (s) {
      case 'joke': return 'Joke';
      case 'compliment': return 'Compliment';
      case 'sadNews': return 'Sad news';
      case 'teasing': return 'Teasing';
      case 'notForMe': return 'Not for me';
      case 'garbled': return 'Garbled';
      case 'bargeIn': return 'Barge-in';
      case 'decisionModelDown': return 'Decision model down';
      case 'voiceServicesDown': return 'Voice services down';
    }
  }

  readonly layer: EmotionLayer;
  /// One line per executed step.
  onLog: ((line: string) => void) | null = null;
  private _running: SimScenario | null = null;
  private _turnId = '';
  get running(): SimScenario | null { return this._running; }
  get turnId(): string { return this._turnId; }
  private steps: SimStep[] = [];
  private next = 0;
  private startHost = 0;
  private counter = 0;

  constructor(layer: EmotionLayer) { this.layer = layer; }

  /// Starts a scenario at `hostTime` (replaces one already running).
  start(scenario: SimScenario, hostTime: number): void {
    this.counter += 1;
    this._turnId = `sim-${this.counter}`;
    this.steps = ConversationSimulator.script(scenario, this._turnId);
    this.next = 0;
    this.startHost = hostTime;
    this._running = scenario;
    this.tick(hostTime);
  }

  stop(): void { this._running = null; this.steps = []; this.next = 0; }

  /// Runs the steps due by `hostTime` (call once per frame, before or after `layer.afterFrame`).
  tick(hostTime: number): void {
    if (this._running === null) return;
    while (this.next < this.steps.length && this.steps[this.next].at <= hostTime - this.startHost + 1e-9) {
      this.run(this.steps[this.next].action, hostTime);
      this.next += 1;
    }
    if (this.next >= this.steps.length) this._running = null;
  }

  private run(a: SimAction, hostTime: number): void {
    switch (a.kind) {
      case 'state':
        this.layer.engine.setAgentState(a.state);
        this.onLog?.(`state ${a.state}`);
        break;
      case 'message':
        this.layer.receive(a.message);
        this.onLog?.(`message ${ConversationSimulator.describe(a.message)}`);
        break;
      case 'audioStart':
        this.layer.sentenceAudioStarted(this._turnId, a.index, hostTime + a.delay);
        this.onLog?.(`sentence ${a.index} audible in ${Math.trunc(a.delay * 1000)} ms`);
        break;
      case 'cancel':
        this.layer.cancelTurn(this._turnId);
        this.onLog?.('barge-in: turn cancelled');
        break;
      case 'condition':
        this.layer.setCondition(a.condition, a.on);
        this.onLog?.(`${a.condition} ${a.on ? 'on' : 'off'}`);
        break;
      case 'connect':
        this.layer.sessionConnected();
        this.onLog?.('session connected');
        break;
    }
  }

  static describe(m: DecisionMessage): string {
    switch (m.kind) {
      case 'decision': {
        const d = m.decision;
        return `${d.pass} ${d.turnId}${d.sentenceIndex === null ? '' : `#${d.sentenceIndex}`} ${d.top('feel')?.name ?? ''}`;
      }
      case 'gate': return `gate ${m.gate.kind}(turnId: "${m.gate.turnId}")`;
      case 'decisionModelUnavailable': return 'decisionModelUnavailable';
    }
  }

  // MARK: Scripts

  /// The decision model's `feel` answers.
  static readonly feelVocabulary: readonly string[] = ['Happiness', 'Excitement', 'Amazement', 'Surprise', 'Confusion',
    'Embarrassment', 'Sadness', 'Skepticism', 'Annoyance', 'Neutral'];

  /// A realistic answer set: the named feel probabilities, the rest spread over the vocabulary; intensity around
  /// `intensity` (1…5); the top reaction (`none` otherwise).
  static answers(feel: Record<string, number>, intensity: number, o: { intent?: string | null;
    reaction?: [string, number] | null; addressed?: number | null; understood?: number | null;
    stance?: [string, number] | null } = {}): Answers {
    const addressed = o.addressed === undefined ? 0.95 : o.addressed;
    const understood = o.understood === undefined ? 0.95 : o.understood;
    const f: Record<string, number> = {};
    const named = Object.values(feel).reduce((a, b) => a + b, 0);
    const others = ConversationSimulator.feelVocabulary.filter((n) => feel[n] === undefined);
    const rest = Math.max(1 - named, 0) / Math.max(others.length, 1);
    for (const n of ConversationSimulator.feelVocabulary) f[n] = feel[n] ?? rest;
    const lo = Math.floor(intensity), hi = Math.min(lo + 1, 5);
    const frac = intensity - lo;
    const inten: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const l = String(Math.max(lo, 1));
    inten[l] = (inten[l] ?? 0) + (1 - frac);
    inten[String(hi)] = (inten[String(hi)] ?? 0) + frac;
    const a: Answers = { feel: f, intensity: inten };
    if (o.intent != null) a.intent = o.intent === 'other' ? { other: 1 } : { [o.intent]: 0.85, other: 0.15 };
    const r = o.reaction ?? ['none', 0.9];
    a.reaction = r[0] === 'none' ? { none: r[1] } : { [r[0]]: r[1], none: 1 - r[1] };
    if (addressed !== null) a.addressed = { yes: addressed, no: 1 - addressed };
    if (understood !== null) a.understood = { yes: understood, no: 1 - understood };
    if (o.stance) {
      const [name, p] = o.stance;
      // The rest spread over the other stance answers.
      const st: Record<string, number> = {};
      const os = ['none', 'yes', 'strongYes', 'no', 'strongNo'].filter((x) => x !== name);
      for (const x of os) st[x] = Math.max(1 - p, 0) / os.length;
      st[name] = p;
      a.stance = st;
    }
    return a;
  }

  private static a(t: string, ans: Answers): SimAction {
    return { kind: 'message', message: DecisionMessage.decision(new Decision({ pass: 'utterance', turnId: t, answers: ans })) };
  }

  private static b(t: string, i: number, ans: Answers): SimAction {
    return { kind: 'message',
      message: DecisionMessage.decision(new Decision({ pass: 'sentence', turnId: t, sentenceIndex: i, answers: ans })) };
  }

  /// The scripted timeline (seconds from the start).
  static script(s: SimScenario, t: string): SimStep[] {
    const A = ConversationSimulator.a, B = ConversationSimulator.b, ans = ConversationSimulator.answers;
    const nb = { addressed: null, understood: null };
    const listen = [step(0, state('listening')), step(1.4, state('thinking'))];
    switch (s) {
      case 'joke':
        return [...listen,
          step(1.6, A(t, ans({ Happiness: 0.62, Excitement: 0.2 }, 4.4, { intent: 'joke' }))),
          step(2.2, B(t, 0, ans({ Happiness: 0.6, Excitement: 0.15 }, 4, nb))),
          step(2.4, state('speaking')), step(2.4, audio(0, 0.08)),
          step(3.0, B(t, 1, ans({ Happiness: 0.55, Amazement: 0.15 }, 3.5, nb))),
          step(3.9, audio(1, 0.08)),
          step(5.6, state('followUp')), step(10, state('idle')),
        ];
      case 'compliment':
        return [...listen,
          step(1.6, A(t, ans({ Happiness: 0.72, Embarrassment: 0.1 }, 4.4, { intent: 'compliment', reaction: ['affection', 0.82] }))),
          step(2.2, B(t, 0, ans({ Happiness: 0.66 }, 4, { reaction: ['affection', 0.6], ...nb }))),
          step(2.5, state('speaking')), step(2.5, audio(0, 0.08)),
          step(4.6, state('followUp')), step(9, state('idle')),
        ];
      case 'sadNews':
        return [...listen,
          step(1.6, A(t, ans({ Sadness: 0.66, Surprise: 0.08 }, 3.8, { intent: 'badNews', reaction: ['delight', 0.3] }))),
          step(2.3, B(t, 0, ans({ Sadness: 0.6, Neutral: 0.15 }, 3.4, nb))),
          step(2.5, state('speaking')), step(2.5, audio(0, 0.08)),
          step(3.4, B(t, 1, ans({ Happiness: 0.35, Sadness: 0.35 }, 3, { reaction: ['affection', 0.72], ...nb }))),
          step(4.2, audio(1, 0.08)),
          step(6.2, state('followUp')), step(11, state('idle')),
        ];
      case 'teasing':
        return [...listen,
          step(1.6, A(t, ans({ Annoyance: 0.66, Skepticism: 0.12 }, 4.3, { intent: 'teasing' }))),
          step(2.3, B(t, 0, ans({ Skepticism: 0.5, Happiness: 0.25 }, 3.2, nb))),
          step(2.6, state('speaking')), step(2.6, audio(0, 0.08)),
          step(4.6, state('followUp')), step(9, state('idle')),
        ];
      case 'notForMe':
        return [...listen,
          step(1.6, A(t, ans({ Neutral: 0.6 }, 2, { intent: 'other', addressed: 0.08 }))),
          step(1.65, { kind: 'message', message: DecisionMessage.gate({ kind: 'notForMe', turnId: t }) }),
        ];
      case 'garbled':
        return [...listen, step(1.5, { kind: 'message', message: DecisionMessage.gate({ kind: 'didNotUnderstand', turnId: t }) })];
      case 'bargeIn':
        return [...listen,
          step(1.6, A(t, ans({ Happiness: 0.5, Excitement: 0.2 }, 3.5, { intent: 'question' }))),
          step(2.2, B(t, 0, ans({ Happiness: 0.55 }, 3.5, nb))),
          step(2.4, state('speaking')), step(2.4, audio(0, 0.08)),
          step(3.0, B(t, 1, ans({ Excitement: 0.6 }, 4.5, { reaction: ['delight', 0.8], ...nb }))),
          step(3.3, state('interrupted')), step(3.3, { kind: 'cancel' }),
          step(3.6, audio(1, 0.08)),
        ];
      case 'decisionModelDown':
        return [...listen,
          step(1.8, { kind: 'message', message: DecisionMessage.decisionModelUnavailable }),
          step(2.4, state('speaking')), step(5, state('followUp')), step(9, state('idle')),
        ];
      case 'voiceServicesDown':
        return [
          step(0, state('listening')), step(1.4, state('thinking')),
          step(2.5, { kind: 'condition', condition: 'voiceServicesUnreachable', on: true }), step(2.5, state('sheepish')),
          step(9, { kind: 'condition', condition: 'voiceServicesUnreachable', on: false }), step(9, { kind: 'connect' }),
          step(9.1, state('noticing')),
          step(14, state('idle')),
        ];
    }
  }
}
