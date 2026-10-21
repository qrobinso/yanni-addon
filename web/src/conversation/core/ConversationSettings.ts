// Port of ConversationCore/ConversationSettings.swift. What the conversation needs from the app's settings. The app
// pushes a new value whenever the settings change; the controller never persists anything itself.

export interface ConversationSettings {
  /** "Voice conversation" on/off. Off disconnects for good and leaves the face exactly as without voice services. */
  enabled: boolean;
  /** Spoken replies volume, 0…1. */
  voiceVolume: number;
  /** TTS volume factor during a bedtime night wake. */
  nightVoiceFactor: number;
  /** Quiet mode: no greeting; direct replies still speak; proactive held. */
  quietMode: boolean;
  /** "Sounds off": chirps and the greeting are silent, but replies still speak (review M10). */
  soundsOff: boolean;
  /** Play the cached greeting on the first engagement after an arrival. */
  greetingEnabled: boolean;
  /** Play the cached "I can't think right now" line when going sheepish (off by default). */
  cantThinkLine: boolean;
  /** Thinking this long without a reply → sheepish and `cancel-turn {thinking-timeout}` (owner setting, 4…20 s). */
  thinkingTimeout: number;
  /** Caption bubbles. Off: the controller emits no captions at all. */
  showCaptions: boolean;
  /** Look-to-talk opens the mic. Off: only hold to talk or the space bar engages. */
  listenOnEyeContact: boolean;
}

export function makeConversationSettings(s: Partial<ConversationSettings> = {}): ConversationSettings {
  return {
    enabled: true, voiceVolume: 0.8, nightVoiceFactor: 0.5, quietMode: false, soundsOff: false, greetingEnabled: true,
    cantThinkLine: false, thinkingTimeout: 8, showCaptions: true, listenOnEyeContact: true, ...s,
  };
}

export function conversationSettingsEqual(a: ConversationSettings, b: ConversationSettings): boolean {
  return (Object.keys(a) as (keyof ConversationSettings)[]).every((k) => a[k] === b[k]);
}

/** The thinking timeout inside its range. */
export function clampedThinkingTimeout(s: ConversationSettings): number {
  return Number.isFinite(s.thinkingTimeout) ? Math.min(Math.max(s.thinkingTimeout, 4), 20) : 8;
}

/** Gain for the remote (TTS) audio now. */
export function playoutGain(s: ConversationSettings, nightWake: boolean): number {
  const v = Number.isFinite(s.voiceVolume) ? Math.min(Math.max(s.voiceVolume, 0), 1) : 0.8;
  const n = Number.isFinite(s.nightVoiceFactor) ? Math.min(Math.max(s.nightVoiceFactor, 0), 1) : 0.5;
  return nightWake ? v * n : v;
}

/** Tunables (seconds). Starting points from the design. */
export interface ConversationTimings {
  /** Unmute rule (review L6): unmute = max(engagedAt + minDelay, audibleUntil + afterAudible). */
  unmuteMinDelay: number;
  unmuteMinDelayNight: number;
  unmuteAfterAudible: number;
  /** Engaged without a usable session (or audio still switching) this long → sheepish. */
  engagedConnectTimeout: number;
  /** The warm-up stays wanted this long after its last signal. */
  warmUpLinger: number;
  /** Conversation audio stays on this long after it was last wanted. */
  audioModeHold: number;
  /** The listening glow while engaged and getting ready to listen; full once the mic opens. */
  getReadyGlow: number;
  /** Listening with no speech → noticing. */
  listenTimeout: number;
  /** No turn signal for this long while a user turn is open (detector stalled) → back to noticing. */
  turnWatchdog: number;
  followUpWindow: number;
  /** After a dismissal, eye contact doesn't open the mic (and no announcement turn starts) for this long. */
  dismissGazeHold: number;
  /** Safety nets when a one-shot never reports completion. */
  notForMeFallback: number;
  confusedFallback: number;
  interruptedFallback: number;
  /** Sheepish caused by a failed turn (session still up) recovers to noticing after this long. */
  sheepishTurnRecovery: number;
  /** Sheepish (L9): a new engagement retries the voice services at most once per this window. */
  sheepishRetryWindow: number;
  /** End-of-reply watchdog after `reply-end`. */
  drainCap: number;
  /** Session: disconnect after nobody present this long. */
  absentDisconnect: number;
  /** Session and voice processing: drop after someone present this long without engaging or facing Yanni. */
  unengagedDisconnect: number;
  /** Greeting: an arrival is presence after at least this long with nobody around. */
  arrivalAbsence: number;
  /** The greeting starts this long after the engaged chirp's audible end (or engagement if no chirp). */
  greetingGap: number;
  /** Mood reports (review C4). */
  moodHeartbeat: number;
  moodLabelMinGap: number;
  /** After an `unavailable` proactive delivery, the same person isn't offered a batch again for this long. */
  proactiveUnavailableHold: number;
  /** Context updates at most this often. */
  contextMinGap: number;
  /** A manual engagement made while asleep or still waking waits this long for the tap wake to finish. */
  manualWakeWindow: number;
}

export function makeConversationTimings(t: Partial<ConversationTimings> = {}): ConversationTimings {
  return {
    unmuteMinDelay: 0.25, unmuteMinDelayNight: 0.3, unmuteAfterAudible: 0.1, engagedConnectTimeout: 3, warmUpLinger: 10,
    audioModeHold: 60, getReadyGlow: 0.35, listenTimeout: 5, turnWatchdog: 30, followUpWindow: 6, dismissGazeHold: 20,
    notForMeFallback: 3, confusedFallback: 2.5, interruptedFallback: 1.5, sheepishTurnRecovery: 4,
    sheepishRetryWindow: 30, drainCap: 4, absentDisconnect: 20, unengagedDisconnect: 90, arrivalAbsence: 120,
    greetingGap: 0.05, moodHeartbeat: 60, moodLabelMinGap: 1, proactiveUnavailableHold: 600, contextMinGap: 2,
    manualWakeWindow: 4, ...t,
  };
}
