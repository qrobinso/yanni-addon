// Port of yanni/Conversation/EmotionLayerSink.swift: the controller's `EmotionSink` on the real emotion layer (review
// H1). Decisions, sentence audio starts and cancelled turns go to the layer's own scheduler; its validated gate
// outcomes come back to the controller. A gate that arrives outside a hand-over (the simulator's) goes to `onOtherGate`.
import type { DecisionPayload, MoodReportPayload } from '../../conversation/events';
import type { DecisionWireMessage, EmotionSink, GateEvent } from '../../conversation/core/Ports';
import { Decision, DecisionMessage } from '../../emotion/Decision/DecisionMessage';
import type { EmotionLayer } from '../../emotion/EmotionLayer';
import type { GateEvent as LayerGateEvent, MoodReport } from '../../emotion/EmotionTypes';

export class EmotionLayerSink implements EmotionSink {
  onGate: ((g: GateEvent) => void) | null = null;
  /** Gates the controller didn't hand over (the preview simulator). */
  onOtherGate: ((g: LayerGateEvent) => void) | null = null;
  private forwarding = false;

  constructor(readonly layer: EmotionLayer) {
    layer.onGate = (g) => this.layerGate(g);
  }

  receive(message: DecisionWireMessage): void {
    this.forwarding = true;
    try { this.layer.receive(EmotionLayerSink.map(message)); } finally { this.forwarding = false; }
  }

  cancelTurn(turnId: string): void { this.layer.cancelTurn(turnId); }

  sentenceAudioStarted(turnId: string, index: number, hostTime: number): void {
    this.layer.sentenceAudioStarted(turnId, index, hostTime);
  }

  private layerGate(g: LayerGateEvent): void {
    if (!this.forwarding) { this.onOtherGate?.(g); return; }
    this.onGate?.({ kind: g.kind, turnId: g.turnId });
  }

  static map(m: DecisionWireMessage): DecisionMessage {
    switch (m.kind) {
      case 'decision': return DecisionMessage.decision(EmotionLayerSink.decision(m.payload));
      case 'notForMe': return DecisionMessage.gate({ kind: 'notForMe', turnId: m.payload.turnId });
      case 'didNotUnderstand': return DecisionMessage.gate({ kind: 'didNotUnderstand', turnId: m.payload.turnId });
      case 'decisionModelUnavailable': return DecisionMessage.decisionModelUnavailable;
    }
  }

  /** A decision payload as the layer's `Decision` (non-finite probabilities dropped). */
  static decision(d: DecisionPayload): Decision {
    const answers: Record<string, Record<string, number>> = {};
    for (const [key, dist] of Object.entries(d.answers)) {
      const out: Record<string, number> = {};
      for (const [name, p] of Object.entries(dist)) if (Number.isFinite(p)) out[name] = Math.fround(p);
      answers[key] = out;
    }
    const pass = d.pass === 'sentence' ? 'sentence' : 'utterance';
    return new Decision({ version: d.version, pass, turnId: d.turnId,
      sentenceIndex: pass === 'sentence' ? d.sentenceIndex : null, answers });
  }
}

/** The emotion layer's report, field for field (the trigger isn't on the wire). */
export function moodReportPayload(r: MoodReport): MoodReportPayload {
  return { version: r.version, felt: { ...r.felt }, mood: { ...r.mood }, label: r.label, moodLabel: r.moodLabel,
    boredom: r.boredom, conditions: [...r.conditions] };
}
