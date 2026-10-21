// Port of yanni/Preview/ThinkingPanel.swift: hold thinking for 2, 5 or 10 s (then the reply arrives with the "aha!"
// perk), or fire each thinking beat on its own.
import { ThinkingBeat } from '../engine/modifiers/ThinkingBeats';
import type { TuningModel } from './TuningModel';
import { button, buttons, h, section, segmented } from './ui';

export function thinkingSection(m: TuningModel): HTMLElement {
  return section('Thinking',
    h('div', { class: 'pv-toggle' },
      segmented('Hold', [[2, '2 s'], [5, '5 s'], [10, '10 s']] as const, () => m.thinkingHold, (v) => { m.thinkingHold = v; }),
      button('Think', () => m.previewThinking())),
    buttons(...ThinkingBeat.allCases.map((b) => [b, () => m.playThinkingBeat(b)] as [string, () => void])));
}
