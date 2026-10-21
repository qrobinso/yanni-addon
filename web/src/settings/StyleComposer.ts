// Port of YanniSettings/StyleComposer.swift: builds the renderer's style from the settings, and routes style edits from
// the Tuning tool back to the setting that owns them, so there is never a second copy of an owner setting.
//
// Ownership:
// - `mood_colour` / `mood_colour_strength` own `moodColorAmount`.
// - `pupil_mood_accent` owns `shapeMoodAccent`.
// - `theme_preset` owns the rim triple (`rimColor`, `rimWidth`, `inkWidth`) unless the developer set a custom triple
//   in Tuning, which then wins.
// - `custom_sclera_colour` / `custom_crescent_colour` own those colours ('' = the style's own).
// - `eyebrows` / `ink_brows` own the brows switch and ink brows.
// - `mood_background_vignette` owns `backgroundVignette` (and the ramp start) while the background is Mood or Fixed
//   colour; Black keeps the developer's classic falloff.
// - Everything else is the developer's `tuning_style`.
// - `color` (the mood anchor) is never a setting.
// port-note: custom colours are stored as sRGB hex (the add-on's colour type), so a colour set in Tuning is kept to
// 8 bits per channel; Swift keeps the linear floats.
import type { Settings } from '@yanni/server/settings';
import type { V3 } from '../core/vec';
import { Oklab } from '../model/Oklab';
import { makeRenderStyle, RenderStyle } from '../render/RenderStyle';

type ThemePreset = Settings['theme_preset'];
const PRESETS: readonly ThemePreset[] = ['inky', 'sticker'];

/** Where the vignette ramp starts on the colour backgrounds (flat panel, darkened edges). */
export const colourVignetteInner = 0.45;

const preset = (p: ThemePreset): RenderStyle => (p === 'sticker' ? RenderStyle.ivoryRim : makeRenderStyle());
const rimKey = (s: RenderStyle) => [s.rimColor.x, s.rimColor.y, s.rimColor.z, s.rimWidth, s.inkWidth].join();
function setRim(to: RenderStyle, from: RenderStyle): void {
  to.rimColor = { ...from.rimColor };
  to.rimWidth = from.rimWidth;
  to.inkWidth = from.inkWidth;
}
const sameColour = (a: V3, b: V3) => a.x === b.x && a.y === b.y && a.z === b.z;

/** `#rrggbb` → linear RGB. */
export const hexToLinear = (hex: string): V3 => Oklab.linear(parseInt(hex.slice(1), 16));
/** Linear RGB → `#rrggbb`. */
export const linearToHex = (c: V3): string => `#${Oklab.hex(c).toString(16).padStart(6, '0')}`;

/** The developer style (`tuning_style`, tolerant; {} = the reference style). */
export const developerStyle = (s: Pick<Settings, 'tuning_style'>): RenderStyle => RenderStyle.decode(s.tuning_style);

/** Structural equality over every field the renderer reads (the mood anchor included). */
export function sameStyle(a: RenderStyle, b: RenderStyle): boolean {
  return sameColour(a.color, b.color) && JSON.stringify(RenderStyle.encode(a)) === JSON.stringify(RenderStyle.encode(b));
}

export const StyleComposer = {
  /** The style the renderer draws with. */
  compose(s: Settings): RenderStyle {
    const st = developerStyle(s);
    if (rimKey(st) === rimKey(makeRenderStyle())) setRim(st, preset(s.theme_preset));
    st.moodColorAmount = s.mood_colour ? s.mood_colour_strength / 100 : 0;
    st.shapeMoodAccent = s.pupil_mood_accent;
    if (s.custom_sclera_colour) st.scleraColor = hexToLinear(s.custom_sclera_colour);
    if (s.custom_crescent_colour) st.crescentColor = hexToLinear(s.custom_crescent_colour);
    st.browsEnabled = s.eyebrows;
    st.browInk = s.ink_brows;
    if (s.mood_background !== 'Black') {
      st.backgroundVignette = s.mood_background_vignette / 100;
      st.backgroundVignetteInner = colourVignetteInner;
    }
    return st;
  },

  /** Splits an edited composed style into the owner settings and the developer's `tuning_style`. Only fields that
   *  differ from the current composed style are routed, so an unrelated Tuning edit never rewrites an owner
   *  setting. Returns the patch for `hub.update('tuning', …)`. */
  decompose(style: RenderStyle, s: Settings): Partial<Settings> {
    const current = StyleComposer.compose(s);
    const base = makeRenderStyle();
    const old = developerStyle(s);
    const dev = RenderStyle.clone(style);
    const out: Partial<Settings> = {};
    // Mood colour amount → look.
    if (style.moodColorAmount !== current.moodColorAmount) {
      if (style.moodColorAmount > 0.001) {
        out.mood_colour = true;
        out.mood_colour_strength = Math.round(Math.min(Math.max(style.moodColorAmount, 0), 1) * 100);
      } else out.mood_colour = false;
    }
    dev.moodColorAmount = old.moodColorAmount;
    // Mood accent → pupil reactions.
    if (style.shapeMoodAccent !== current.shapeMoodAccent) out.pupil_mood_accent = style.shapeMoodAccent;
    dev.shapeMoodAccent = old.shapeMoodAccent;
    // Rim triple → a preset when it matches one, otherwise a developer custom triple.
    if (rimKey(style) !== rimKey(current)) {
      const p = PRESETS.find((x) => rimKey(preset(x)) === rimKey(style));
      if (p !== undefined) {
        out.theme_preset = p;
        setRim(dev, base);
      }
    } else setRim(dev, old);
    // Custom colours → look ('' when equal to the preset colour, which both presets share).
    if (!sameColour(style.scleraColor, current.scleraColor)) {
      out.custom_sclera_colour = sameColour(style.scleraColor, base.scleraColor) ? '' : linearToHex(style.scleraColor);
    }
    if (!sameColour(style.crescentColor, current.crescentColor)) {
      out.custom_crescent_colour = sameColour(style.crescentColor, base.crescentColor) ? '' : linearToHex(style.crescentColor);
    }
    dev.scleraColor = { ...old.scleraColor };
    dev.crescentColor = { ...old.crescentColor };
    // Brows switch and ink → look.
    if (style.browsEnabled !== current.browsEnabled) out.eyebrows = style.browsEnabled;
    if (style.browInk !== current.browInk) out.ink_brows = style.browInk;
    dev.browsEnabled = old.browsEnabled;
    dev.browInk = old.browInk;
    // Background vignette → look while a colour background owns it.
    if (s.mood_background !== 'Black') {
      if (style.backgroundVignette !== current.backgroundVignette) {
        out.mood_background_vignette = Math.round(Math.min(Math.max(style.backgroundVignette, 0), 1) * 100);
      }
      dev.backgroundVignette = old.backgroundVignette;
      dev.backgroundVignetteInner = old.backgroundVignetteInner;
    }
    const encoded = RenderStyle.encode(dev);
    // The reference style stays the empty section (its default), so an inert edit stores nothing.
    out.tuning_style = JSON.stringify(encoded) === JSON.stringify(RenderStyle.encode(base)) ? {} : encoded;
    return out;
  },
};
