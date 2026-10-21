// A minimal AppContext for the preview tests: a real engine, life cycle, clock and emotion layer; no DOM, no GPU.
import type { AppContext } from '../../src/app/AppContext';
import { EmotionLayer } from '../../src/emotion/EmotionLayer';
import { Mood } from '../../src/engine/AgentState';
import { FaceEngine } from '../../src/engine/FaceEngine';
import { LifeCycleController } from '../../src/life/LifeCycleController';
import { FrameClock } from '../../src/render/FrameClock';
import { makeRenderStyle, type RenderStyle } from '../../src/render/RenderStyle';

export function makeContext(o: { emotion?: boolean } = {}): AppContext & { logged: [string, string][]; step(n?: number): void } {
  const engine = new FaceEngine();
  engine.setMood(Mood.playful);
  engine.setAgentState('idle');
  const life = new LifeCycleController(engine);
  const clock = new FrameClock(engine);
  let style: RenderStyle = makeRenderStyle();
  const logged: [string, string][] = [];
  const emotion = o.emotion ? new EmotionLayer(engine) : null;
  let t = 0;
  const ctx = {
    engine, life, clock, emotion, logged,
    renderer: { frames: 0, deviceLosses: 0, isReady: true } as unknown as AppContext['renderer'],
    style: () => style, setStyle: (s: RenderStyle) => { style = s; },
    audioContext: null as unknown as AudioContext,
    conversationAudio: { micOpen: false } as unknown as AppContext['conversationAudio'],
    voice: null, conversation: null, perception: null, client: null,
    hud: { visible: false, toggle() {} } as unknown as AppContext['hud'],
    logEvent: (c: string, m: string) => { logged.push([c, m]); },
    now: () => t,
    /** Runs `n` 60 Hz frames through the clock (after-frame hooks included). */
    step(n = 1) { for (let i = 0; i < n; i++) { t += 1 / 60; clock.beginFrame(t); clock.endFrame(false); } },
  };
  return ctx;
}
