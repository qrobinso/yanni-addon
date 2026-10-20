// Port of FaceEngine/Modifier.swift.
import type { FaceState } from './FaceState';

/// Execution phase. Modifiers run in ascending phase, then registration order.
export const Phase = {
  behaviour: 10,
  affect: 20,
  expression: 30,
  attention: 40,
  motion: 50,
  lids: 60,
  output: 70,
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

/// A small, independent piece of face behaviour. Keeps its own private timers; communicates with other
/// modifiers only through `FaceState`.
export interface Modifier {
  readonly name: string;
  readonly phase: Phase;
  isEnabled: boolean;
  update(s: FaceState): void;
}

/// Phase-ordered modifier stack.
export class Director {
  private _modifiers: Modifier[] = [];
  private order: number[] = [];

  constructor(modifiers: Modifier[] = []) {
    for (const m of modifiers) this.add(m);
  }

  get modifiers(): readonly Modifier[] { return this._modifiers; }

  add(m: Modifier): void {
    this._modifiers.push(m);
    const ms = this._modifiers;
    this.order = ms.map((_, i) => i).sort((a, b) => (ms[a].phase !== ms[b].phase ? ms[a].phase - ms[b].phase : a - b));
  }

  /// The first modifier with this name, or undefined (Swift returns nil; callers cast as Swift's `as?` does).
  modifier(name: string): Modifier | undefined {
    return this._modifiers.find((m) => m.name === name);
  }

  /// Runs one frame: reset accumulators, run enabled modifiers in order.
  run(s: FaceState): void {
    s.resetFrameAccumulators();
    for (const i of this.order) {
      const m = this._modifiers[i];
      if (m.isEnabled) m.update(s);
    }
  }

  /// Modifiers in execution order (for the preview tool).
  get ordered(): Modifier[] { return this.order.map((i) => this._modifiers[i]); }
}
