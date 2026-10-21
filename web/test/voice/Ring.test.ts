// Port of Tests/FaceVoiceTests/RingTests.swift.
import { describe, expect, test } from 'vitest';
import { PhraseRing, makeQueuedPhrase } from '../../src/voice';
import { Fx } from './RendererFixtures';

const item = (id: number) => { const q = makeQueuedPhrase(); q.phrase.id = id; return q; };

describe('RingTests', () => {
  test('ringIsFIFOAndRejectsNewestWhenFull', () => {
    const ring = new PhraseRing();
    for (let i = 0; i < PhraseRing.capacity; i++) expect(ring.push(item(i))).toBe(true);
    const extra = item(99);
    expect(!ring.push(extra)).toBe(true);                  // newest rejected
    for (let i = 0; i < PhraseRing.capacity; i++) {
      expect(ring.peek()?.phrase.id).toBe(i);
      ring.pop();
    }
    expect(ring.peek()).toBeNull();
    expect(ring.push(extra)).toBe(true);
    expect(ring.peek()?.phrase.id).toBe(99);
  });

  test('rendererEnqueueRejectsWhenRingFullThenRecovers', () => {
    const r = Fx.renderer();
    const far = Fx.host0 + Fx.ticks(5);
    for (let i = 0; i < 8; i++) expect(r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.1 })], i), far)).toBe(true);
    expect(r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.1 })], 100), far)).toBe(false);
    // The audio thread moves up to `voiceCapacity` phrases into its active table, freeing ring slots.
    Fx.render(r, 0.01);
    expect(r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.1 })], 101), far)).toBe(true);
  });

  // port-note: the Swift test races a detached consumer task against the producer (lock-free SPSC). The port's ring is
  // single-threaded, so this keeps the intent with a deterministic interleaving of pushes and partial drains.
  test('concurrentProducerConsumerPreservesOrder', () => {
    const ring = new PhraseRing();
    const n = 20_000;
    let expected = 0;
    let i = 0;
    let step = 0;
    while (expected < n) {
      const pushes = 1 + (step % 11);
      for (let k = 0; k < pushes && i < n; k++) { if (ring.push(item(i))) i += 1; else break; }
      const pops = 1 + ((step * 7) % 5);
      for (let k = 0; k < pops; k++) {
        const p = ring.peek();
        if (p === null) break;
        expect(p.phrase.id).toBe(expected);
        ring.pop();
        expected += 1;
      }
      step += 1;
    }
    expect(i).toBe(n);
  });
});
