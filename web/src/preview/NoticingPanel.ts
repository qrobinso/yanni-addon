// Port of yanni/Preview/NoticingPanel.swift: a simulated person in front of Yanni (arrive, face Yanni, wave, come
// closer, leave), a live read-out of the noticing attention cycle, and a button per distraction beat.
import { NoticingBeat } from '../engine/modifiers/NoticingAttention';
import type { TuningModel } from './TuningModel';
import { buttons, readout, section, type Build } from './ui';

export function noticingSection(m: TuningModel, b: Build): HTMLElement {
  return section('Noticing',
    buttons(['Someone arrives', () => m.noticingArrive()], ['Face Yanni', () => m.noticingFace()], ['Wave', () => m.noticingWave()],
      ['Come closer', () => m.noticingCloser()], ['Leave', () => m.noticingLeave()]),
    readout(b, () => m.noticingReadout()),
    buttons(...NoticingBeat.allCases.map((beat) => [beat, () => m.playNoticingBeat(beat)] as [string, () => void])));
}
