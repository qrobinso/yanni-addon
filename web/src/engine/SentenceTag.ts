// Port of FaceEngine/SentenceTag.swift.
import type { V3 } from '../core/vec';
import type { OneShotKind } from './Commands';
import { isAnswer } from './OneShots';

/// What a reply sentence's decision-model tag (Pass B) means for how Yanni voices it in its own voice. Produced by the
/// emotion layer, consumed by the voice. It lives here because both sides depend on the face engine.
export interface SentenceTag {
  /// The probability-weighted PAD of the tag's `feel` answers (null when it has no usable feel).
  pad: V3 | null;
  /// How strongly the tag pulls the voice from the current mood toward `pad`, 0…1.
  strength: number;
  /// The answer one-shot a confident `stance` asks for, already claimed as this reply's one stance beat; null otherwise.
  answer: OneShotKind | null;
}

export function makeSentenceTag(pad: V3 | null = null, strength = 0, answer: OneShotKind | null = null): SentenceTag {
  return {
    pad: pad && { ...pad },
    strength: Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 1) : 0,
    answer: answer !== null && isAnswer(answer) ? answer : null,
  };
}
