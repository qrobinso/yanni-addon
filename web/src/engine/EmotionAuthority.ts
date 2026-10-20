// Port of FaceEngine/EmotionAuthority.swift.
import { AgentState } from './AgentState';
import { isRecord } from './SettingsSupport';

/// How much of the emotion layer's expression each agent state lets show (0…1), emotion layer design §6. The state is
/// the message where authority is 0 and the life cycle owns the sleepy faces; feeling shows most when nothing else is
/// going on. Stored as one lane per state.
export class EmotionAuthority {
  private readonly lanes = new Float64Array(16);

  /// The starting table.
  constructor() {
    for (const s of AgentState.allCases) this.lanes[EmotionAuthority.lane(s)] = EmotionAuthority.defaultValue(s);
  }

  static defaultValue(s: AgentState): number {
    switch (s) {
      case 'idle': case 'followUp': case 'speaking': return 0.6;
      case 'thinking': return 0.55;
      case 'noticing': case 'listening': return 0.45;
      case 'engaged': case 'hasMessage': return 0.3;
      case 'interrupted': case 'notForMe': case 'confused': case 'sheepish': return 0;
      case 'drowsy': case 'asleep': case 'halfAwake': case 'waking': return 0;
    }
  }

  /// Lane index = the state's declaration order.
  static lane(s: AgentState): number { return AgentState.allCases.indexOf(s); }

  get(s: AgentState): number { return this.lanes[EmotionAuthority.lane(s)]; }
  set(s: AgentState, v: number): void { this.lanes[EmotionAuthority.lane(s)] = v; }

  copy(): EmotionAuthority { const e = new EmotionAuthority(); e.lanes.set(this.lanes); return e; }
  equals(o: EmotionAuthority): boolean { return this.lanes.every((v, i) => v === o.lanes[i]); }

  /// Every lane clamped to 0…1 (non-finite back to its default).
  validated(): EmotionAuthority {
    const v = this.copy();
    for (const s of AgentState.allCases) {
      const x = this.get(s);
      v.set(s, Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : EmotionAuthority.defaultValue(s));
    }
    return v;
  }

  /// Codable as {"idle": 0.6, …}; missing or unreadable states keep their defaults.
  static fromJSON(json: unknown): EmotionAuthority {
    const e = new EmotionAuthority();
    if (isRecord(json)) for (const s of AgentState.allCases) if (typeof json[s] === 'number') e.set(s, json[s]);
    return e.validated();
  }

  toJSON(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const s of AgentState.allCases) o[s] = this.get(s);
    return o;
  }
}
