// Port of Tests/FaceVoiceTests/VoiceModelTests.swift.
import { expect, test } from 'vitest';
import { VocalContour } from '../../src/model';
import { Note, NoteBuffer, Phrase, VoiceFingerprint } from '../../src/voice';

// port-note: BitwiseCopyable / inline storage is Swift-only; the intent (capacity 8, bundled == default) is kept.
test('phraseIsBitwiseCopyableAndInline', () => {
  const p = new Phrase();
  for (let i = 0; i < 9; i++) NoteBuffer.append(p.notes, new Note({ start: i * 0.1, duration: 0.1, contour: VocalContour.flat(i) }));
  expect(p.notes.length).toBe(8);
  expect(p.notes[7].contour.start).toBe(7);
  expect(VoiceFingerprint.bundled().equals(VoiceFingerprint.default)).toBe(true);
});
