// Probes for what the WP5–7 ports have landed: the curve-file stubs throw `TODO(WPx)` until ported, so tests split
// their per-kind cases on these and the skipped cases light up by themselves.
import { SplitMix64 } from '../../src/core/random';
import { EdgeGeometry } from '../../src/model';
import { EdgeAnticContext, OneShotLibrary, type OneShotKind } from '../../src/engine';

const isTodo = (e: unknown): boolean => e instanceof Error && e.message.startsWith('TODO(');

function probe(f: () => void): boolean {
  try { f(); return true; } catch (e) { if (isTodo(e)) return false; throw e; }
}

/// `OneShotLibrary.spec(kind)` works (edge antic and idle game specs need their curve files).
export const specPorted = (kind: OneShotKind): boolean => probe(() => { OneShotLibrary.spec(kind); });

/// The kind can be triggered and sampled (its params, spec and curve are ported).
export const curvePorted = (kind: OneShotKind): boolean => probe(() => {
  const p = OneShotLibrary.makeParams(kind, new SplitMix64(1), { x: 0, y: 0 }, new EdgeAnticContext({ geometry: EdgeGeometry.reference }));
  OneShotLibrary.spec(kind);
  OneShotLibrary.sample(kind, 0.1, p);
  OneShotLibrary.sample(kind, 0.1, new (p.constructor as new () => typeof p)());
});
