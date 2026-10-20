// Every golden fixture, run as soon as everything it needs is ported: each scenario lists the Swift modifiers its
// engine runs (`core` = OneShotSampler + OneShotApply, `default` = all 27 of makeDefaultModifiers) plus FaceLife for
// the life-* scenarios, plus the curve of every one-shot kind the script plays. Unmet scenarios are skipped with the
// missing pieces in their name, so registering a modifier in src/engine/modifiers/index.ts (or porting a curve) lights
// its scenarios up.
import { describe, expect, test } from 'vitest';
import { isModifierRegistered } from '../../src/engine';
import { goldenNames, loadGolden, runGolden, scenarioModifiers, scenarioRequirements } from './harness';

/// Ported modules beyond the modifiers and curves. Life scenarios also need every default modifier (above).
const portedExtras = new Set<string>(['FaceLife']);

describe('golden scenarios', () => {
  for (const name of goldenNames()) {
    const g = loadGolden(name);
    const missing = [
      ...scenarioModifiers(g).filter((m) => !isModifierRegistered(m)),
      ...scenarioRequirements(g).filter((r) => !portedExtras.has(r)),
    ];
    if (missing.length > 0) {
      test.skip(`${name} (needs ${missing.length > 4 ? `${missing.slice(0, 4).join(', ')} +${missing.length - 4}` : missing.join(', ')})`, () => {});
      continue;
    }
    test(name, () => {
      const r = runGolden(name);
      expect(r.report).toBe('');
    });
  }
});
