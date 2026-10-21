// Port of FaceVoice/DSP/PhraseRing.swift.
// port-note: the Swift ring is a lock-free SPSC queue between the main actor and the audio thread. Here producer and
// consumer share one thread (node tests, or the worklet after the port's message hop), so it is a plain bounded FIFO
// with the same capacity and "full → reject the newest" rule.
import { Phrase } from '../model/VoiceModel';

/// What the producer hands to the renderer: the phrase plus everything needed to play it.
export interface QueuedPhrase {
  phrase: Phrase;
  /// Start host time (seconds; port-note: mach ticks in Swift) — the buffer host time at which the first sample
  /// should be rendered.
  startHostTime: number;
  /// ≥ 1: all note times/envelopes are stretched by this factor (pitch unchanged).
  timeStretch: number;
  /// Cancel generation at enqueue time; the renderer drops/fades anything older than the current one.
  generation: number;
  /// Fingerprint snapshot taken at enqueue (absolute pitch base and cap in Hz, overall loudness 0…1).
  baseHz: number;
  maxHz: number;
  loudness: number;
}

export const makeQueuedPhrase = (o: Partial<QueuedPhrase> = {}): QueuedPhrase => ({
  phrase: new Phrase(), startHostTime: 0, timeStretch: 1, generation: 0, baseHz: 660, maxHz: 1600, loudness: 0.7, ...o,
});

export class PhraseRing {
  static readonly capacity = 8;
  private readonly slots: QueuedPhrase[] = [];

  /// Producer side. Returns false when full.
  push(item: QueuedPhrase): boolean {
    if (this.slots.length >= PhraseRing.capacity) return false;
    this.slots.push(item);
    return true;
  }

  /// Consumer side: the oldest item, valid until `pop()`; null when empty.
  peek(): QueuedPhrase | null { return this.slots.length > 0 ? this.slots[0] : null; }

  /// Consumer side: releases the oldest slot.
  pop(): void { this.slots.shift(); }

  get count(): number { return this.slots.length; }
}
