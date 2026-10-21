// Port of FaceVoice/Generate/PhraseGenerator+Babble.swift (`PhraseGenerator.makeBabble` forwards here).
import { Phrase, type Note, type VoiceAffect } from '../model/VoiceModel';
import { BabblePlan, BabbleShaping, phraseEndEquals, type BabbleRequest, type PhraseSpec } from './BabbleShaping';
import type { BabbleContext } from './BabbleShaping+Melody';
import { EmotionMapping, type PhraseParams } from './EmotionMapping';
import { Novelty } from './Novelty';
import type { PhraseGenerator } from './PhraseGenerator';
import { PhraseShaping } from './PhraseShaping';
import { BabbleText, sentenceSyllables, type BabbleSentence } from './SyllableCounter';
import { VoiceRNG } from './VoiceRNG';

const M64 = (1n << 64n) - 1n;

/// Plans one reply chunk as babble (direct Home Assistant design §7.2): an optional answer chirp, then each
/// sentence as phrases of ≤ 8 notes with breath gaps, about one note per 1–2 syllables, punctuation contours, the
/// chunk's affect through the usual mapping and the fingerprint. Caps: no sentence longer than `sentenceCap`
/// (drop notes down to 2, then compress timing to ×0.75, then fit exactly); nothing past `budget` (sentences that
/// don't fit are dropped).
///
/// Deterministic: the babble's randomness comes from `request.seed` mixed with the generator's seed; the answer
/// chirp and the novelty history are the generator's own. Near-duplicates of the last 3 babble phrases are
/// re-rolled, so the same text never sounds the same twice.
export function makeBabble(g: PhraseGenerator, req: BabbleRequest): BabblePlan {
  const plan = new BabblePlan();
  const rng = new VoiceRNG(BigInt.asUintN(64, req.seed) ^ ((g.babbleSalt * 0x9e3779b97f4a7c15n) & M64) ^ 0xbabb1en);
  rng.next();
  const m = EmotionMapping.parameters(req.affect, g.fingerprint);
  const text = new BabbleText(req.text);
  const gs = BabbleShaping.gapScale(m.speed01);
  plan.textSyllables = text.syllables;
  plan.nextGap = rng.range(BabbleShaping.sentenceGap[0], BabbleShaping.sentenceGap[1]) * gs;
  const budget = Number.isFinite(req.budget) ? Math.max(req.budget, 0) : 0;
  const cap = Number.isFinite(req.sentenceCap) ? Math.max(req.sentenceCap, BabbleShaping.minSentence) : 1.5;
  let t = 0;

  if (req.answer !== null) {
    const p = g.make(req.answer, req.affect);
    p.affect = { ...req.affect };
    if (p.duration <= budget) {
      plan.items.push({ phrase: p, offset: 0, sentence: -1 });
      plan.answer = req.answer;
      t = lastNoteEnd(p) + Math.max(req.answerGap, 0);
    }
  }
  for (let si = 0; si < text.sentences.length; si++) {
    const s = text.sentences[si];
    if (si > 0) t += rng.range(BabbleShaping.sentenceGap[0], BabbleShaping.sentenceGap[1]) * gs;
    const room = Math.min(cap, budget - t);
    if (room < BabbleShaping.minSentence) {
      plan.droppedSentences = text.sentences.length - si;
      plan.compressed = true;
      break;
    }
    const last = req.isLast && si === text.sentences.length - 1;
    const r = babbleSentence(g, s, m, req.affect, room, last, rng);
    let end = 0;
    for (const [p, o] of r.items) {
      plan.items.push({ phrase: p, offset: t + o, sentence: si });
      end = Math.max(end, o + lastNoteEnd(p));
    }
    plan.sentenceDurations.push(r.duration);
    plan.sentences += 1;
    plan.syllables += sentenceSyllables(s);
    if (r.compressed) plan.compressed = true;
    t += end;
  }
  return plan;
}

/// End of a phrase's last note, before its release (s from the phrase start).
export function lastNoteEnd(p: Phrase): number {
  let e = 0;
  for (const n of p.notes) e = Math.max(e, n.start + n.duration);
  return e;
}

/// One sentence: layout under the cap, then draft, realise (with novelty) and place each phrase.
export function babbleSentence(g: PhraseGenerator, s: BabbleSentence, m: PhraseParams, affect: VoiceAffect, cap: number,
  lastChunk: boolean, rng: VoiceRNG): { items: [Phrase, number][]; duration: number; compressed: boolean } {
  let target = BabbleShaping.noteTarget(sentenceSyllables(s), m.a01);
  let specs = BabbleShaping.layout(s, target);
  let est = estimate(specs, m);
  let compressed = false;
  // 1. Drop notes (down to 2).
  while (est > cap && target > 2) {
    target = Math.max(2, Math.min(target - 1, Math.trunc(target * cap / est)));
    specs = BabbleShaping.layout(s, target);
    est = estimate(specs, m);
    compressed = true;
  }
  // 2. Compress timing (not below ×0.75).
  let timeScale = 1;
  if (est > cap) {
    timeScale = Math.max(BabbleShaping.minTimeScale, cap / est);
    compressed = true;
  }
  const gs = BabbleShaping.gapScale(m.speed01) * timeScale;
  const items: [Phrase, number][] = [];
  let t = 0;
  let before = 0;
  specs.forEach((spec, k) => {
    if (k > 0) {
      const gp = phraseEndEquals(specs[k - 1].end, { kind: 'comma' }) ? BabbleShaping.commaGap : BabbleShaping.splitGap;
      t += rng.range(gp[0], gp[1]) * gs;
    }
    const ctx: BabbleContext = { notesBefore: before, lastChunk, timeScale };
    const p = new Phrase();
    p.reaction = 'babble';
    p.affect = { ...affect };
    for (const n of realizeBabble(g, spec, m, ctx, rng)) if (p.notes.length < 8) p.notes.push(n);
    items.push([p, t]);
    t += lastNoteEnd(p);
    before += spec.notes.length;
  });
  // 3. Fit exactly when jitter still ran over.
  const dur = (): number => items.reduce((a, [p, o]) => Math.max(a, o + p.duration), 0);
  let duration = dur();
  const tail = items[items.length - 1];
  if (duration > cap && tail) {
    const release = tail[0].duration - lastNoteEnd(tail[0]);
    const k = Math.max(0.1, (cap - release) / Math.max(duration - release, 1e-3));
    for (const it of items) {
      it[1] *= k;
      for (const n of it[0].notes) {
        n.start *= k;
        n.duration = Math.max(0.04, n.duration * k);
      }
    }
    duration = dur();
    compressed = true;
  }
  return { items, duration, compressed };
}

/// Drafts and realises one phrase; near-duplicates of recent babble are re-rolled (3×), then shifted in register.
export function realizeBabble(g: PhraseGenerator, spec: PhraseSpec, m: PhraseParams, ctx: BabbleContext, rng: VoiceRNG): Note[] {
  let best: Note[] = [];
  let bestScore = -Infinity;
  for (let k = 0; k < 4; k++) {
    const d = BabbleShaping.draft(spec, m, ctx, rng);
    const notes = PhraseShaping.realize(d, m, g.fingerprint, rng);
    const s = g.novelty.score(notes, 'babble');
    if (s > bestScore) { best = notes; bestScore = s; }
    if (s >= Novelty.threshold) break;
  }
  if (bestScore < Novelty.threshold) best = g.perturb(best, 'babble', true);
  g.novelty.record(best, 'babble');
  return best;
}

/// Nominal length of a laid-out sentence (no jitter): notes, gaps, breaths and the last release.
export function estimate(specs: readonly PhraseSpec[], m: PhraseParams): number {
  const syl = BabbleShaping.syllableDuration(m.speed01);
  const wordGap = 0.075 + (0.035 - 0.075) * m.a01;
  const gs = BabbleShaping.gapScale(m.speed01);
  let t = 0;
  specs.forEach((spec, k) => {
    spec.notes.forEach((n, i) => {
      let d = syl * BabbleShaping.lengthFactor(n.syllables);
      if (i === spec.notes.length - 1 && spec.end.kind === 'sentence') d *= spec.end.ending === 'question' ? 1.5 : 1.15;
      t += d;
      if (i + 1 < spec.notes.length) t += spec.notes[i + 1].wordStart ? wordGap : 0.012;
    });
    if (k + 1 < specs.length) {
      const gp = phraseEndEquals(spec.end, { kind: 'comma' }) ? BabbleShaping.commaGap : BabbleShaping.splitGap;
      t += (gp[0] + gp[1]) / 2 * gs;
    }
  });
  return t + m.release;
}
