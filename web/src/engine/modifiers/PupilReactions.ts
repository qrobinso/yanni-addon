// Port of FaceEngine/Modifiers/PupilReactions.swift: only `idleBeatKinds` so far (the facade's
// `oneShotBusyForPerception` needs it).
// TODO(WP5): rest of PupilReactions.swift — the PupilReactions modifier (name "PupilReactions", phase behaviour; the
// facade calls `markSomber(s)`, `eventSerial` and `events`); keep this static and register it in modifiers/index.ts.
import { OneShotKindSet } from '../OneShots';

export class PupilReactions {
  /// The idle personality beats (IdleBeats' kinds).
  static readonly idleBeatKinds = OneShotKindSet.of(['curiousTilt', 'doubleTake', 'delightedSquint', 'sideEye', 'crossEyed']);
}
