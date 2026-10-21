// Port of FacePerception/CollectScript.swift.
import type { RecordingSessionType } from './FeatureRecordFormat';
import { makeSessionLabel, type SessionLabel } from './FeatureRecordingStore';

/// One prompt card of a scripted session ("P2 · 1.5 m · thumbs down · in 3, 2, 1… go"). Its go-window is the label.
export interface CollectPrompt {
  /// The label written for the go-window: a gesture name, "looking", "notLooking", "crossing", or "none:<activity>".
  label: string;
  /// What the card says.
  title: string;
  person: string | null;
  distance: number | null;
  seconds: number;
  /// People the script puts in view (tracking presets).
  people: number | null;
}

/// The scripted presets of the Collect screen (design §5.4). Each is short so children can take part.
export type CollectPreset = 'handShapes' | 'bodyGestures' | 'nods' | 'hardNegatives' | 'eyeContact' | 'tracking';

type Item = [string, string, number];
const ITEMS: Record<CollectPreset, Item[]> = {
  handShapes: [['thumbsUp', 'thumbs up · right hand', 4], ['thumbsUp', 'thumbs up · left hand', 4],
    ['thumbsDown', 'thumbs down · right hand', 4], ['thumbsDown', 'thumbs down · left hand', 4],
    ['openPalm', 'open palm, held still', 4], ['peace', 'peace / V', 4], ['point', 'point at Yanni', 4],
    ['heartHands', 'heart hands (or the "I love you" sign)', 4], ['fist', 'fist (not a reaction)', 4],
    ['thumbsUp', 'thumbs up · rotate slowly', 5]],
  bodyGestures: [['wave', 'wave hello', 5], ['byeWave', 'wave bye and walk off', 6], ['clap', 'clap', 4],
    ['armsUp', 'arms up · "yay!"', 4], ['point', 'point to the side', 4], ['peekaboo', 'peekaboo', 6],
    ['dancing', 'dance!', 10], ['highFive', 'high-five the screen (near marks only)', 5]],
  nods: [['nod', 'nod yes', 4], ['nod', 'nod while talking', 6], ['none:shake', 'shake your head no', 4],
    ['none:talkSmallNods', 'talk with small nods to someone else', 8], ['none:walkNod', 'walk past nodding', 6]],
  hardNegatives: [['none:talkWithHands', 'talk with your hands', 10], ['none:cup', 'hold and drink from a cup', 8],
    ['none:phone', 'use your phone', 10], ['none:remote', 'hold the TV remote', 8],
    ['none:scratchFace', 'scratch your face', 5], ['none:hairGlasses', 'adjust your hair or glasses', 5],
    ['none:crossArms', 'cross your arms', 5], ['none:stretch', 'stretch', 6], ['none:fidget', 'fidget', 8],
    ['none:walkPast', 'walk past', 6], ['none:rude', 'a rude gesture (must never trigger)', 4]],
  eyeContact: [['looking', "look at Yanni's eyes", 8], ['looking', 'look into the camera lens', 8],
    ['looking', 'look at the screen corners', 8], ['notLooking', 'watch the TV (or where it would be)', 8],
    ['notLooking', 'look at your phone', 8], ['notLooking', 'look at the person beside you', 8],
    ['notLooking', 'look past the iPad, left', 8], ['notLooking', 'look past the iPad, right', 8],
    ['notLooking', 'look above the iPad', 8], ['notLooking', 'walk past looking ahead', 8]],
  tracking: [['crossing', 'cross in front of each other', 8], ['crossing', 'cross again, the other way', 8],
    ['crossing', 'sit down, then stand up', 8], ['crossing', 'leave through the door and come back', 15],
    ['crossing', 'walk behind the furniture', 8]],
};

export const CollectPreset = {
  allCases: ['handShapes', 'bodyGestures', 'nods', 'hardNegatives', 'eyeContact', 'tracking'] as readonly CollectPreset[],
  /// The tape marks on the floor (setup sheet).
  floorMarks: [0.6, 1, 1.3, 1.6, 2, 2.5, 3, 3.5] as readonly number[],
  title(p: CollectPreset): string {
    switch (p) {
      case 'handShapes': return 'Hand shapes';
      case 'bodyGestures': return 'Body gestures';
      case 'nods': return 'Nods';
      case 'hardNegatives': return 'Hard negatives';
      case 'eyeContact': return 'Eye-contact targets';
      case 'tracking': return 'Crossings & re-entries';
    }
  },
  sessionType(p: CollectPreset): RecordingSessionType {
    switch (p) {
      case 'hardNegatives': return 'hardNegatives';
      case 'eyeContact': return 'eyeContact';
      case 'tracking': return 'tracking';
      default: return 'scripted';
    }
  },
  /// (label, card text, seconds)
  items: (p: CollectPreset): readonly Item[] => ITEMS[p],
  /// The prompts for the declared participants at one floor mark (tracking runs everyone together).
  prompts(p: CollectPreset, participants: string[], distance: number | null): CollectPrompt[] {
    if (p === 'tracking') {
      return ITEMS[p].map(([label, title, seconds]) =>
        ({ label, title, person: null, distance: null, seconds, people: participants.length }));
    }
    return participants.flatMap((who) => ITEMS[p].map(([label, title, seconds]) =>
      ({ label, title, person: who, distance, seconds, people: 1 })));
  },
} as const;

export type ScriptedPhase =
  | { kind: 'countdown'; prompt: CollectPrompt; secondsLeft: number }
  | { kind: 'go'; prompt: CollectPrompt; secondsLeft: number }
  | { kind: 'rest'; next: CollectPrompt }
  | { kind: 'done' };

/// Runs a prompt list against the host clock: countdown (3 s) → go (the labelled window) → rest (2 s) → next.
export class ScriptedSessionRunner {
  countdown = 3;
  rest = 2;
  index = 0;
  /// Completed go-windows (appended as they end).
  labels: SessionLabel[] = [];
  emitted = -1;

  constructor(readonly prompts: CollectPrompt[], public stepStart: number) {}

  /// Advances to `now` and returns the current phase. Labels are emitted as each go-window ends.
  phase(now: number): ScriptedPhase {
    while (this.index < this.prompts.length) {
      const p = this.prompts[this.index];
      const goStart = this.stepStart + this.countdown, goEnd = goStart + p.seconds, next = goEnd + this.rest;
      if (now < goStart) return { kind: 'countdown', prompt: p, secondsLeft: Math.ceil(goStart - now) };
      if (now < goEnd) return { kind: 'go', prompt: p, secondsLeft: Math.ceil(goEnd - now) };
      if (this.emitted < this.index) {
        this.emitted = this.index;
        this.labels.push(makeSessionLabel(goStart, goEnd, p.label, { person: p.person, distance: p.distance, people: p.people }));
      }
      if (now < next && this.index + 1 < this.prompts.length) return { kind: 'rest', next: this.prompts[this.index + 1] };
      this.index += 1;
      this.stepStart = next;
    }
    return { kind: 'done' };
  }

  /// Skips the current prompt without labelling it (someone wasn't ready).
  skip(now: number): void {
    if (!(this.index < this.prompts.length)) return;
    // In a rest the current prompt is already labelled: skip the one coming up.
    this.index = (this.emitted >= this.index ? this.index + 1 : this.index) + 1;
    this.stepStart = now;
  }
}
