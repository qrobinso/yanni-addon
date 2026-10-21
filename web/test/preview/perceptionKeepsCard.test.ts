// Status → "What perception keeps" (PerceptionKeepsCard.swift): off, allowed, recording with who is declared.
import { describe, expect, test } from 'vitest';
import { PerceptionHarness } from '../../src/app/PerceptionHarness';
import { FeatureRecordingStore, MemoryFileSystem, makeRecordingStatus } from '../../src/perception';
import { perceptionKeepsCard } from '../../src/preview/perception/PerceptionKeepsCard';

const row = (h: PerceptionHarness, label: string) => perceptionKeepsCard(h)!.rows.find((r) => r.label === label)?.value;

describe('perceptionKeepsCard', () => {
  test('recording off, allowed, then running with the declared participants', () => {
    const h = new PerceptionHarness({ store: new FeatureRecordingStore(new MemoryFileSystem(), 'Perception') });
    expect(perceptionKeepsCard(undefined)).toBeNull();
    expect(row(h, 'recording')).toBe('off');
    expect(row(h, 'participants')).toBe('none declared');
    h.access = { isPINRequired: true, verify: async () => 'ok' };
    h.setAllowed(true);
    const p1 = h.addParticipant(false, null)!.pseudonym;
    h.addParticipant(true, p1);
    expect(row(h, 'recording')).toBe('allowed, not running');
    expect(row(h, 'participants')).toBe('P1 and P2 (child)');
    h.status = { ...makeRecordingStatus(), state: 'paused', framesWritten: 12, elapsed: 4 };
    h.sessionType = 'none';
    h.declared = [p1];
    const card = perceptionKeepsCard(h)!;
    expect(card.detail).toBe('recording');
    expect(row(h, 'recording')).toMatch(/^paused \(undeclared person in view\) · "None" \(ordinary living\) · 4 s · 12 frames/);
    expect(row(h, 'declared')).toBe('P1');
    expect(card.note).toMatch(/Numbers only/);
  });
});
