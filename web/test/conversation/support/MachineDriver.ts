// Port of ConversationTurnTests/MachineDriver.swift.
import {
  makeTurnTunables, stopFrames, TurnAudioFormat, TurnStateMachine, type LocalTurnEnd, type SmartTurnRequest,
  type TurnMachineOutput, type TurnSignal, type TurnTunables,
} from '../../../src/conversation/turn';

/** Drives a `TurnStateMachine` frame by frame on a fake timeline (32 ms frames, contiguous). */
export class MachineDriver {
  machine: TurnStateMachine;
  /** Start time of the next frame. */
  t: number;
  outputs: TurnMachineOutput[] = [];
  static readonly frame = TurnAudioFormat.frameDuration;

  constructor(tunables: TurnTunables = makeTurnTunables(), start = 100, open = true) {
    this.machine = new TurnStateMachine(tunables);
    this.t = start;
    if (open) this.machine.micOpened(start);
  }

  /** Feeds frames with these probabilities; returns what they produced. */
  frames(ps: number[], echoUntil = -Infinity): TurnMachineOutput[] {
    const out: TurnMachineOutput[] = [];
    for (const p of ps) {
      const start = this.t;
      this.t += MachineDriver.frame;
      const o = this.machine.frame(p, start, this.t, echoUntil);
      if (o) out.push(o);
    }
    this.outputs.push(...out);
    return out;
  }

  repeated(p: number, n: number, echoUntil = -Infinity): TurnMachineOutput[] {
    return this.frames(Array<number>(n).fill(p), echoUntil);
  }

  /** Starts a turn with two speech frames; returns the onset time. */
  startTurn(): number {
    const at = this.t;
    this.repeated(0.9, 2);
    return at;
  }

  /** Speech then silence until the Smart Turn request; returns it. */
  pauseUntilRequest(speechFrames = 10): SmartTurnRequest | null {
    this.repeated(0.9, speechFrames);
    for (const o of this.repeated(0.05, stopFrames(this.machine.tunables))) {
      if (o.kind === 'runSmartTurn') return o.request;
    }
    return null;
  }

  get signals(): TurnSignal[] {
    return this.outputs.flatMap((o) => (o.kind === 'signal' ? [o.signal] : []));
  }
}

export const sig = (o: TurnMachineOutput | null | undefined): TurnSignal | null => (o?.kind === 'signal' ? o.signal : null);
export const req = (o: TurnMachineOutput | null | undefined): SmartTurnRequest | null =>
  o?.kind === 'runSmartTurn' ? o.request : null;
export const turnEnd = (s: TurnSignal | null | undefined): LocalTurnEnd | null => (s?.kind === 'turnEnded' ? s.end : null);
export const approx = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
export function must<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}
