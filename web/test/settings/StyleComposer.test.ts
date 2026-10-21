// Port of StyleComposerTests: owner fields own their style counterparts, the developer style keeps the rest, and
// Tuning edits route back to the owning setting.
import { describe, expect, test } from 'vitest';
import { settingsFrom, StyleComposer } from '../../src/settings';
import { makeRenderStyle, RenderStyle } from '../../src/render/RenderStyle';

describe('StyleComposer', () => {
  test('defaults compose to the reference style, with the owner brows on', () => {
    const st = StyleComposer.compose(settingsFrom({}));
    expect(RenderStyle.encode(st)).toEqual(RenderStyle.encode({ ...makeRenderStyle(), browsEnabled: true }));
  });

  test('owner fields over the developer style; a developer rim wins over the preset', () => {
    const s = settingsFrom({ theme_preset: 'sticker', mood_colour_strength: 40, mood_background: 'Mood', mood_background_vignette: 30,
      pupil_mood_accent: false, ink_brows: true, tuning_style: { pupilScale: 1.2 } });
    const st = StyleComposer.compose(s);
    expect([st.rimWidth, st.inkWidth, st.moodColorAmount, st.backgroundVignette, st.backgroundVignetteInner, st.shapeMoodAccent,
      st.browInk, st.pupilScale]).toEqual([0.35, 1.3, 0.4, 0.3, 0.45, false, true, 1.2]);
    const custom = StyleComposer.compose(settingsFrom({ theme_preset: 'sticker', tuning_style: { rimWidth: 0.5 } }));
    expect(custom.rimWidth).toBe(0.5);
    expect(StyleComposer.compose(settingsFrom({ mood_colour: false })).moodColorAmount).toBe(0);
  });

  test('decompose routes owner fields back and keeps the rest as the developer style', () => {
    const s = settingsFrom({});
    const edited = StyleComposer.compose(s);
    edited.moodColorAmount = 0.5;
    edited.browsEnabled = false;
    edited.rimColor = { ...RenderStyle.ivoryRim.rimColor };
    edited.rimWidth = RenderStyle.ivoryRim.rimWidth;
    edited.inkWidth = RenderStyle.ivoryRim.inkWidth;
    edited.crescentColor = { x: 1, y: 0, z: 0 };
    edited.pupilScale = 1.1;
    const patch = StyleComposer.decompose(edited, s);
    expect(patch).toMatchObject({ mood_colour: true, mood_colour_strength: 50, eyebrows: false, theme_preset: 'sticker',
      custom_crescent_colour: '#ff0000' });
    const dev = RenderStyle.decode(patch.tuning_style);
    expect([dev.pupilScale, dev.rimWidth, dev.browsEnabled, dev.moodColorAmount]).toEqual([1.1, makeRenderStyle().rimWidth,
      makeRenderStyle().browsEnabled, makeRenderStyle().moodColorAmount]);
    // Round trip: the composed style of the result is the edit.
    const back = StyleComposer.compose(settingsFrom({ ...s, ...patch }));
    expect([back.moodColorAmount, back.browsEnabled, back.rimWidth, back.pupilScale]).toEqual([0.5, false, 0.35, 1.1]);
    // An inert edit stores nothing.
    expect(StyleComposer.decompose(StyleComposer.compose(s), s)).toEqual({ tuning_style: {} });
  });
});
