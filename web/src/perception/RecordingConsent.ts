// Port of FacePerception/RecordingConsent.swift.
//
// Feature recording consent and limits (perception upgrade design §5.2, §13): developer-only, opt-in per session,
// the settings PIN set and entered, declared household participants (pseudonyms) with a stored consent (a guardian's
// for a child), auto-pause whenever more people are in view than were declared, hard caps, retention and delete.
import type { FrameDetections, PerceptionSnapshot } from './PerceptionTypes';

/// The text every participant (or a child's guardian) agrees to, shown before each session.
export const RecordingConsentText = {
  version: 1,
  text: 'Yanni will record movement data while this session runs: numbers only (where faces, bodies and hands are, head ' +
    'angles, eye measurements and what Yanni made of them). No pictures, video or sound are ever recorded.\n' +
    '• Only the declared participants may be in view; recording pauses by itself whenever anyone else appears.\n' +
    '• "● recording movement data" shows on Yanni\'s face for as long as it runs.\n' +
    '• Recordings are deleted from this iPad after the retention period (30 days unless changed). Sessions exported to ' +
    'the owner\'s Mac are kept there until the owner deletes them.\n' +
    '• Small models trained from these movements are kept on this iPad and on the owner\'s Mac, and are never published.\n' +
    '• Anyone can ask for their sessions to be deleted at any time (Status → What perception keeps → Delete).',
} as const;

/// One declared household participant and their consent record. Pseudonyms only (P1…Pn), never names.
export interface RecordingParticipant {
  pseudonym: string;
  isChild: boolean;
  /// "self", or the consenting guardian's pseudonym for a child.
  consentedBy: string;
  consentDate: Date;
  /// The consent text version they agreed to (a new text needs a new consent).
  consentTextVersion: number;
}

export const makeRecordingParticipant = (pseudonym: string, consentDate: Date,
  o: Partial<Omit<RecordingParticipant, 'pseudonym' | 'consentDate'>> = {}): RecordingParticipant =>
  ({ pseudonym, isChild: false, consentedBy: 'self', consentDate, consentTextVersion: RecordingConsentText.version, ...o });

/// Valid for recording: the current text, and a child's consent given by someone else.
export const participantIsValid = (p: RecordingParticipant): boolean =>
  p.consentTextVersion === RecordingConsentText.version && !(p.isChild && p.consentedBy === 'self') &&
  p.pseudonym.trim() !== '';

/// Who may be recorded and for how long recordings are kept. Stored with the recordings (`policy.json`), not in the
/// settings hub.
export class RecordingPolicy {
  /// The developer switch (changing it needs the PIN).
  allowed = false;
  /// 1…90 days on the device.
  retentionDays = 30;
  participants: RecordingParticipant[] = [];

  static readonly retentionRange: readonly [number, number] = [1, 90];

  validated(): RecordingPolicy {
    const v = new RecordingPolicy();
    v.allowed = this.allowed;
    v.retentionDays = Math.min(Math.max(this.retentionDays, RecordingPolicy.retentionRange[0]), RecordingPolicy.retentionRange[1]);
    const seen = new Set<string>();
    v.participants = this.participants.filter((p) => { if (seen.has(p.pseudonym)) return false; seen.add(p.pseudonym); return true; });
    return v;
  }

  toJSON(): Record<string, unknown> { return { allowed: this.allowed, retentionDays: this.retentionDays, participants: this.participants }; }

  /// Tolerant decoding: a missing or unreadable key keeps its default.
  static decode(text: string): RecordingPolicy {
    const p = new RecordingPolicy();
    let o: unknown;
    try { o = JSON.parse(text); } catch { return p; }
    if (o === null || typeof o !== 'object') return p;
    const j = o as Record<string, unknown>;
    if (typeof j.allowed === 'boolean') p.allowed = j.allowed;
    if (Number.isInteger(j.retentionDays)) p.retentionDays = j.retentionDays as number;
    if (Array.isArray(j.participants)) {
      p.participants = (j.participants as Record<string, unknown>[]).map((q) => ({ ...q, consentDate: new Date(q.consentDate as string) }) as RecordingParticipant);
    }
    return p;
  }
}

/// Hard limits.
export const RecordingLimits = {
  /// Per session.
  maxSessionSeconds: 2 * 3600,
  /// All sessions on the device together.
  maxTotalBytes: 2_000_000_000,
  /// One chunk file per this many seconds of frames.
  chunkSeconds: 60,
  /// Frames waiting for the writer before new ones are dropped (and counted).
  ringCapacity: 128,
} as const;

/// Why a session may not start.
export type RecordingStartCheck =
  | { kind: 'ok' } | { kind: 'notAllowed' } | { kind: 'noPIN' } | { kind: 'pinNotEntered' } | { kind: 'noParticipants' }
  | { kind: 'invalidConsent'; pseudonym: string } | { kind: 'consentNotConfirmed' } | { kind: 'storageFull' };

export const RecordingStartCheck = {
  message(c: RecordingStartCheck): string {
    switch (c.kind) {
      case 'ok': return 'ready';
      case 'notAllowed': return 'Recording is switched off (Allow recording).';
      case 'noPIN': return 'Set a Settings PIN first: recording is only possible while a PIN is set.';
      case 'pinNotEntered': return 'Enter the PIN to start.';
      case 'noParticipants': return 'Declare who takes part.';
      case 'invalidConsent': return `${c.pseudonym} has no valid consent (a child's must come from a guardian).`;
      case 'consentNotConfirmed': return 'Confirm the consent text with everyone taking part.';
      case 'storageFull': return 'Recordings use the 2 GB limit: delete some first.';
    }
  },
} as const;

/// What happens to one analysed frame while a session runs.
/// write · pauseUndeclared: more people in view than were declared, nothing is written · stop: a cap was reached.
export type RecordingFrameDecision = { kind: 'write' } | { kind: 'pauseUndeclared' } | { kind: 'stop'; reason: string };

/// The consent gate and the per-frame rule (pure; tested without files).
export const RecordingGate = {
  canStart(o: { policy: RecordingPolicy; pinSet: boolean; pinVerified: boolean; declared: string[]; consentConfirmed: boolean;
    storedBytes: number }): RecordingStartCheck {
    if (!o.policy.allowed) return { kind: 'notAllowed' };
    if (!o.pinSet) return { kind: 'noPIN' };
    if (!o.pinVerified) return { kind: 'pinNotEntered' };
    if (o.declared.length === 0) return { kind: 'noParticipants' };
    for (const p of o.declared) {
      const rec = o.policy.participants.find((q) => q.pseudonym === p);
      if (rec === undefined || !participantIsValid(rec)) return { kind: 'invalidConsent', pseudonym: p };
    }
    if (!o.consentConfirmed) return { kind: 'consentNotConfirmed' };
    if (!(o.storedBytes < RecordingLimits.maxTotalBytes)) return { kind: 'storageFull' };
    return { kind: 'ok' };
  },

  /// People in view: the tracker's people or the raw human rectangles, whichever is more (a visitor counts from
  /// their first detection, before their track is confirmed).
  peopleInView: (det: FrameDetections, snapshot: PerceptionSnapshot): number => Math.max(snapshot.people.length, det.bodies.length),

  decide(peopleInView: number, declared: number, elapsed: number, bytes: number, byteBudget: number): RecordingFrameDecision {
    if (elapsed >= RecordingLimits.maxSessionSeconds) return { kind: 'stop', reason: '2 h session limit' };
    if (bytes >= byteBudget) return { kind: 'stop', reason: '2 GB storage limit' };
    if (peopleInView > declared) return { kind: 'pauseUndeclared' };
    return { kind: 'write' };
  },
} as const;
