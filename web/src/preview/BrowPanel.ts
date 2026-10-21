// Port of yanni/Preview/BrowPanel.swift: the owner's eyebrow switches (through the hub when attached), animation
// intensity, every proportion (the developer style), the six reference expressions with a springy blend between any
// two, and the checks (blink storm, gaze sweep, a pupil transformation, each edge antic, drowsy → asleep → wake).
import { EDGE_KINDS } from './EdgeAnticPanel';
import { BrowLook, type TuningModel } from './TuningModel';
import { button, buttons, caption, group, readout, section, select, slider, toggle, type Build } from './ui';

type BrowField = 'browLength' | 'browThickness' | 'browGap' | 'browMinGap' | 'browThickestAt' | 'browInnerTip' | 'browOuterTip';

export function browSection(m: TuningModel, b: Build): HTMLElement {
  const prop = (label: string, k: BrowField, range: readonly [number, number], d = 2) =>
    slider(label, () => m.style[k], (v) => m.editStyle((s) => { s[k] = v; }), range, (v) => v.toFixed(d));
  return section('Eyebrows',
    toggle('Show eyebrows', () => m.style.browsEnabled, (v) => m.persist({ eyebrows: v }, () => m.editStyle((s) => { s.browsEnabled = v; }))),
    toggle('Ink brows (coloured backgrounds)', () => m.style.browInk, (v) => m.persist({ ink_brows: v }, () => m.editStyle((s) => { s.browInk = v; }))),
    slider('Animation intensity', () => m.engine.browIntensity, (v) => m.persist({ brow_intensity: v }, () => { m.engine.browIntensity = v; }),
      [0, 1.5], (v) => `${v.toFixed(2)}×`),
    readout(b, () => m.browStatus()),
    caption('Reference expressions'),
    buttons(...BrowLook.allCases.map((l) => [BrowLook.title(l), () => m.showBrowLook(l)] as [string, () => void])),
    select('Blend toward', BrowLook.allCases.map((l) => [l, BrowLook.title(l)] as const), () => m.browBlendTo,
      (v) => { m.browBlendTo = v; m.applyBrowBlend(); }),
    slider('Blend', () => m.browBlend, (v) => { m.browBlend = v; m.applyBrowBlend(); }, [0, 1]),
    button('Clear expression override', () => m.clearOverride()),
    caption('Checks'),
    buttons(['Blink storm', () => m.checkBlinkStorm()], ['Gaze sweep', () => m.checkGazeSweep()], ['Stars', () => m.playPupil('starEyes')],
      ['Question', () => m.playPupil('questionEyes')], ['Sleep cycle', () => m.checkSleepCycle()]),
    buttons(...EDGE_KINDS.map(([k, t]) => [t, () => m.playEdge(k, k === 'popUp' || k === 'sleepySink' ? 0 : 1)] as [string, () => void])),
    group('Proportions',
      prop('Length (× eye width)', 'browLength', [0.5, 1.1]),
      prop('Thickness (× eye width)', 'browThickness', [0.06, 0.3], 3),
      prop('Gap above eye (× eye height)', 'browGap', [0, 0.3], 3),
      prop('Minimum gap (× eye height)', 'browMinGap', [0, 0.15], 3),
      prop('Thickest at (inner → outer)', 'browThickestAt', [0.1, 0.9]),
      prop('Inner tip (× peak)', 'browInnerTip', [0, 1]),
      prop('Outer tip (× peak)', 'browOuterTip', [0, 1]),
      button('Reset proportions', () => { m.resetBrowProportions(); b.rebuild(); })));
}
