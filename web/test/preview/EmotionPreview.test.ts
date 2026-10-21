// Tune › Emotion's conversation simulator runs on the frame clock and outlives the Tuning page (Swift EmotionModel,
// ticked from the app's after-frame hook), so it drives the kiosk as it does tuning.html.
import { describe, expect, test } from 'vitest';
import { EmotionPreview } from '../../src/preview/EmotionPanel';
import { TuningModel } from '../../src/preview/TuningModel';
import { makeContext } from './support';

describe('EmotionPreview', () => {
  test('a scenario is ticked per frame and keeps running after the page closes; reopening finds the same preview', () => {
    const ctx = makeContext({ emotion: true });
    const m = new TuningModel(ctx);
    const ep = EmotionPreview.for(m, ctx.emotion!);
    ctx.step(1);
    ep.simulate('joke');
    expect(ep.simulator.running).toBe('joke');
    m.dispose();
    ctx.step(60 * 30);
    expect(ep.simulator.running).toBeNull();
    expect(ep.simLog.length).toBeGreaterThan(2);
    expect(EmotionPreview.for(new TuningModel(ctx), ctx.emotion!)).toBe(ep);
  });
});
