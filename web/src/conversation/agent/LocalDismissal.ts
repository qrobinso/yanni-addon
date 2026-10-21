// Port of ConversationAgent/LocalDismissal.swift. The fallback dismissal matcher (decision model design §4
// "Closing"), used only while the decision model can't answer (no HA-Jev, the breaker open, the gate failed open). It
// matches an unmistakable short dismissal said on its own: the whole utterance, after lowercasing, dropping
// punctuation and peeling off a few polite words ("okay", "thanks", "Yanni", "please"), must be one of `phrases`.
// shortcut: English only and exact phrases ("that'll be all", "see you later", "be quiet" don't match); upgrade by
// asking the decision model, which handles everything else.
import { characters, isLetterOrNumber } from './SentenceChunker';

export const LocalDismissal = {
  phrases: new Set([
    'go away', 'stop', 'never mind', 'nevermind', 'nothing else', "that's all", 'that is all', "that's it",
    'bye', 'bye bye', 'goodbye', 'good bye', 'no thanks', 'no thank you', "i'm done", 'i am done',
  ]),
  /** Words that may wrap a phrase without changing it ("okay, that's all, thanks Yanni"). */
  wrappers: new Set(['ok', 'okay', 'oh', 'um', 'uh', 'thanks', 'thank', 'you', 'yanni', 'please', 'now']),
  /** Longer utterances are never matched: a dismissal said alone is short. */
  maxWords: 7,

  matches(utterance: string): boolean {
    const cleaned = characters(utterance.toLowerCase().replaceAll('’', "'"))
      .map((c) => (isLetterOrNumber(c) || c === "'" ? c : ' ')).join('');
    const words = cleaned.split(' ').filter((w) => w !== '');
    if (words.length === 0 || words.length > LocalDismissal.maxWords) return false;
    const wrap = (w: string) => LocalDismissal.wrappers.has(w);
    // Every core words[i..<j] whose surrounding words are all wrappers ("no thank you" keeps its own "thank you").
    for (let i = 0; i < words.length; i++) {
      if (!words.slice(0, i).every(wrap)) continue;
      for (let j = words.length; j > i; j--) {
        if (!words.slice(j).every(wrap)) continue;
        if (LocalDismissal.phrases.has(words.slice(i, j).join(' '))) return true;
      }
    }
    return false;
  },
};
