// Port of yanni/Preview/ParameterEditor.swift: every parameter of one expression (and its eyebrows) as sliders. Edits
// go into a copy of the library pushed to the engine (`setLibrary`), and the expression shows as the override while
// editing. Groups are built only when opened, so the 51 + 18 sliders cost nothing until wanted.
import { BrowLayout } from '../model/BrowPose';
import { ParamLayout } from '../model/ParamLayout';
import type { TuningModel } from './TuningModel';
import { buttons, group, note, readout, section, select, slider, type Build } from './ui';

function lazyGroup(title: string, build: () => HTMLElement[]): HTMLDetailsElement {
  const g = group(title);
  g.addEventListener('toggle', () => { if (g.open && g.childElementCount === 1) g.append(...build()); });
  return g;
}

export function parameterEditorSection(m: TuningModel, b: Build): HTMLElement {
  const groups: [string, number, number][] = [
    ['Face', ParamLayout.faceOffset, ParamLayout.leftEyeOffset],
    ['Left eye', ParamLayout.leftEyeOffset, ParamLayout.rightEyeOffset],
    ['Right eye', ParamLayout.rightEyeOffset, ParamLayout.count],
  ];
  return section('Parameter editor',
    select('Expression', m.library.names.map((n) => [n, n] as const), () => m.editingName,
      (v) => { m.editingName = v; m.previewEditedExpression(); b.rebuild(); }),
    buttons(['Show', () => m.previewEditedExpression()], ['Revert', () => { m.revertEditedExpression(); b.rebuild(); }]),
    readout(b, () => (m.isEditedExpressionDirty ? 'edited' : ''), 'pv-note t-warn'),
    lazyGroup('Eyebrows', () => [
      note('Eye-relative units. Rotation is the gross tilt (+ = inner end up); inner / outer are the expressive end heights on top of it.'),
      ...BrowLayout.usedIndices.map((i, k) => {
        const lane = BrowLayout.Lane.allCases[i % 16]!, r = BrowLayout.Lane.range(lane);
        return slider(BrowLayout.names[k]!, () => m.browValue(i), (v) => m.setBrowValue(i, v), [r.lowerBound, r.upperBound],
          (v) => v.toFixed(lane === 'rotation' ? 1 : 3));
      }),
    ]),
    ...groups.map(([title, lo, hi]) => lazyGroup(title, () => Array.from({ length: hi - lo }, (_, j) => {
      const i = lo + j, r = ParamLayout.ranges[i]!;
      return slider(ParamLayout.names[i]!, () => m.value(i), (v) => m.setValue(i, v), [r.lowerBound, r.upperBound],
        (v) => v.toFixed(r.upperBound > 10 ? 1 : 3));
    }))));
}
