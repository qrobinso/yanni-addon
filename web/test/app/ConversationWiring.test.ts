// The kiosk's conversation glue: the audio control (privacy gate, speech envelope, mic mode), the babble reply clock
// and the conversation_context sensor's privacy rules.
import { describe, expect, test } from 'vitest';
import { AsrAudioTap } from '../../src/conversation/audio/AsrAudioTap';
import type { ConversationAudio } from '../../src/conversation/audio/ConversationAudio';
import { makeConversationContextSnapshot } from '../../src/conversation/agent/Ports';
import { ConversationAudioEngine } from '../../src/app/conversation/ConversationAudioEngine';
import { BabbleReplyClock, StateContextPublisher } from '../../src/app/conversation/VoiceAdapters';
import type { VoiceDirector } from '../../src/voice/bridge/VoiceDirector';

function rig(startMic: () => Promise<void> = async () => {}) {
  let now = 10;
  const calls: string[] = [];
  const fake = {
    context: { sampleRate: 48000, outputLatency: 0, baseLatency: 0, currentTime: 0, state: 'running' },
    pump: { stop: () => calls.push('pump.stop') },
    onFrame: null as ((s: Float32Array, end: number) => void) | null,
    startMic: () => { calls.push('startMic'); return startMic(); },
    stopMic: () => calls.push('stopMic'),
    flushPlayout: () => calls.push('flush'),
    hostTime: (t: number) => t,
    playPcm: (s: Float32Array, rate: number) => ({ start: now + 0.02, end: now + 0.02 + s.length / rate }),
  };
  const asr = new AsrAudioTap();
  const engine = new ConversationAudioEngine(fake as unknown as ConversationAudio, asr, () => now);
  return { engine, fake, asr, calls, advance: (dt: number) => { now += dt; }, get now() { return now; } };
}

describe('ConversationAudioEngine', () => {
  test('no microphone sample reaches the ASR tap while capture is off', () => {
    const r = rig();
    r.fake.onFrame!(new Float32Array(512).fill(0.1), 1);
    expect(r.asr.readableRange()).toBeNull();
    r.engine.setCaptureEnabled(true);
    r.fake.onFrame!(new Float32Array(512).fill(0.1), 1.032);
    expect(r.asr.readableRange()).toEqual({ lower: 0, upper: 512 });
    r.engine.setCaptureEnabled(false);
    expect(r.calls).toContain('pump.stop');
  });

  test('the speech envelope is 5 ms blocks, released only as they would render, and cut by a flush', () => {
    const r = rig();
    // 100 ms of a -20 dBFS tone → 20 blocks at level 0.75.
    const tone = new Float32Array(4800).map((_, i) => Math.SQRT2 * 0.1 * Math.sin(i * 0.3));
    void r.engine.playout.enqueue(tone);
    const drained: [number, number][] = [];
    r.engine.drainSpeechLevels((l, t) => drained.push([l, t]));
    expect(drained.length).toBe(0); // it starts 20 ms from now
    r.advance(0.05);
    r.engine.drainSpeechLevels((l, t) => drained.push([l, t]));
    expect(drained.length).toBe(7); // the blocks up to one quantum ahead of now
    expect(drained[5][0]).toBeCloseTo(0.75, 1);
    expect(r.engine.speechLevel(r.now)).toBeCloseTo(0.75, 1);
    r.engine.flushPlayout();
    r.advance(1);
    r.engine.drainSpeechLevels((l, t) => drained.push([l, t]));
    expect(drained.length).toBeLessThan(20);
    expect(r.calls).toContain('flush');
  });

  test('a refused microphone leaves conversation mode output-only and ready', async () => {
    const r = rig(() => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })));
    r.engine.setConversationMode(true);
    expect(r.engine.isAudioReady).toBe(false);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(r.engine.isAudioReady).toBe(true);
    expect(r.engine.microphone).toBe('denied');
    r.engine.setConversationMode(false);
    r.engine.setConversationMode(true);
    expect(r.calls.filter((c) => c === 'startMic').length).toBe(1);
  });
});

describe('BabbleReplyClock', () => {
  test('a reply start counts only after the epoch was armed and once it is audible', () => {
    let now = 5;
    const director = { replyStartHostTime: 4.9 as number | null } as unknown as VoiceDirector;
    const clock = new BabbleReplyClock(director, () => now);
    clock.armReplyStart(3);
    expect(clock.playoutSnapshot().replyStart).toBeNull(); // started before arming
    (director as unknown as { replyStartHostTime: number }).replyStartHostTime = 5.2;
    expect(clock.playoutSnapshot().replyStart).toBeNull(); // not audible yet
    now = 5.25;
    expect(clock.playoutSnapshot().replyStart).toEqual({ epoch: 3, frame: 5200, hostTime: 5.2 });
  });
});

describe('StateContextPublisher', () => {
  test('"none" without a snapshot or with the mood note off; no people count without presence sharing', () => {
    const p = new StateContextPublisher();
    expect(p.sensor(true, true)).toBe('none');
    p.publish(makeConversationContextSnapshot({ feel: 'Happiness', moodLabel: 'playful', peopleCount: 2 }));
    expect(p.sensor(true, true)).toBe('Yanni feels happiness, mood lately playful; 2 people here');
    expect(p.sensor(true, false)).toBe('Yanni feels happiness, mood lately playful');
    expect(p.sensor(false, true)).toBe('none');
  });
});
