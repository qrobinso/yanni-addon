// Port of FaceEngine/Modifiers/MoodColor.swift.
import { v3, type V3 } from '../../core/vec';
import { FaceFrame, Oklab, type ExpressionLibrary, type ExpressionMix } from '../../model';
import { FaceAffect } from '../FaceAffect';
import type { FaceState } from '../FaceState';
import { ListeningGlow } from '../ListeningGlow';
import { Phase, type Modifier } from '../Modifier';
import { MoodBackground } from '../MoodBackground';
import { MoodPalette } from '../MoodPalette';
import { SpringParams } from '../Spring';

const fin3 = (v: V3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/// Output phase: eye colour follows mood (and partly the expression on show).
///
/// Effective PAD (shared with the voice via `FaceAffect`) = mood + `expressionInfluence` · (PAD of the shown mix −
/// Neutral's PAD), cached per mix / library change. The palette maps that point to an Oklab colour; a critically
/// damped spring in Oklab eases toward it. Writes `s.eyeColor` (linear RGB). A reaction overlay is blended in per
/// `FaceAffect`. Then it steps `background` (`MoodBackground`) and `glow` (`ListeningGlow`).
export class MoodColor implements Modifier {
  readonly name = 'MoodColor';
  readonly phase = Phase.output;
  isEnabled = true;

  /// How much the shown expression shifts the colour, 0 (mood only) ... 1.
  expressionInfluence = 0.5;
  /// 1 = every colour keeps the default cyan's lightness; lower lets saturated anchors keep more of their colour.
  lightnessMatch = 0.5;
  private _palette: MoodPalette = MoodPalette.standard;
  get palette(): MoodPalette { return this._palette; }
  set palette(p: MoodPalette) { this._palette = p; this.lastPAD = null; }
  /// The mood background: a second palette read from the same affect.
  background = new MoodBackground();
  /// The listening glow: rises from the bottom edge while the mic is open.
  glow = new ListeningGlow();

  /// Colour spring (critically damped). 95 % settle ≈ 1.35 s.
  static readonly smoothing = new SpringParams(3.5, 1);

  private cachedMix: ExpressionMix | null = null;
  private cachedLibraryVersion = -1;
  private mixDelta: V3 = v3(0);
  private cachedOverlay: ExpressionMix | null = null;
  private cachedOverlayLibraryVersion = -1;
  private overlayDelta: V3 = v3(0);

  private lastPAD: V3 | null = null;
  private lastMatch = NaN;
  private target: V3 = v3(0);

  private value: V3 = v3(0);
  private velocity: V3 = v3(0);
  private initialized = false;

  /// Current smoothed colour in Oklab.
  get currentLab(): V3 { return this.value; }
  /// Current target colour in Oklab.
  get targetLab(): V3 { return this.target; }

  /// PAD offset of `mix` relative to Neutral, scaled by the mix intensity (forwards to `FaceAffect`).
  static padDelta(mix: ExpressionMix, library: ExpressionLibrary): V3 { return FaceAffect.padDelta(mix, library); }

  /// The effective PAD the palette sees for this state.
  effectivePAD(s: FaceState): V3 {
    return FaceAffect.combineOverlay(s.mood, this.mixDelta, this.overlayDelta, FaceAffect.overlayWeight(s), this.expressionInfluence);
  }

  update(s: FaceState): void {
    // 1. Expression PAD (cached per mix / library change).
    const mix = s.expressionOverride ?? s.targetMix;
    if (s.libraryVersion !== this.cachedLibraryVersion || this.cachedMix === null || !this.cachedMix.equals(mix)) {
      this.cachedMix = mix.copy();
      this.cachedLibraryVersion = s.libraryVersion;
      this.mixDelta = MoodColor.padDelta(mix, s.library);
    }
    const ov = s.reactionOverlay;
    if (ov !== null && (s.libraryVersion !== this.cachedOverlayLibraryVersion || this.cachedOverlay === null || !this.cachedOverlay.equals(ov))) {
      this.cachedOverlay = ov.copy();
      this.cachedOverlayLibraryVersion = s.libraryVersion;
      this.overlayDelta = MoodColor.padDelta(ov, s.library);
    } else if (ov === null && this.cachedOverlay !== null) {
      this.cachedOverlay = null;
      this.overlayDelta = v3(0);
    }

    // 2. Target colour (cached per effective PAD).
    const pad = this.effectivePAD(s);
    const lp = this.lastPAD;
    if (lp === null || lp.x !== pad.x || lp.y !== pad.y || lp.z !== pad.z || this.lightnessMatch !== this.lastMatch) {
      this.lastPAD = pad;
      this.lastMatch = this.lightnessMatch;
      this.target = this._palette.displayLab(pad, this.lightnessMatch);
    }

    // 3. Spring in Oklab (exact closed form: identical at 60 and 120 fps).
    const t = this.target;
    if (!this.initialized) {
      this.value = { ...t }; this.velocity = v3(0); this.initialized = true;
    } else {
      const { a, b, c, d } = MoodColor.smoothing.coefficients(s.dt);
      const v = this.value, vel = this.velocity;
      const x = v3(v.x - t.x, v.y - t.y, v.z - t.z);
      this.value = v3(t.x + x.x * a + vel.x * b, t.y + x.y * a + vel.y * b, t.z + x.z * a + vel.z * b);
      this.velocity = v3(x.x * c + vel.x * d, x.y * c + vel.y * d, x.z * c + vel.z * d);
    }
    if (!(fin3(this.value) && fin3(this.velocity))) { this.value = { ...t }; this.velocity = v3(0); }
    s.eyeColor = Oklab.toLinearClamped(this.value, FaceFrame.defaultColor);

    // 4. The mood background (overlay excluded: a poke stays on the crescent and the face).
    this.background.update(s, this.mixDelta, this.expressionInfluence);

    // 5. The listening glow, coloured from the background just stepped and the crescent.
    this.glow.update(s, this.value);
  }
}
