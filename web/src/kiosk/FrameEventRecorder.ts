// Port of FaceRuntime/FrameEventRecorder.swift. The always-on, per-frame half of the event log (hardening design §6.6):
// after every frame it compares the engine's agent state, started one-shots and the voice's last scheduled phrase
// with what it saw last, and queues what changed as raw events in a fixed ring. No strings and no allocation on the
// frame path apart from the event objects on a change; `drain` formats them later (about 1 Hz).
import type { AgentState } from '../engine/AgentState';
import type { FaceEngine } from '../engine/FaceEngine';
import type { OneShotKind } from '../engine/Commands';
import { answerTitle } from '../engine/OneShots';
import type { VoiceDirector } from '../voice/bridge/VoiceDirector';

export type FrameEventKind =
  | { kind: 'agentState'; from: AgentState; to: AgentState; seconds: number }
  | { kind: 'oneShot'; oneShot: OneShotKind; rate: number }
  | { kind: 'chirp'; reaction: string; notes: number; seconds: number; isAuto: boolean; paired: OneShotKind | null; audible: boolean };

export interface FrameEvent { serial: number; hostTime: number; kind: FrameEventKind }

export class FrameEventRecorder {
  static readonly capacity = 256;

  /// Events overwritten before they were drained.
  dropped = 0;
  serial = 0;
  private ring: (FrameEvent | null)[] = new Array(FrameEventRecorder.capacity).fill(null);
  private head = 0;
  private stored = 0;
  private lastAgent: AgentState;
  private lastEnteredAt: number;
  private lastPhraseID: number;

  constructor(readonly engine: FaceEngine, readonly voice: VoiceDirector | null) {
    this.lastAgent = engine.state.agentState;
    this.lastEnteredAt = engine.state.agentStateEnteredAt;
    this.lastPhraseID = voice?.lastScheduled?.phrase.id ?? 0;
  }

  /// Events waiting to be drained.
  get count(): number { return this.stored; }

  /// Per-frame hook. Cheap compares; writes into the ring only when something started or changed.
  noteFrame(hostTime: number): void {
    const s = this.engine.state;
    if (s.agentState !== this.lastAgent) {
      const entered = s.agentStateEnteredAt;
      this.push(hostTime, { kind: 'agentState', from: this.lastAgent, to: s.agentState, seconds: Math.max(entered - this.lastEnteredAt, 0) });
      this.lastAgent = s.agentState;
      this.lastEnteredAt = entered;
    }
    for (const o of s.startedOneShots) this.push(hostTime, { kind: 'oneShot', oneShot: o.kind, rate: o.rate });
    const sch = this.voice?.lastScheduled;
    if (sch && sch.phrase.id !== this.lastPhraseID) {
      this.lastPhraseID = sch.phrase.id;
      this.push(hostTime, { kind: 'chirp', reaction: String(sch.phrase.reaction), notes: sch.phrase.notes.length,
        seconds: sch.phrase.duration * sch.timeStretch, isAuto: sch.isAuto, paired: sch.pairedOneShot, audible: sch.audible });
    }
  }

  private push(hostTime: number, kind: FrameEventKind): void {
    this.serial += 1;
    this.ring[this.head] = { serial: this.serial, hostTime, kind };
    this.head = (this.head + 1) % FrameEventRecorder.capacity;
    if (this.stored === FrameEventRecorder.capacity) this.dropped += 1; else this.stored += 1;
  }

  /// Hands every queued event to `body`, oldest first, and empties the queue.
  drain(body: (e: FrameEvent) => void): void {
    const cap = FrameEventRecorder.capacity;
    let i = (this.head - this.stored + cap) % cap;
    const n = this.stored;
    this.stored = 0;
    for (let k = 0; k < n; k++) {
      body(this.ring[i]!);
      i = (i + 1) % cap;
    }
  }

  /// The Status subsystem an event belongs to (DevStatusModel.drainFrameEvents: chirps are Voice, the rest Face).
  static category(k: FrameEventKind): 'Face' | 'Voice' { return k.kind === 'chirp' ? 'Voice' : 'Face'; }

  /// The event log line for an event (the wording the Status page always used).
  static describe(k: FrameEventKind): string {
    switch (k.kind) {
      case 'agentState': return `state ${k.from} → ${k.to} (was ${k.seconds.toFixed(1)} s in ${k.from})`;
      case 'oneShot': {
        const line = `one-shot ${k.oneShot} (rate ${k.rate.toFixed(2)})`;
        const title = answerTitle(k.oneShot);
        return title !== null ? `${line} · "${title}"` : line;
      }
      case 'chirp': {
        let t = `chirp ${k.reaction} · ${k.notes} notes · ${k.seconds.toFixed(2)} s`;
        if (k.isAuto) t += ' · auto';
        if (k.paired) t += ` · +${k.paired}`;
        if (!k.audible) t += ' · silent';
        return t;
      }
    }
  }
}
