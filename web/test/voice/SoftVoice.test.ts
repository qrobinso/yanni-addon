// Port of Tests/FaceVoiceTests/SoftVoiceTests.swift.
// The nod mirror's soft chirp (perception upgrade §6.4): −6 dB and shorter, on the same beats. Pure: no audio.
import { describe, expect, test } from 'vitest';
import { Phrase, PhraseGenerator, VoiceAffect, VoiceDirector } from '../../src/voice';
import { Rig, started } from './support';

describe('SoftVoiceTests', () => {
  test('softenedHalvesGainsShortensNotesAndKeepsOnsets', () => {
    const gen = new PhraseGenerator(undefined, 11n);
    const p = gen.make('mmHm', VoiceAffect.neutral);
    expect(p.notes.length).toBeGreaterThanOrEqual(2);
    const soft = VoiceDirector.softened(p);
    expect(soft.notes.length).toBe(p.notes.length);
    expect(soft.reaction === p.reaction && soft.id === p.id).toBe(true);
    for (let i = 0; i < p.notes.length; i++) {
      const a = p.notes[i], b = soft.notes[i];
      expect(b.start, `onset ${i} kept`).toBe(a.start);
      expect(b.gain, `note ${i} −6 dB`).toBe(a.gain * 0.5);
      expect(Math.abs(b.duration - a.duration * 0.75), `note ${i} shorter`).toBeLessThan(1e-6);
      expect(b.accent === a.accent && b.contour.equals(a.contour) && b.slur === a.slur).toBe(true);
    }
    expect(PhraseGenerator.alignNoteIndex(soft)).toBe(PhraseGenerator.alignNoteIndex(p));
    expect(soft.duration).toBeLessThan(p.duration);
  });

  test('softenedEmptyPhraseIsUnchanged', () => {
    const p = new Phrase();
    expect(VoiceDirector.softened(p).equals(p)).toBe(true);
  });

  test('softStartedOneShotIsVocalizedQuieter', () => {
    const gains = (soft: boolean): { gains: number[]; start: number } => {
      const rig = new Rig();
      const t = rig.now + 1.0 / 60.0;
      rig.injector.queued = [started('nodYes', t, 1, [VoiceDirector.accentTime('nodYes')], soft)];
      rig.frame();
      const rec = rig.director.lastScheduled!;
      expect(rec).not.toBeNull();
      expect(rec.pairedOneShot).toBe('nodYes');
      return { gains: rec.phrase.notes.map((n) => n.gain), start: rec.startHostTime };
    };
    const loud = gains(false), quiet = gains(true);
    expect(loud.gains.length).toBe(quiet.gains.length);
    loud.gains.forEach((a, i) => expect(Math.abs(quiet.gains[i] - 0.5 * a)).toBeLessThan(1e-6));
    expect(Math.abs(loud.start - quiet.start), 'same alignment on the nod\'s beat').toBeLessThan(1e-9);
  });
});
