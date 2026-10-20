// Port of FaceEngine/BackgroundBurstStyle.swift.
import { OneShotKind } from './Commands';

export type BackgroundBurstTint =
  /// No burst (sleepy and quiet one-shots).
  | { kind: 'none' }
  /// Swell toward an authored colour (sRGB hex); `alternate` when the mood colour is already close to `primary`.
  | { kind: 'colour'; primary: number; alternate: number }
  /// A lightness and chroma lift of the mood colour itself.
  | { kind: 'lift' };

export const tintEquals = (a: BackgroundBurstTint, b: BackgroundBurstTint): boolean =>
  a.kind === b.kind && (a.kind !== 'colour' || (b.kind === 'colour' && a.primary === b.primary && a.alternate === b.alternate));

const NONE: BackgroundBurstTint = { kind: 'none' };
const LIFT: BackgroundBurstTint = { kind: 'lift' };
const colour = (primary: number, alternate: number): BackgroundBurstTint => ({ kind: 'colour', primary, alternate });

/// Seconds held at the peak before the release (`BackgroundBurst.defaultHold`; here to avoid an import cycle).
const DEFAULT_HOLD = 0.12;

/// How one one-shot kind colours the mood background for a moment (mood background design §4, "Colour bursts").
/// Authored data: the burst table is an array indexed by `OneShotKind.ordinal`, editable at runtime.
export class BackgroundBurstStyle {
  constructor(public tint: BackgroundBurstTint, public strength: number, public hold: number = DEFAULT_HOLD) {}

  static readonly none = new BackgroundBurstStyle(NONE, 0);

  get isNone(): boolean { return this.tint.kind === 'none' || !(this.strength > 0); }

  equals(o: BackgroundBurstStyle): boolean {
    return tintEquals(this.tint, o.tint) && this.strength === o.strength && this.hold === o.hold;
  }

  // MARK: Burst families (sRGB)

  /// Warm marigold (joy) → warm peach over a mustard or marigold mood.
  static readonly marigold = colour(0xffb43c, 0xff9c72);
  /// Soft pink (affection) → salmon over a pink mood.
  static readonly pink = colour(0xf59cc3, 0xf7927f);
  /// Soft aqua (surprise) → sky over an aqua mood.
  static readonly aqua = colour(0x84dccb, 0x8cc6f2);
  /// Coral (indignation) → rose over a coral mood.
  static readonly coral = colour(0xf6825a, 0xeb8daa);
  /// Soft violet (music) → periwinkle over a lavender mood.
  static readonly violet = colour(0xb79aea, 0x92b4ee);
  static readonly lift = LIFT;

  /// The authored burst for each one-shot kind.
  static standard(kind: OneShotKind): BackgroundBurstStyle {
    const S = BackgroundBurstStyle, B = (t: BackgroundBurstTint, s: number, h?: number): BackgroundBurstStyle => new S(t, s, h);
    switch (kind) {
      // Big joy and delight.
      case 'laugh': return B(S.marigold, 0.85);
      case 'nodYesBig': return B(S.marigold, 0.8);
      case 'starEyes': return B(S.marigold, 0.9, 0.35);
      case 'dance': return B(S.marigold, 0.6, 0.4);
      case 'delightedSquint': return B(S.marigold, 0.5);
      case 'popUp': return B(S.marigold, 0.45);
      // Affection and shyness.
      case 'heartEyes': return B(S.pink, 0.85, 0.45);
      case 'shyPeek': return B(S.pink, 0.4);
      case 'sorryBlink': return B(S.pink, 0.35);
      case 'crossEyed': return B(S.pink, 0.35);
      // Surprise.
      case 'bigSurprise': return B(S.aqua, 0.8);
      case 'exclaimEyes': return B(S.aqua, 0.75, 0.25);
      case 'doubleTake': return B(S.aqua, 0.45);
      // Indignation.
      case 'mockOffense': return B(S.coral, 0.7, 0.25);
      case 'shakeNoBig': return B(S.coral, 0.75);
      // Music.
      case 'noteEyes': return B(S.violet, 0.6, 0.45);
      // Gentle answers.
      case 'nodYes': return B(S.marigold, 0.35);
      case 'shakeNo': return B(S.coral, 0.3);
      // Curiosity and liveliness: a lift of the mood colour itself.
      case 'curiousTilt': return B(LIFT, 0.6, 0.3);
      case 'questionEyes': return B(LIFT, 0.7, 0.3);
      case 'curiousLean': return B(LIFT, 0.5);
      case 'perkUp': return B(LIFT, 0.7);
      case 'confusedShake': return B(LIFT, 0.45);
      case 'stretch': return B(LIFT, 0.4, 0.25);
      // Sleepy, quiet or sly; idle games: no burst.
      default: return S.none;
    }
  }

  /// The standard table, indexed by `OneShotKind.ordinal`.
  static readonly standardTable: readonly BackgroundBurstStyle[] = [...OneShotKind.allCases]
    .sort((a, b) => OneShotKind.ordinal(a) - OneShotKind.ordinal(b))
    .map((k) => BackgroundBurstStyle.standard(k));
}
