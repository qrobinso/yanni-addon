// Port of yanni/Preview/Showcase.swift's section: representative looks (optionally cycling), the six reference eyebrow
// expressions (optionally cycling) and the style elasticity.
import { BrowLook, ShowcaseLook, type TuningModel } from './TuningModel';
import { buttons, caption, section, slider, toggle } from './ui';

export function showcaseSection(m: TuningModel): HTMLElement {
  return section('Style showcase',
    buttons(...ShowcaseLook.allCases.map((l) => [l, () => m.showcase(l)] as [string, () => void])),
    toggle('Cycle looks', () => m.showcaseCycling, (on) => m.setShowcaseCycling(on)),
    caption('Eyebrow expressions (reference)'),
    buttons(...BrowLook.allCases.map((l) => [BrowLook.title(l), () => m.showBrowLook(l)] as [string, () => void])),
    toggle('Cycle eyebrow expressions', () => m.browCycling, (on) => m.setBrowCycling(on)),
    slider('Elasticity', () => m.elasticity, (v) => m.setElasticity(v), [0.5, 2]));
}
