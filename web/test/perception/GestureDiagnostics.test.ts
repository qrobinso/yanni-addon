// Port of FacePerceptionTests/GestureDiagnostics.swift: prints what every gesture scene produces
// (YANNI_GESTURE_PRINT=1); a development aid, always passes.
import { test } from 'vitest';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { PerceptionProcessor } from '../../src/perception/PerceptionProcessor';
import { PerceptionEvent } from '../../src/perception/PerceptionTypes';
import { SyntheticScenes } from '../../src/perception/SyntheticScenes';

test('GestureDiagnostics printScenes', () => {
  if (process.env.YANNI_GESTURE_PRINT !== '1') return;
  const S = SyntheticScenes;
  for (const s of [...S.gestureScenes, S.pointLeft, S.waveAtYanni, S.thumbsUp, S.talkingWithHands]) {
    const p = new PerceptionProcessor(undefined, new CameraGeometry(undefined, s.cameraOffset), 3);
    const lines: string[] = [];
    for (const f of s.recording().frames) {
      const out = p.process(f);
      for (const g of out.snapshot.gestures) {
        lines.push(`${(g.time - 1000).toFixed(2)} ${g.kind.kind} ${g.phase} c${g.confidence.toFixed(2)} ` +
          `D${g.directedScore.toFixed(2)} ${g.directedAtYanni ? 'directed' : '-'}`);
      }
      for (const d of out.snapshot.gestureDecisions) {
        if (d.reason !== 'fired') lines.push(`${(d.time - 1000).toFixed(2)}   [${d.kind} ${d.reason}]`);
      }
      for (const e of out.events) {
        const name = PerceptionEvent.name(e);
        if (name === 'engaged' || name === 'disengaged') lines.push(`${(f.time - 1000).toFixed(2)}   <${name}>`);
      }
    }
    console.log(`SCENE ${s.name}:\n  ` + lines.join('\n  '));
  }
});
