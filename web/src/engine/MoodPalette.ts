// Port of FaceEngine/MoodPalette.swift.
import { v3, type V3 } from '../core/vec';
import { FaceFrame, Oklab } from '../model';

import type { ClosedRangeF } from './SettingsSupport';

/// One emotion placed in PAD space with an authored colour.
export class MoodPaletteAnchor {
  readonly name: string;
  /// (pleasure, arousal, dominance).
  readonly pad: V3;
  /// Authored colour, linear RGB.
  readonly linear: V3;
  /// Authored colour, Oklab.
  readonly lab: V3;

  constructor(name: string, pad: V3, linear: V3) {
    this.name = name; this.pad = { ...pad }; this.linear = { ...linear }; this.lab = Oklab.fromLinear(linear);
  }

  static hex(name: string, pad: V3, hex: number): MoodPaletteAnchor { return new MoodPaletteAnchor(name, pad, Oklab.linear(hex)); }

  equals(o: MoodPaletteAnchor): boolean {
    const e = (a: V3, b: V3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
    return this.name === o.name && e(this.pad, o.pad) && e(this.linear, o.linear) && e(this.lab, o.lab);
  }
}

const A = (name: string, p: number, a: number, d: number, linear: V3): MoodPaletteAnchor =>
  new MoodPaletteAnchor(name, v3(p, a, d), linear);
const H = (name: string, p: number, a: number, d: number, hex: number): MoodPaletteAnchor =>
  MoodPaletteAnchor.hex(name, v3(p, a, d), hex);

/// Maps a PAD point (pleasure, arousal, dominance; each −1...1) to an eye colour.
///
/// **Blend.** Kernel-weighted average of the anchors' Oklab coordinates:
///
///     wᵢ = hᵢ · exp(−dᵢ² / 2σ²) / (dᵢ² + ε)          (Gaussian × Shepard)
///     w₀ = exp(−d₀² / 2σₙ²) / (d₀² + ε) + neutralFloor  (anchor 0 = neutral)
///     hᵢ = 1 − exp(−d₀² / 2τ²)                        (baseline hold)
///
/// **Lightness.** The result keeps its hue and chroma but its Oklab L is moved to the neutral anchor's lightness
/// (`lightnessMatch` = 1); gamut-limited hues lose chroma until they fit, giving up to `lightnessGive` of L.
///
/// A class standing in for a Swift struct: `copy()` where the Swift copies.
export class MoodPalette {
  /// Gaussian kernel width in PAD units.
  sigma = 0.45;
  /// Gaussian width for the neutral anchor.
  neutralSigma = 0.3;
  /// Shepard softening (PAD units²).
  shepardEpsilon = 0.02;
  /// Constant weight on the neutral anchor.
  neutralFloor = 0.02;
  /// Baseline hold radius τ (PAD units).
  baselineHold = 0.2;
  /// Max Oklab L a gamut-limited colour may drop below the target lightness to keep chroma.
  lightnessGive = 0.035;

  /// Anchor 0 is the neutral / playful-baseline anchor and defines the target lightness.
  private _anchors: MoodPaletteAnchor[];
  get anchors(): readonly MoodPaletteAnchor[] { return this._anchors; }

  constructor(anchors: MoodPaletteAnchor[]) {
    if (anchors.length === 0) throw new Error('MoodPalette needs at least the neutral anchor');
    this._anchors = [...anchors];
  }

  copy(): MoodPalette { const p = Object.assign(new MoodPalette(this._anchors), this); p._anchors = [...this._anchors]; return p; }

  /// Replaces anchor `index`'s colour (linear RGB), keeping its PAD.
  setAnchorColor(index: number, linear: V3): void {
    if (!(index >= 0 && index < this._anchors.length) || !Number.isFinite(linear.x) || !Number.isFinite(linear.y)
      || !Number.isFinite(linear.z)) return;
    const a = this._anchors[index];
    const c = (v: number): number => Math.min(Math.max(v, 0), 1);
    this._anchors[index] = new MoodPaletteAnchor(a.name, a.pad, v3(c(linear.x), c(linear.y), c(linear.z)));
  }

  /// The neutral anchor's colour in Oklab (the default cyan).
  get baseLab(): V3 { return this._anchors[0].lab; }

  /// The standard palette. PAD positions match `Mood.playful` and the library's expression PADs.
  static readonly standard = new MoodPalette([
    // Must be FaceFrame.defaultColor so the playful baseline is exactly the default eye colour.
    A('content', 0.2, 0.15, 0.1, FaceFrame.defaultColor), // cyan    #5FF6FF
    H('happy', 0.8, 0.4, 0.3, 0x4dffc0), // mint
    H('excited', 0.8, 0.9, 0.4, 0xffd36b), // warm gold
    H('sad', -0.6, -0.4, -0.4, 0x3a8dff), // deep blue
    H('tired', 0.0, -0.8, 0.0, 0x9d7dff), // dusky periwinkle
    H('angry', -0.6, 0.7, 0.6, 0xff6a2a), // red-orange
    H('anxious', -0.6, 0.7, -0.6, 0xc26bff), // violet
    H('embarrassed', -0.3, 0.3, -0.5, 0xff6cc8), // pink
    H('surprised', 0.2, 0.8, -0.1, 0xa6fff2), // pale icy aqua
  ]);

  /// Kernel-blended Oklab colour (authored lightness, before normalisation).
  blendedLab(x: V3): V3 {
    const inv2s2 = 1 / Math.max(2 * this.sigma * this.sigma, 1e-6);
    const inv2n2 = 1 / Math.max(2 * this.neutralSigma * this.neutralSigma, 1e-6);
    const inv2t2 = 1 / Math.max(2 * this.baselineHold * this.baselineHold, 1e-6);
    const eps = Math.max(this.shepardEpsilon, 1e-6);
    const an = this._anchors;
    const p0 = an[0].pad;
    const d0 = (x.x - p0.x) ** 2 + (x.y - p0.y) ** 2 + (x.z - p0.z) ** 2;
    const hold = 1 - Math.exp(-d0 * inv2t2);
    let w0 = Math.exp(-d0 * inv2n2) / (d0 + eps) + Math.max(this.neutralFloor, 0);
    if (!Number.isFinite(w0)) w0 = 1;
    const l0 = an[0].lab;
    let sx = l0.x * w0, sy = l0.y * w0, sz = l0.z * w0;
    let total = w0;
    for (let i = 1; i < an.length; i++) {
      const p = an[i].pad;
      const d = (x.x - p.x) ** 2 + (x.y - p.y) ** 2 + (x.z - p.z) ** 2;
      const w = hold * Math.exp(-d * inv2s2) / (d + eps);
      if (!(Number.isFinite(w) && w > 0)) continue;
      const l = an[i].lab;
      sx += l.x * w; sy += l.y * w; sz += l.z * w;
      total += w;
    }
    return v3(sx / total, sy / total, sz / total);
  }

  /// Displayed Oklab colour for a PAD point: blended, then lightness-normalised toward the neutral anchor
  /// (`lightnessMatch` 0...1) and gamut-mapped by reducing chroma (hue kept).
  displayLab(pad: V3, lightnessMatch = 1): V3 {
    if (!(Number.isFinite(pad.x) && Number.isFinite(pad.y) && Number.isFinite(pad.z))) return { ...this.baseLab };
    return this.normalisedLab(this.blendedLab(pad), lightnessMatch);
  }

  /// Moves an Oklab colour's lightness toward the neutral anchor's and reduces its chroma (hue kept) until it fits the
  /// sRGB gamut, giving up to `lightnessGive` of L if it had to.
  normalisedLab(blend: V3, lightnessMatch = 1): V3 {
    const base = this.baseLab;
    if (!(Number.isFinite(blend.x) && Number.isFinite(blend.y) && Number.isFinite(blend.z))) return { ...base };
    const match = Math.min(Math.max(lightnessMatch, 0), 1);
    const chroma = Math.sqrt(blend.y * blend.y + blend.z * blend.z);
    const l0 = blend.x + (base.x - blend.x) * match;
    if (!(chroma > 1e-6)) return v3(l0, 0, 0);
    const dx = blend.y / chroma, dy = blend.z / chroma;
    const fit0 = Oklab.maxChroma(blend, l0);
    const deficit = 1 - fit0 / chroma;
    const l = l0 - Math.max(this.lightnessGive, 0) * match * deficit;
    const fit = deficit > 0 ? Oklab.maxChroma(blend, l) : chroma;
    return v3(l, dx * fit, dy * fit);
  }

  /// Displayed colour as linear RGB 0...1.
  displayLinear(pad: V3, lightnessMatch = 1): V3 {
    return Oklab.toLinearClamped(this.displayLab(pad, lightnessMatch), FaceFrame.defaultColor);
  }

  // MARK: Banded normalisation (the mood background)

  /// Background colour for a PAD point: the same kernel blend, then banded: lightness clamped into `band`, chroma
  /// limited to `chromaCap` and then to the sRGB gamut at that lightness (hue kept).
  bandedLab(pad: V3, band: ClosedRangeF, chromaCap: number): V3 {
    if (!(Number.isFinite(pad.x) && Number.isFinite(pad.y) && Number.isFinite(pad.z))) {
      return MoodPalette.banded(this.baseLab, band, chromaCap);
    }
    return MoodPalette.banded(this.blendedLab(pad), band, chromaCap);
  }

  /// Clamps an Oklab colour's lightness into `band` and its chroma to `chromaCap` and the sRGB gamut, keeping hue.
  static banded(lab: V3, band: ClosedRangeF, chromaCap: number): V3 {
    if (!(Number.isFinite(lab.x) && Number.isFinite(lab.y) && Number.isFinite(lab.z))) return v3(band[0], 0, 0);
    const l = Math.min(Math.max(lab.x, band[0]), band[1]);
    const c = Math.sqrt(lab.y * lab.y + lab.z * lab.z);
    if (!(c > 1e-6)) return v3(l, 0, 0);
    const capped = Math.min(c, Math.max(chromaCap, 0));
    const dx = lab.y / c, dy = lab.z / c;
    const fit = Oklab.maxChroma(v3(l, dx * capped, dy * capped), l);
    return v3(l, dx * fit, dy * fit);
  }

  /// The mood background palette (mood background design §3): flat, warm, mid-saturation panels, anchored at the
  /// same PAD points as `standard`, plus a worried anchor of its own. Every anchor sits in the band L 0.64…0.84,
  /// C ≤ 0.16.
  static readonly background = new MoodPalette([
    H('content', 0.2, 0.15, 0.1, 0xb78bbe), // lavender     0.696 0.088 −38
    H('happy', 0.8, 0.4, 0.3, 0xfcbb3d), // mustard      0.832 0.153  80
    H('excited', 0.8, 0.9, 0.4, 0xffb13b), // marigold     0.816 0.155  73
    H('sad', -0.6, -0.4, -0.4, 0x7ccbec), // sky blue     0.803 0.091 −133
    H('tired', 0.0, -0.8, 0.0, 0x7d90ae), // slate        0.649 0.050 −100
    H('angry', -0.6, 0.7, 0.6, 0x9a928c), // warm grey    0.665 0.013  60
    H('anxious', -0.6, 0.7, -0.6, 0xf38258), // coral        0.725 0.150  41
    H('embarrassed', -0.3, 0.3, -0.5, 0xe999b1), // soft pink    0.770 0.100   0
    H('surprised', 0.2, 0.8, -0.1, 0x8fd6c8), // soft aqua    0.825 0.074 −179
    H('worried', -0.2, 0.0, -0.3, 0xaeca63), // sage         0.796 0.134 122
  ]).sharpened();

  /// Background anchors sit closer together than the crescent's, so the Shepard term is sharper.
  sharpened(): MoodPalette {
    const p = this.copy();
    p.shepardEpsilon = 0.01;
    return p;
  }
}
